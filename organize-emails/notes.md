# Design notes

Ideas and decisions that aren't code yet. Newest thinking first.

## Direction: a tunable system, not a generic skill

We are not trying to build a skill that works out of the box for everyone. The goal is a system that gets tuned to one user's attention through the eval loop, and keeps adapting.

Evidence from round 1 → 2 (Laya, batch 2026-10-10_100): judging by **sender** ("a service I rely on") made marketing from known brands look important (AUC 0.65). Judging by **message type** (account event, reply, mention vs. bulk marketing) reached AUC 0.97. Sender still matters, but per user: the user has no paid plan with HDFC Life or Adobe, so their mail is noise for them, while another user's HDFC mail may matter.

## Per-user runtime memory (planned)

The base skill stays small and asks the runtime to supply a per-user memory:

- **Sender knowledge:** weight by sender or domain, learned from the user's ratings. Examples: `reddit.com` replies are important, `engage.*` marketing hosts are not.
- **Uncertain senders:** the system surfaces a few emails from senders it can't place (no ratings, mixed scores) and asks the user to classify them, so one answer covers every future mail from that sender.
- **Whitelist:** the user names senders or topics that are exceptionally important to them (a landlord, a school, a client). These override the model's score.
- **Blacklist/mute:** the same for senders that are always noise.
- Combine with the model score at decision time: whitelist/mute rules first, then sender weight, then Laya/gemma score vs. threshold. The eval loop measures the combination, not the model alone.

Open questions: how much sender weight is fair before it hides a genuinely new important sender (new sender with no history should fall back to the model score), and how to expire stale rules.

## Packaging

Today: local desktop app (Node + Ollama on the user's machine). Later: a Chrome extension and/or a web app.

The per-user config (skill text per model, threshold, sender weights, whitelist/mute, rating history) should live somewhere shared across those front ends. The local `rememberane` Mongo server in this repo can store this LLM-local-app config, and the apps read it over its API. Until then the files in `runs/` and the skill files stay the source of truth. See [readme.md](../readme.md) / `rememberane/` for the API.

## Backlog

- **Multiple inboxes:** `GMAIL_ACCOUNT=<name>` picks a saved sign-in (`secrets/gmail-token.<name>.json`). The first attempt failed because the second account had been signed in as `default`, which overwrote the first inbox's token. I renamed that token to `gmail-token.second.json` and its batch to `second_2026-08-10_100`, so `GMAIL_ACCOUNT=second` should now work. The first inbox needs `npm run emails:auth` again. Not verified, and `emails:auth` should refuse to overwrite an existing token without confirmation. Parked.
- The second inbox's 100 emails only span 2026-10-19 to 2026-10-21 (busy inbox, limit reached), so `since` isn't the real start date. Page through or raise the limit when we come back to it.

## Decisions so far

- Files, not Mongo, for runs and ratings while the loop is still changing (revisit when cross-run analysis is needed).
- The user rates every email in a batch; no LLM judge. Skipped = unknown, not right.
- Laya is tuned toward gemma4's behavior, with the user's ratings as truth. gemma4:12b is the reference model.
- Tune on one batch, confirm on a held-out batch (2026-09-26_to_2026-10-10_100) that wording and threshold never saw.
- Laya skill that worked best: short example phrases in `## true` and `## false`, not prose.
