// usage: npm run ui
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { authorize, DEFAULT_ACCOUNT, getAccessToken } from "./google-auth.ts";
import { knownSenders } from "./scan.ts";
import {
  accountOfBatch, addressOf, BATCHES, computeMetrics, type ContextRule, contextPath, type Email, lastPulls, loadContext, recordPull, type Rating, readJson, type Result, RUNS, type RunMeta, ROOT, safeId, skillPath, type UserContext, type Verdict, writeJson,
} from "./lib.ts";

const PORT = Number(process.env.EMAILS_PORT ?? 3100);
const VERDICTS: Verdict[] = ["right", "wrong", "skip"];
const SAMPLE_RIGHT = 10;
const ACCOUNT = process.env.GMAIL_ACCOUNT ?? DEFAULT_ACCOUNT;
const RECENT_DAYS = 3; // how far back the very first check looks
const RECENT_WINDOW_DAYS = 7; // how far back the summary looks
const RECENT_LIMIT = 200;
const RECENT_MODEL = process.env.OLLAMA_MODEL ?? "gemma4:12b"; // the model being tuned; laya is on hold

async function loadRun(id: string) {
  const dir = join(RUNS, safeId(id));
  const meta = await readJson<RunMeta>(join(dir, "meta.json"));
  const results = await readJson<Result[]>(join(dir, "results.json"), []);
  const ratings = await readJson<Record<string, Rating>>(join(dir, "ratings.json"), {});
  return { dir, meta, results, ratings };
}

/**
 * A rating says what an email is, so it counts for every run of the same batch. Runs inherit
 * verdicts from their siblings (translated against this run's own call); the run's own rating wins.
 * Inherited ratings are never written back to the run's ratings.json.
 */
async function loadShared(id: string) {
  const run = await loadRun(id);
  const ratings: Record<string, Rating> = { ...run.ratings };

  const others = (await readdir(RUNS)).filter((name) => !name.startsWith(".") && name !== run.meta.id).sort().reverse();
  for (const other of others) {
    const sibling = await loadRun(other).catch(() => null);
    if (!sibling || sibling.meta.batch !== run.meta.batch) continue;

    const calls = new Map(sibling.results.map((r) => [r.emailId, r.important]));
    for (const result of run.results) {
      const theirs = sibling.ratings[result.emailId];
      const call = calls.get(result.emailId);
      if (ratings[result.emailId] || result.important === null || !theirs || theirs.verdict === "skip" || call == null) continue;

      const truth = theirs.verdict === "right" ? call : !call;
      ratings[result.emailId] = { verdict: truth === result.important ? "right" : "wrong", note: theirs.note, inherited: true };
    }
  }
  return { ...run, ratings };
}

async function loadEmail(batch: string, emailId: string): Promise<Email> {
  return readJson<Email>(join(BATCHES, safeId(batch), "emails", `${safeId(emailId)}.json`));
}

const label = (important: boolean | null) => (important === null ? "error" : important ? "important" : "not important");
const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

async function buildReport(id: string): Promise<string> {
  const { dir, meta, results, ratings } = await loadShared(id);
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
      const { meta, results, ratings } = await loadShared(id);
      return { ...meta, metrics: computeMetrics(results, ratings) };
    }),
  );
  res.json(runs);
});

app.get("/api/runs/:id", async (req, res) => {
  const { meta, results, ratings } = await loadShared(req.params.id);
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

  const { dir, ratings } = await loadRun(req.params.id); // own ratings only: inherited ones are never persisted
  ratings[safeId(req.params.emailId)] = { verdict, note: typeof note === "string" ? note : "" };
  await writeJson(join(dir, "ratings.json"), ratings);

  const shared = await loadShared(req.params.id);
  res.json(computeMetrics(shared.results, shared.ratings));
});

app.get("/api/runs/:id/report", async (req, res) => {
  res.type("text/markdown").send(await buildReport(req.params.id));
});

/* ------------------------------------------------------------------ setup api */

