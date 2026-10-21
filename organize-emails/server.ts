// usage: npm run emails:ui
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { authorize, DEFAULT_ACCOUNT, getAccessToken } from "./google-auth.ts";
import {
  BATCHES, computeMetrics, type Email, type Rating, readJson, type Result, RUNS, type RunMeta, ROOT, safeId, skillPath, type Verdict, writeJson,
} from "./lib.ts";

const PORT = Number(process.env.EMAILS_PORT ?? 3100);
const VERDICTS: Verdict[] = ["right", "wrong", "skip"];
const SAMPLE_RIGHT = 10;
const ACCOUNT = process.env.GMAIL_ACCOUNT ?? DEFAULT_ACCOUNT;
const RECENT_DAYS = 3;
const RECENT_LIMIT = 200;
const RECENT_MODEL = "laya:421m-typed-decisions-bf16";
const REPO = join(ROOT, "..");

async function loadRun(id: string) {
  const dir = join(RUNS, safeId(id));
  const meta = await readJson<RunMeta>(join(dir, "meta.json"));
  const results = await readJson<Result[]>(join(dir, "results.json"), []);
  const ratings = await readJson<Record<string, Rating>>(join(dir, "ratings.json"), {});
  return { dir, meta, results, ratings };
}

async function loadEmail(batch: string, emailId: string): Promise<Email> {
  return readJson<Email>(join(BATCHES, safeId(batch), "emails", `${safeId(emailId)}.json`));
}

const label = (important: boolean | null) => (important === null ? "error" : important ? "important" : "not important");
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

async function buildReport(id: string): Promise<string> {
  const { dir, meta, results, ratings } = await loadRun(id);
  const skill = await readFile(join(dir, "skill.md"), "utf8");
  const m = computeMetrics(results, ratings);

  const describe = async (result: Result) => {
    const note = ratings[result.emailId]?.note;
    const why = result.score !== undefined ? `score ${result.score.toFixed(2)}` : result.reason;
    return `- ${result.emailId}: ${label(result.important)} (${why})${note ? ` | note: ${note}` : ""}`;
  };

  const wrong = results.filter((r) => ratings[r.emailId]?.verdict === "wrong");
  const right = results.filter((r) => ratings[r.emailId]?.verdict === "right").slice(0, SAMPLE_RIGHT);

  return [
    `# Classifier round ${meta.id} (model ${meta.model}, batch ${meta.batch})`,
    "",
    "Goal: improve the skill below so the model flags emails that deserve the user's attention.",
    "Study the failures and the successes, then return a full revised skill plus a short changelog.",
    `Email bodies are left out to keep this short: each id below is the file organize-emails/batches/${meta.batch}/emails/<id>.json`,
    "",
    "## Metrics (on the user's ratings; \"important\" is the positive class)",
    `rated ${m.rated}/${m.total} | agreement ${pct(m.agreement)} | precision ${pct(m.precision)} | recall ${pct(m.recall)} | F1 ${pct(m.f1)}${m.auc === null ? "" : ` | AUC ${pct(m.auc)}`}`,
    ...(m.auc === null ? [] : ["This is a score model: the skill has question texts plus a `## threshold`. Tune the wording to raise AUC, then the threshold to balance precision and recall (missing an important email is worse than a false alarm)."]),
    `TP ${m.tp} | FP ${m.fp} (flagged, not important) | FN ${m.fn} (missed important) | TN ${m.tn}`,
    "",
    "## Current skill",
    "```md",
    skill.trim(),
    "```",
    "",
    `## Wrong (${wrong.length})`,
    ...(await Promise.all(wrong.map(describe))),
    "",
    `## Right, sample (${right.length})`,
    ...(await Promise.all(right.map(describe))),
    "",
  ].join("\n");
}

const app = express();
app.use(express.json());

