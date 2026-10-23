// usage: npm run classify -- <batch-id> [model]   (model defaults to OLLAMA_MODEL)
// QUICK_SCAN=1 lets code decide emails from known not-important senders before the model runs (the landing page does this;
// training runs leave it off so the model is scored on every email); RUN_TAG=recent marks a run started from the landing page.
import { copyFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ollama from "ollama";
import { knownSenders, quickScan } from "./scan.ts";
import { accountOfBatch, BATCHES, type Email, isLaya, loadContext, readJson, renderContext, type Result, RUNS, type RunMeta, safeId, skillPath, writeJson } from "./lib.ts";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const CHAT_BODY_CHARS = 2000;
const LAYA_BODY_CHARS = 1200; // laya's context is 1024 tokens

const batch = process.argv[2];
const model = process.argv[3] ?? process.env.OLLAMA_MODEL ?? "gemma4:12b";
if (!batch) {
  console.error("usage: npm run classify -- <batch-id> [model]");
  process.exit(1);
}

const files = (await readdir(join(BATCHES, safeId(batch), "emails"))).filter((name) => name.endsWith(".json"));
const skill = await readFile(skillPath(model), "utf8");

const id = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(RUNS, id);
const meta: RunMeta = {
  id,
  batch,
  model,
  createdAt: new Date().toISOString(),
  total: files.length,
  ...(process.env.QUICK_SCAN && { quickScan: true }),
  ...(process.env.RUN_TAG && { tag: process.env.RUN_TAG }),
};
await writeJson(join(runDir, "meta.json"), meta);
console.log(`RUN ${id}`);
await copyFile(skillPath(model), join(runDir, "skill.md"));

// The skill is the same for everyone; what the user told us about themselves is appended at run time.
// Laya is steered by its question text only, so it ignores the context.
const context = await loadContext(accountOfBatch(batch));
const contextText = isLaya(model) ? "" : renderContext(context);
const system = [skill.trim(), contextText].filter(Boolean).join("\n\n");
if (contextText) {
  await writeJson(join(runDir, "context.json"), context);
  await writeFile(join(runDir, "prompt.md"), system + "\n");
}

const describe = (email: Email, chars: number) =>
  `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.text.slice(0, chars)}`;

/* ------------------------------------------------------------------ chat models */

const RETRIES = 3;

/** ollama can drop a connection while loading or swapping a model; a short wait and retry fixes most of it. */
async function chatRequest(body: string): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${OLLAMA_URL}/api/chat`, { method: "POST", body });
      if (response.status < 500 || attempt === RETRIES) return response;
    } catch (error) {
      if (attempt === RETRIES) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000 * attempt));
  }
}

async function classifyChat(email: Email): Promise<Result> {
  const response = await chatRequest(
    JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0 },
      format: {
        type: "object",
        properties: { important: { type: "boolean" }, reason: { type: "string" } },
        required: ["important", "reason"],
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: describe(email, CHAT_BODY_CHARS) },
      ],
    }),
  );
  if (!response.ok) throw new Error(`ollama ${response.status}: ${await response.text()}`);

  const body = (await response.json()) as { message: { content: string } };
  const parsed = JSON.parse(body.message.content) as { important: boolean; reason: string };
  return { emailId: email.id, important: Boolean(parsed.important), reason: String(parsed.reason ?? "") };
}

/* ------------------------------------------------------------------------- laya */

/** The laya skill is markdown with `## instructions`, `## true`, `## false` and `## threshold` sections. */
function parseLayaSkill(markdown: string) {
  const sections: Record<string, string> = {};
  for (const part of markdown.split(/^## /m).slice(1)) {
    const [name, ...body] = part.split("\n");
    sections[name.trim().toLowerCase()] = body.join("\n").trim();
  }

  for (const key of ["instructions", "true", "false", "threshold"]) {
    if (!sections[key]) throw new Error(`laya skill is missing a "## ${key}" section`);
  }
  const threshold = Number(sections.threshold);
  if (!(threshold >= 0 && threshold <= 1)) throw new Error("## threshold must be a number between 0 and 1");

  return { instructions: sections.instructions, criteria: { true: sections.true, false: sections.false }, threshold };
}

const laya = isLaya(model) ? parseLayaSkill(skill) : null;

async function classifyLaya(email: Email, chars = LAYA_BODY_CHARS): Promise<Result> {
  const { threshold, ...question } = laya!;
  let response;
  try {
    // `systemone` is laya's API; it isn't in the client's typings
    response = await (ollama as any).systemone({
      model,
      state: describe(email, chars),
      questions: { important: { type: "noul", ...question } },
    });
  } catch (error) {
    // dense text (emoji, non-latin) can overflow the 1024-token context even when short in characters
    if (/context length/i.test((error as Error).message) && chars > 200) return classifyLaya(email, Math.floor(chars / 2));
    throw error;
  }

  const score = Number(response.answers.important.noul);
  if (Number.isNaN(score)) throw new Error(`unexpected laya response: ${JSON.stringify(response)}`);
  return { emailId: email.id, important: score >= threshold, reason: "", score };
}

/* -------------------------------------------------------------------------- run */

const emails = await Promise.all(files.map((file) => readJson<Email>(join(BATCHES, batch, "emails", file))));
const known = process.env.QUICK_SCAN ? await knownSenders(accountOfBatch(batch)) : new Map();

// quick scan: known senders are decided by code, instantly, and shown before the model starts
const results: Result[] = [];
const pending: Email[] = [];
for (const email of emails) {
  const decided = quickScan(email, known);
  if (decided) results.push(decided);
  else pending.push(email);
}
if (known.size) console.log(`QUICKSCAN ${results.length}/${emails.length} decided by code (${known.size} known senders)`);
await writeJson(join(runDir, "results.json"), results);

// results are rewritten after every email so the page can show progress while the run is still going
for (const email of pending) {
  const started = performance.now();
  try {
    results.push({ ...(await (laya ? classifyLaya(email) : classifyChat(email))), ms: Math.round(performance.now() - started) });
  } catch (error) {
    results.push({ emailId: email.id, important: null, reason: `ERROR: ${(error as Error).message}`, ms: Math.round(performance.now() - started) });
  }
  await writeJson(join(runDir, "results.json"), results);
  process.stdout.write(`\r${results.length}/${emails.length}`);
}

await writeJson(join(runDir, "results.json"), results);
const failed = results.filter((r) => r.important === null).length;
const timed = results.filter((r) => r.important !== null && r.by !== "rule").map((r) => r.ms ?? 0);
console.log(`\nrun ${id} (${model}) done, ${failed} errors, ${timed.length ? (timed.reduce((a, b) => a + b, 0) / timed.length / 1000).toFixed(1) : 0}s per email`);
if (failed > results.length * 0.05) {
  console.warn(`WARNING: ${failed}/${results.length} emails failed (${results.find((r) => r.important === null)?.reason}).`);
  console.warn("Failed emails are not rated or scored. Check that ollama is up, then rerun this batch.");
}
console.log("rate it: npm run ui");
