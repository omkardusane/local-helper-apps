import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const BATCHES = join(ROOT, "batches");
export const RUNS = join(ROOT, "runs");
export const isLaya = (model: string) => model.startsWith("laya");

/** Laya is steered by question text + threshold, chat models by a system prompt. */
export const skillPath = (model: string) => join(ROOT, isLaya(model) ? "classifier-skill.laya.md" : "classifier-skill.md");

export type Email = {
  id: string;
  from: string;
  subject: string;
  date: string;
  text: string;
};

export type Result = {
  emailId: string;
  important: boolean | null; // null = the model failed on this email
  reason: string;
  score?: number; // laya only: 0..1, important = score >= the skill's threshold
};

export type Verdict = "right" | "wrong" | "skip";
export type Rating = { verdict: Verdict; note: string };

export type RunMeta = { id: string; batch: string; model: string; createdAt: string; tag?: string }; // tag "recent" = started from the landing page, not a training round

export type Metrics = {
  rated: number;
  total: number;
  agreement: number;
  precision: number;
  recall: number;
  f1: number;
  auc: number | null; // threshold-free quality of the scores (laya only)
  tp: number;
  fp: number;
  fn: number;
  tn: number;
};

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

export function safeId(value: string): string {
  if (!/^[\w.-]+$/.test(value) || value.startsWith(".")) throw new Error(`invalid id: ${value}`);
  return value;
}

export async function readJson<T>(path: string, fallback?: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if (fallback !== undefined && (error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2));
}

/** "right" keeps the model's call, "wrong" flips it; skips and model failures don't count. */
export function computeMetrics(results: Result[], ratings: Record<string, Rating>): Metrics {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const positives: number[] = [];
  const negatives: number[] = [];

  for (const result of results) {
    const rating = ratings[result.emailId];
    if (result.important === null || !rating || rating.verdict === "skip") continue;

    const truth = rating.verdict === "right" ? result.important : !result.important;
    if (result.score !== undefined) (truth ? positives : negatives).push(result.score);
    if (result.important && truth) tp++;
    else if (result.important) fp++;
    else if (truth) fn++;
    else tn++;
  }

  const rated = tp + fp + fn + tn;
  const ratio = (a: number, b: number) => (b === 0 ? 0 : a / b);
  const precision = ratio(tp, tp + fp);
  const recall = ratio(tp, tp + fn);

  // AUC: chance a truly important email outscores a truly unimportant one (ties count half)
  let wins = 0;
  for (const p of positives) for (const n of negatives) wins += p > n ? 1 : p === n ? 0.5 : 0;
  const auc = positives.length && negatives.length ? wins / (positives.length * negatives.length) : null;

  return {
    rated,
    total: results.length,
    agreement: ratio(tp + tn, rated),
    precision,
    recall,
    f1: ratio(2 * precision * recall, precision + recall),
    auc,
    tp, fp, fn, tn,
  };
}
