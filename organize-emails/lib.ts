import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));

/**
 * Where the user's data lives: pulled mail, runs and ratings, saved contexts, sign-in tokens.
 * The packaged app sets EMAIL_ORGANIZER_DATA to the user's own app-data folder; in development it is
 * unset and everything stays next to the code, as before. Code assets (skills, web pages) always ship with the app.
 */
const DATA = process.env.EMAIL_ORGANIZER_DATA;
export const BATCHES = join(DATA ?? ROOT, "batches");
export const RUNS = join(DATA ?? ROOT, "runs");
export const TOKENS = DATA ? join(DATA, "secrets") : join(ROOT, "secrets");
/** The Google OAuth client file ships with the app; it is not user data. */
export const CLIENT_DIR = process.env.EMAIL_ORGANIZER_CLIENT_DIR ?? TOKENS;
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
  ms?: number; // how long the model took on this email
};

/** What the user told the system about themselves. Kept apart from the skill, which is the same for everyone. */
export type ContextRule = { kind: "sender" | "topic"; value: string; name?: string; label: "important" | "not important"; note?: string };
export type UserContext = { about: string; rules: ContextRule[]; updatedAt?: string };

export const CONTEXTS = join(DATA ?? ROOT, "contexts");
export const DEFAULT_ACCOUNT_NAME = "default";

/** Batches pulled for a named account are prefixed `<account>_`; older batches belong to the default account. */
export function accountOfBatch(batch: string): string {
  const prefix = batch.match(/^([a-z][\w-]*)_\d{4}-/i)?.[1];
  return prefix ?? DEFAULT_ACCOUNT_NAME;
}

export const contextPath = (account: string) => join(CONTEXTS, `${safeId(account)}.json`);

export async function loadContext(account: string): Promise<UserContext> {
  return readJson<UserContext>(contextPath(account), { about: "", rules: [] });
}

/** The "about this user" text appended to the skill; empty when the user hasn't said anything yet. */
export function renderContext(context: UserContext): string {
  const lines: string[] = [];
  if (context.about.trim()) lines.push(`About this user:\n${context.about.trim()}`);

  if (context.rules.length > 0) {
    lines.push(
      [
        "The user's own preferences. They override the general rules above:",
        ...context.rules.map((rule) => {
          const who = rule.kind === "sender" ? `Emails from ${rule.name ? `${rule.name} (${rule.value})` : rule.value}` : rule.value;
          return `- ${who}: ${rule.label}${rule.note ? ` (${rule.note})` : ""}`;
        }),
      ].join("\n"),
    );
  }
  return lines.join("\n\n");
}

export type Verdict = "right" | "wrong" | "skip";
export type Rating = { verdict: Verdict; note: string; inherited?: boolean }; // inherited: taken from another run of the same batch

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

/** Opens a page in the user's default browser, on macOS, Windows or Linux. */
export function openUrl(url: string): void {
  const [command, args] =
    platform() === "darwin" ? ["open", [url]] : platform() === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  execFile(command as string, args as string[], () => {}); // if it fails the url is printed anyway
}

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