// This server can read mail and start jobs, so a page from another origin must not be able to drive it.
app.use((req, res, next) => {
  const origin = req.get("origin");
  const own = [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
  if (req.method !== "GET" && origin && !own.includes(origin)) {
    res.status(403).json({ error: "cross-origin request refused" });
    return;
  }
  next();
});
app.use(express.static(join(ROOT, "public")));

app.get("/api/runs", async (_req, res) => {
  const ids = (await readdir(RUNS).catch(() => [])).filter((name) => !name.startsWith("."));
  const runs = await Promise.all(
    ids.sort().reverse().map(async (id) => {
      const { meta, results, ratings } = await loadRun(id);
      return { ...meta, metrics: computeMetrics(results, ratings) };
    }),
  );
  res.json(runs);
});

app.get("/api/runs/:id", async (req, res) => {
  const { meta, results, ratings } = await loadRun(req.params.id);
  const items = await Promise.all(
    results.map(async (result) => ({ result, email: await loadEmail(meta.batch, result.emailId), rating: ratings[result.emailId] ?? null })),
  );
  res.json({ meta, items, metrics: computeMetrics(results, ratings) });
});

app.put("/api/runs/:id/ratings/:emailId", async (req, res) => {
  const { verdict, note } = req.body as Partial<Rating>;
  if (!verdict || !VERDICTS.includes(verdict)) {
    res.status(400).json({ error: `verdict must be one of ${VERDICTS.join(", ")}` });
    return;
  }

  const { dir, results, ratings } = await loadRun(req.params.id);
  ratings[safeId(req.params.emailId)] = { verdict, note: typeof note === "string" ? note : "" };
  await writeJson(join(dir, "ratings.json"), ratings);
  res.json(computeMetrics(results, ratings));
});

app.get("/api/runs/:id/report", async (req, res) => {
  res.type("text/markdown").send(await buildReport(req.params.id));
});

/* --------------------------------------------------------------- landing page api */

let signingIn = false;

app.get("/api/auth/status", async (_req, res) => {
  try {
    const token = await getAccessToken(ACCOUNT);
    const profile = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${token}` } });
    const email = profile.ok ? ((await profile.json()) as { emailAddress?: string }).emailAddress : undefined;
    res.json({ signedIn: true, account: ACCOUNT, email: email ?? null, signingIn });
  } catch {
    res.json({ signedIn: false, account: ACCOUNT, signingIn });
  }
});

/** Opens the Google consent page on this machine and resolves once the user finishes (or after 3 minutes). */
app.post("/api/auth/start", async (_req, res) => {
  if (signingIn) {
    res.status(409).json({ error: "a sign-in is already in progress" });
    return;
  }
  signingIn = true;
  try {
    await authorize(ACCOUNT);
    res.json({ ok: true });
  } finally {
    signingIn = false;
  }
});

app.get("/api/skill", async (_req, res) => {
  const read = (path: string) => readFile(path, "utf8");
  res.json({ laya: await read(skillPath("laya")), chat: await read(skillPath("chat")) });
});

type Job = { id: string; state: "pulling" | "classifying" | "done" | "error"; progress: string; error?: string };
const jobs = new Map<string, Job>();

/** Runs one of the cli scripts with this process's env (so .env settings apply) and resolves with its output. */
function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, onOutput: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--env-file=.env", join("organize-emails", script), ...args], { cwd: REPO, env: { ...process.env, ...env } });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; onOutput(String(chunk)); });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(output);
      // a crash prints a stack trace ending in the node version; the useful line is the one naming the error
      const lines = errors.split("\n").map((line) => line.trim()).filter(Boolean);
      reject(new Error(lines.find((line) => /error/i.test(line) && !line.startsWith("at ")) ?? lines.at(-1) ?? `${script} exited with ${code}`));
    });
  });
}

async function classifyRecent(job: Job, model: string) {
  try {
    const since = new Date(Date.now() - RECENT_DAYS * 86_400_000).toISOString().slice(0, 10);

    job.progress = `Pulling the last ${RECENT_DAYS} days from Gmail…`;
    const pulled = await runScript("pull.ts", [since, String(RECENT_LIMIT)], { PULL_REFRESH: "1" }, (text) => {
      const done = text.match(/(\d+)\/(\d+)(?!.*\d+\/\d+)/s);
      if (done) job.progress = `Pulling emails… ${done[1]}/${done[2]}`;
    });
    const batch = pulled.match(/saved (\d+) emails to batches\/(\S+)/);
    if (!batch || batch[1] === "0") {
      job.state = "done";
      job.progress = `No emails in the last ${RECENT_DAYS} days.`;
      return;
    }

    job.state = "classifying";
    job.progress = "Classifying…";
    await runScript("classify.ts", [batch[2], model], { RUN_TAG: "recent" }, (text) => {
      const done = text.match(/(\d+)\/(\d+)(?!.*\d+\/\d+)/s);
      if (done) job.progress = `Classifying… ${done[1]}/${done[2]}`;
    });
    job.state = "done";
    job.progress = "Done.";
  } catch (error) {
    job.state = "error";
    job.error = (error as Error).message;
  }
}

app.post("/api/classify-recent", (_req, res) => {
  const running = [...jobs.values()].find((job) => job.state === "pulling" || job.state === "classifying");
  if (running) {
    res.status(202).json(running);
    return;
  }
  const job: Job = { id: String(Date.now()), state: "pulling", progress: "Starting…" };
  jobs.set(job.id, job);
  void classifyRecent(job, RECENT_MODEL);
  res.status(202).json(job);
});

app.get("/api/jobs/:id", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "unknown job" });
    return;
  }
  res.json(job);
});

/** First version of the summary: important emails dated today, from the newest landing-page run. */
app.get("/api/recent", async (_req, res) => {
  const ids = (await readdir(RUNS).catch(() => [])).filter((name) => !name.startsWith(".")).sort().reverse();
  for (const id of ids) {
    const { meta, results } = await loadRun(id);
    if (meta.tag !== "recent") continue;

    const flagged = results.filter((r) => r.important);
    const emails = await Promise.all(flagged.map(async (r) => ({ result: r, email: await loadEmail(meta.batch, r.emailId) })));
    const today = new Date().toDateString();
    const todays = emails
      .filter(({ email }) => new Date(email.date).toDateString() === today)
      .sort((a, b) => (b.result.score ?? 0) - (a.result.score ?? 0));

    res.json({
      run: { id: meta.id, model: meta.model, createdAt: meta.createdAt },
      days: RECENT_DAYS,
      classified: results.filter((r) => r.important !== null).length,
      flagged: flagged.length,
      todayCount: todays.length,
      today: todays.slice(0, 10).map(({ email, result }) => ({ id: email.id, from: email.from, subject: email.subject, score: result.score ?? null })),
    });
    return;
  }
  res.json(null);
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal server error" });
});

app.listen(PORT, () => console.log(`email trainer on http://localhost:${PORT}`));