const LABELS = ["important", "not important"];
const MAX_TEXT = 2000;

const nameOf = (from: string) => from.replace(/<[^>]*>/, "").replace(/["']/g, "").replace(/\s+via\s+\S+.*$/i, "").trim();

app.get("/api/batches", async (_req, res) => {
  const names = (await readdir(BATCHES).catch(() => [])).filter((name) => !name.startsWith("."));
  const batches = await Promise.all(
    names.map(async (name) => {
      const emails = await readdir(join(BATCHES, name, "emails")).catch(() => null);
      return emails ? { id: name, account: accountOfBatch(name), emails: emails.length } : null;
    }),
  );
  res.json(batches.filter(Boolean).sort((a, b) => a!.id.localeCompare(b!.id)));
});

/** Senders in a batch with several emails: the questions worth asking a new user. One answer covers every future mail. */
app.get("/api/setup/groups", async (req, res) => {
  const batch = safeId(String(req.query.batch ?? ""));
  const files = (await readdir(join(BATCHES, batch, "emails"))).filter((name) => name.endsWith(".json"));
  const emails = await Promise.all(files.map((file) => readJson<Email>(join(BATCHES, batch, "emails", file))));

  const groups = new Map<string, { address: string; names: Map<string, number>; subjects: string[]; count: number }>();
  for (const email of emails) {
    const address = addressOf(email.from);
    const group = groups.get(address) ?? { address, names: new Map<string, number>(), subjects: [] as string[], count: 0 };
    group.count++;
    const name = nameOf(email.from);
    if (name) group.names.set(name, (group.names.get(name) ?? 0) + 1);
    if (group.subjects.length < 3) group.subjects.push(email.subject);
    groups.set(address, group);
  }

  const repeated = [...groups.values()].filter((group) => group.count >= 2).sort((a, b) => b.count - a.count).slice(0, 30);
  const context = await loadContext(accountOfBatch(batch));

  res.json({
    batch,
    account: accountOfBatch(batch),
    totalEmails: emails.length,
    singles: emails.length - repeated.reduce((sum, group) => sum + group.count, 0),
    groups: repeated.map((group) => ({
      address: group.address,
      name: [...group.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "",
      count: group.count,
      subjects: group.subjects,
      rule: context.rules.find((rule) => rule.kind === "sender" && rule.value === group.address) ?? null,
    })),
  });
});

app.get("/api/context", async (req, res) => {
  res.json(await loadContext(safeId(String(req.query.account ?? ACCOUNT))));
});

app.put("/api/context", async (req, res) => {
  const account = safeId(String(req.query.account ?? ACCOUNT));
  const body = req.body as Partial<UserContext>;
  const rules = Array.isArray(body.rules) ? body.rules : [];

  const clean: UserContext = {
    about: typeof body.about === "string" ? body.about.slice(0, MAX_TEXT) : "",
    rules: rules
      .filter((rule): rule is ContextRule => rule && LABELS.includes(rule.label) && ["sender", "topic"].includes(rule.kind) && typeof rule.value === "string" && rule.value.trim() !== "")
      .map((rule) => ({
        kind: rule.kind,
        value: rule.value.trim().slice(0, 200),
        ...(rule.name ? { name: String(rule.name).slice(0, 100) } : {}),
        label: rule.label,
        ...(rule.note ? { note: String(rule.note).slice(0, 300) } : {}),
      })),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(contextPath(account), clean);
  res.json(clean);
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

type Job = {
  id: string;
  state: "pulling" | "classifying" | "done" | "error";
  progress: string;
  error?: string;
  runId?: string;
  alreadyHad?: number; // emails in the date range that were pulled before and skipped
  moreWaiting?: boolean; // the limit was reached and more new emails remain
};
const jobs = new Map<string, Job>();

/** Runs one of the cli scripts with this process's env (so .env settings apply) and resolves with its output. */
function runScript(script: string, args: string[], env: NodeJS.ProcessEnv, onOutput: (text: string) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", join(ROOT, script), ...args], {
      cwd: ROOT,
      // the account is passed explicitly: a variable already in the environment beats the child's .env file,
      // so the child can never end up reading a different inbox's sign-in than the page shows
      env: { ...process.env, GMAIL_ACCOUNT: ACCOUNT, ...env },
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; onOutput(String(chunk)); });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(output);
      // a crash prints the source line, then "Error: <message>", then a stack trace ending in the node version
      const lines = errors.split("\n").map((line) => line.trim()).filter(Boolean);
      const named = lines.find((line) => /^\w*Error:/.test(line));
      reject(new Error(named?.replace(/^\w*Error:\s*/, "") ?? lines.at(-1) ?? `${script} exited with ${code}`));
    });
  });
}

