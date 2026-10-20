// usage: npm run emails:ui
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import {
  BATCHES, computeMetrics, type Email, type Rating, readJson, type Result, RUNS, type RunMeta, ROOT, safeId, type Verdict, writeJson,
} from "./lib.ts";

const PORT = Number(process.env.EMAILS_PORT ?? 3100);
const VERDICTS: Verdict[] = ["right", "wrong", "skip"];
const SAMPLE_RIGHT = 10;

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
    const email = await loadEmail(meta.batch, result.emailId);
    const note = ratings[result.emailId]?.note;
    return [
      `### ${email.subject}`,
      `From: ${email.from}`,
      `Model said: ${label(result.important)} (${result.score !== undefined ? `score ${result.score.toFixed(2)}` : result.reason})`,
      note ? `User note: ${note}` : "",
      "```",
      email.text.slice(0, 600),
      "```",
    ].filter(Boolean).join("\n");
  };

  const wrong = results.filter((r) => ratings[r.emailId]?.verdict === "wrong");
  const right = results.filter((r) => ratings[r.emailId]?.verdict === "right").slice(0, SAMPLE_RIGHT);

  return [
    `# Classifier round ${meta.id} (model ${meta.model}, batch ${meta.batch})`,
    "",
    "Goal: improve the skill below so the model flags emails that deserve the user's attention.",
    "Study the failures and the successes, then return a full revised skill plus a short changelog.",
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

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: err instanceof Error ? err.message : "internal server error" });
});

app.listen(PORT, () => console.log(`email trainer on http://localhost:${PORT}`));
