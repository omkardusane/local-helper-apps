// The quick scan: senders we already know are not important are decided by code, before (and instead of) the model.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { accountOfBatch, addressOf, BATCHES, type Email, loadContext, readJson, type Rating, type Result, RUNS, type RunMeta, safeId } from "./lib.ts";

/** Rated emails needed before a sender can be called a sure-shot. One or two ratings are not enough to be sure. */
const MIN_RATED = 3;

export type KnownSender = { address: string; reason: string; source: "your rule" | "your ratings"; count: number };

/**
 * Senders whose mail never needs the model. It is deliberately conservative, because skipping a real email is the costly mistake:
 * a sender qualifies only when the user marked it "not important" themselves, or rated at least MIN_RATED of its emails
 * and none of them was important. A sender the user marked important is never skipped.
 */
export async function knownSenders(account: string): Promise<Map<string, KnownSender>> {
  const context = await loadContext(account);
  const protectedSenders = new Set(context.rules.filter((rule) => rule.kind === "sender" && rule.label === "important").map((rule) => rule.value.toLowerCase()));

  const known = new Map<string, KnownSender>();
  for (const rule of context.rules) {
    if (rule.kind !== "sender" || rule.label !== "not important") continue;
    const address = rule.value.toLowerCase();
    known.set(address, { address, reason: `you marked ${address} as not important`, source: "your rule", count: 0 });
  }

  // what the user's ratings say about each sender; the newest run's rating of an email wins
  const truth = new Map<string, { address: string; important: boolean }>();
  const runs = (await readdir(RUNS).catch(() => [])).filter((name) => !name.startsWith(".")).sort().reverse();
  for (const id of runs) {
    const meta = await readJson<RunMeta>(join(RUNS, safeId(id), "meta.json")).catch(() => null);
    if (!meta || accountOfBatch(meta.batch) !== account) continue;

    const results = await readJson<Result[]>(join(RUNS, id, "results.json"), []);
    const ratings = await readJson<Record<string, Rating>>(join(RUNS, id, "ratings.json"), {});
    for (const result of results) {
      const rating = ratings[result.emailId];
      if (!rating || rating.verdict === "skip" || result.important === null || truth.has(result.emailId)) continue;

      const email = await readJson<Email>(join(BATCHES, meta.batch, "emails", `${result.emailId}.json`)).catch(() => null);
      if (email) truth.set(result.emailId, { address: addressOf(email.from), important: rating.verdict === "right" ? result.important : !result.important });
    }
  }

  const perSender = new Map<string, { rated: number; important: number }>();
  for (const { address, important } of truth.values()) {
    const tally = perSender.get(address) ?? { rated: 0, important: 0 };
    tally.rated++;
    if (important) tally.important++;
    perSender.set(address, tally);
  }
  for (const [address, tally] of perSender) {
    if (tally.important > 0 || tally.rated < MIN_RATED || known.has(address)) continue;
    known.set(address, { address, reason: `you rated ${tally.rated} of its emails not important and none important`, source: "your ratings", count: tally.rated });
  }

  for (const address of protectedSenders) known.delete(address);
  return known;
}

/** The code-level decision for one email, or null when the model has to look at it. */
export function quickScan(email: Email, known: Map<string, KnownSender>): Result | null {
  const sender = known.get(addressOf(email.from));
  return sender ? { emailId: email.id, important: false, reason: `Known sender: ${sender.reason}`, by: "rule", ms: 0 } : null;
}