/** Local date as YYYY-MM-DD (the sv-SE locale prints that shape). */
const localDate = (when: Date) => when.toLocaleDateString("sv-SE");
const isDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const addDays = (date: string, days: number) => localDate(new Date(Date.parse(date) + days * 86_400_000));

/** Where the next check should start: the day of the last one (earlier days are done), or a few days back the first time. */
async function pullDefaults() {
  const last = (await lastPulls())[ACCOUNT]?.at;
  return { account: ACCOUNT, from: last ? localDate(new Date(last)) : addDays(localDate(new Date()), -RECENT_DAYS), lastPullAt: last ?? null };
}

async function classifyRecent(job: Job, model: string, from: string, until: string | undefined) {
  try {
    job.progress = "Looking for new emails…";
    const now = new Date();
    const stamp = `${localDate(now)}_${now.toTimeString().slice(0, 8).replaceAll(":", "")}_new`; // to the second, so two checks never share a batch
    const batchName = ACCOUNT === DEFAULT_ACCOUNT ? stamp : `${ACCOUNT}_${stamp}`;

    const pulled = await runScript("pull.ts", [from, String(RECENT_LIMIT), ...(until ? [until] : [])], { SKIP_KNOWN: "1", BATCH_NAME: batchName }, (text) => {
      const done = text.match(/(\d+)\/(\d+)(?!.*\d+\/\d+)/s);
      if (done) job.progress = `Fetching new emails… ${done[1]}/${done[2]}`;
    });
    job.alreadyHad = Number(pulled.match(/skipped (\d+) emails already pulled/)?.[1] ?? 0);
    job.moreWaiting = /more emails are waiting/.test(pulled);
    // only move the "checked up to here" date forward when everything in range was fetched
    if (!job.moreWaiting && !until) await recordPull(ACCOUNT);

    const saved = pulled.match(/saved (\d+) emails to batches\/(\S+)/);
    if (!saved || saved[1] === "0") {
      job.state = "done";
      job.progress = "No new emails since the last check.";
      return;
    }

    job.state = "classifying";
    job.progress = "Quick scan, then classifying…";
    await runScript("classify.ts", [saved[2], model], { RUN_TAG: "recent", QUICK_SCAN: "1" }, (text) => {
      const run = text.match(/^RUN (\S+)/m);
      if (run) job.runId = run[1];
    });
    job.state = "done";
    job.progress = "Done.";
  } catch (error) {
    job.state = "error";
    job.error = (error as Error).message;
  }
}

app.get("/api/pull-defaults", async (_req, res) => {
  res.json(await pullDefaults());
});

app.post("/api/classify-recent", async (req, res) => {
  const running = [...jobs.values()].find((job) => job.state === "pulling" || job.state === "classifying");
  if (running) {
    res.status(202).json(running);
    return;
  }

  const body = (req.body ?? {}) as { from?: unknown; to?: unknown };
  if ((body.from !== undefined && !isDate(body.from)) || (body.to !== undefined && body.to !== "" && !isDate(body.to))) {
    res.status(400).json({ error: "dates must look like 2026-10-23" });
    return;
  }
  const from = isDate(body.from) ? body.from : (await pullDefaults()).from;
  const to = isDate(body.to) ? body.to : undefined; // inclusive; gmail's `before:` is exclusive
  if (to && to < from) {
    res.status(400).json({ error: "the end date is before the start date" });
    return;
  }

  const job: Job = { id: String(Date.now()), state: "pulling", progress: "Starting…" };
  jobs.set(job.id, job);
  void classifyRecent(job, RECENT_MODEL, from, to && addDays(to, 1));
  res.status(202).json(job);
});

