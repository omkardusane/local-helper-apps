// usage: npm run emails:pull -- <since YYYY-MM-DD> [limit=100] [until YYYY-MM-DD]   (GMAIL_ACCOUNT=<name> picks the inbox; run `npm run emails:auth` once per inbox first)
import { existsSync } from "node:fs";
import { join } from "node:path";
import { BATCHES, type Email, writeJson } from "./lib.ts";
import { DEFAULT_ACCOUNT, getAccessToken } from "./google-auth.ts";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

type Part = { mimeType: string; body?: { data?: string }; parts?: Part[] };
type Message = { id: string; payload: Part & { headers: { name: string; value: string }[] } };

const since = process.argv[2];
const limit = Number(process.argv[3] ?? 100);
const until = process.argv[4]; // optional end date (exclusive), for batches that must not overlap
const account = process.env.GMAIL_ACCOUNT ?? DEFAULT_ACCOUNT; // which signed-in inbox to read

if (!since || Number.isNaN(Date.parse(since)) || (until && Number.isNaN(Date.parse(until)))) {
  console.error("usage: npm run emails:pull -- <since YYYY-MM-DD> [limit=100] [until YYYY-MM-DD]");
  process.exit(1);
}

const range = until ? `${since}_to_${until}_${limit}` : `${since}_${limit}`;
const batch = account === DEFAULT_ACCOUNT ? range : `${account}_${range}`;
const dir = join(BATCHES, batch);
if (existsSync(dir) && !process.env.PULL_REFRESH) {
  console.error(`batch ${batch} already exists; batches are frozen so rounds stay comparable (PULL_REFRESH=1 re-pulls into it)`);
  process.exit(1);
}

const token = await getAccessToken(account);

const RETRIES = 5;

/** Gmail reports rate limiting as 403 (sometimes 429) and has occasional 5xx; those are worth retrying. */
async function gmail<T>(path: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
    if (response.ok) return (await response.json()) as T;

    const body = (await response.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
    const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.message ?? "";
    const retryable = response.status === 429 || response.status >= 500 || /rateLimit|quota/i.test(reason);

    if (!retryable || attempt === RETRIES) throw new Error(`gmail ${response.status} ${reason} on ${path.split("?")[0]}`.replace("  ", " "));
    await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
  }
}

const decode = (data: string) => Buffer.from(data, "base64url").toString("utf8");
const stripHtml = (html: string) =>
  html.replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Prefers text/plain, falls back to tag-stripped text/html. */
function bodyText(part: Part): string {
  const find = (node: Part, type: string): string | undefined => {
    if (node.mimeType === type && node.body?.data) return decode(node.body.data);
    for (const child of node.parts ?? []) {
      const found = find(child, type);
      if (found) return found;
    }
  };

  const plain = find(part, "text/plain");
  if (plain) return plain.trim();
  const html = find(part, "text/html");
  return html ? stripHtml(html) : "";
}

// gmail's `after:` takes epoch seconds, which avoids timezone ambiguity
const query = new URLSearchParams({ q: `in:inbox after:${Math.floor(Date.parse(since) / 1000)}${until ? ` before:${Math.floor(Date.parse(until) / 1000)}` : ""}`, maxResults: String(Math.min(limit, 500)) });
const { messages = [] } = await gmail<{ messages?: { id: string }[] }>(`/messages?${query}`);

let saved = 0;
for (const { id } of messages.slice(0, limit)) {
  const message = await gmail<Message>(`/messages/${id}?format=full`);
  const header = (name: string) => message.payload.headers.find((h) => h.name.toLowerCase() === name)?.value ?? "";

  const email: Email = {
    id,
    from: header("from"),
    subject: header("subject") || "(no subject)",
    date: header("date") ? new Date(header("date")).toISOString() : "",
    text: bodyText(message.payload).slice(0, 20_000),
  };
  await writeJson(join(dir, "emails", `${id}.json`), email);
  process.stdout.write(`\r${++saved}/${Math.min(messages.length, limit)}`);
}

console.log(`\nsaved ${saved} emails to batches/${batch}`);
