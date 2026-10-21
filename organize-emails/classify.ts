// usage: npm run emails:classify -- <batch-id> [model]   (model defaults to OLLAMA_MODEL)
import { copyFile, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ollama from "ollama";
import { BATCHES, type Email, isLaya, readJson, type Result, RUNS, type RunMeta, safeId, skillPath, writeJson } from "./lib.ts";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const CHAT_BODY_CHARS = 2000;
const LAYA_BODY_CHARS = 1200; // laya's context is 1024 tokens

const batch = process.argv[2];
const model = process.argv[3] ?? process.env.OLLAMA_MODEL ?? "gemma4:12b";
if (!batch) {
  console.error("usage: npm run emails:classify -- <batch-id> [model]");
  process.exit(1);
}

const files = (await readdir(join(BATCHES, safeId(batch), "emails"))).filter((name) => name.endsWith(".json"));
const skill = await readFile(skillPath(model), "utf8");

const id = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = join(RUNS, id);
const meta: RunMeta = { id, batch, model, createdAt: new Date().toISOString(), ...(process.env.RUN_TAG && { tag: process.env.RUN_TAG }) };
await writeJson(join(runDir, "meta.json"), meta);
await copyFile(skillPath(model), join(runDir, "skill.md"));

const describe = (email: Email, chars: number) =>
  `From: ${email.from}\nSubject: ${email.subject}\nDate: ${email.date}\n\n${email.text.slice(0, chars)}`;

/* ------------------------------------------------------------------ chat models */

async function classifyChat(email: Email): Promise<Result> {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      model,
      stream: false,
      options: { temperature: 0 },
      format: {
        type: "object",
        properties: { important: { type: "boolean" }, reason: { type: "string" } },
        required: ["important", "reason"],
      },
      messages: [
        { role: "system", content: skill },
        { role: "user", content: describe(email, CHAT_BODY_CHARS) },
      ],
    }),
  });
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

const results: Result[] = [];
for (const [index, file] of files.entries()) {
  const email = await readJson<Email>(join(BATCHES, batch, "emails", file));
  try {
    results.push(await (laya ? classifyLaya(email) : classifyChat(email)));
  } catch (error) {
    results.push({ emailId: email.id, important: null, reason: `ERROR: ${(error as Error).message}` });
  }
  process.stdout.write(`\r${index + 1}/${files.length}`);
}

await writeJson(join(runDir, "results.json"), results);
const failed = results.filter((r) => r.important === null).length;
console.log(`\nrun ${id} (${model}) done, ${failed} errors`);
if (failed > results.length * 0.05) {
  console.warn(`WARNING: ${failed}/${results.length} emails failed (${results.find((r) => r.important === null)?.reason}).`);
  console.warn("Failed emails are not rated or scored. Check that ollama is up, then rerun this batch.");
}
console.log("rate it: npm run emails:ui");