type ImportantEmail = { id: string; from: string; subject: string; date: string; score: number | null; reason: string };

async function importantItems(results: Result[], batchOf: (emailId: string) => string): Promise<ImportantEmail[]> {
  return Promise.all(
    results.filter((r) => r.important).map(async (r) => {
      const email = await loadEmail(batchOf(r.emailId), r.emailId);
      return { id: email.id, from: email.from, subject: email.subject, date: email.date, score: r.score ?? null, reason: r.reason };
    }),
  );
}

/** What is known about a run while it is still going: progress, speed, and the important emails found so far. */
async function liveStats(runId: string) {
  const { meta, results } = await loadRun(runId);
  const total = meta.total ?? results.length;
  const byCode = results.filter((r) => r.by === "rule").length;
  const timed = results.filter((r) => r.by !== "rule" && r.ms);
  const avgMs = timed.length ? timed.reduce((sum, r) => sum + (r.ms ?? 0), 0) / timed.length : null;
  const flagged = results.filter((r) => r.important);

  return {
    total,
    done: results.length,
    decidedByCode: byCode,
    flagged: flagged.length,
    etaSeconds: avgMs !== null && total > results.length ? Math.round(((total - results.length) * avgMs) / 1000) : null,
    important: (await importantItems(flagged.slice(-50), () => meta.batch)).reverse(), // newest first
  };
}

app.get("/api/jobs/:id", async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({ error: "unknown job" });
    return;
  }
  res.json({ ...job, live: job.runId ? await liveStats(job.runId).catch(() => null) : null });
});

/** Everything the landing-page checks of the last week found, across runs, newest run winning for each email. */
app.get("/api/recent", async (_req, res) => {
  const ids = (await readdir(RUNS).catch(() => [])).filter((name) => !name.startsWith(".")).sort().reverse();
  const results = new Map<string, Result>();
  const batchOf = new Map<string, string>();
  let runs = 0;
  let last: RunMeta | null = null;

  for (const id of ids) {
    const { meta, results: runResults } = await loadRun(id);
    if (meta.tag !== "recent" || accountOfBatch(meta.batch) !== ACCOUNT) continue;
    runs++;
    last ??= meta;
    for (const result of runResults) {
      if (results.has(result.emailId)) continue;
      results.set(result.emailId, result);
      batchOf.set(result.emailId, meta.batch);
    }
  }
  if (!last) {
    res.json(null);
    return;
  }

  const weekAgo = Date.now() - RECENT_WINDOW_DAYS * 86_400_000;
  const all = await importantItems([...results.values()].filter((r) => r.important), (emailId) => batchOf.get(emailId)!);
  const important = all.filter((item) => Date.parse(item.date) >= weekAgo).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const today = localDate(new Date());

  res.json({
    run: { id: last.id, model: last.model, createdAt: last.createdAt },
    runs,
    days: RECENT_WINDOW_DAYS,
    classified: [...results.values()].filter((r) => r.important !== null).length,
    decidedByCode: [...results.values()].filter((r) => r.by === "rule").length,
    flagged: important.length,
    todayCount: important.filter((item) => localDate(new Date(item.date)) === today).length,
    important: important.slice(0, 100),
  });
});

/** The senders the quick scan decides without the model, so the user can see exactly what is being skipped. */
app.get("/api/known-senders", async (_req, res) => {
  const known = [...(await knownSenders(ACCOUNT)).values()].sort((a, b) => b.count - a.count);
  res.json({ account: ACCOUNT, count: known.length, senders: known.slice(0, 100) });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal server error" });
});

app.listen(PORT, () => console.log(`email trainer on http://localhost:${PORT}`));
