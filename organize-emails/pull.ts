// usage: npm run emails:pull -- <since YYYY-MM-DD> [limit=100]
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { BATCHES, type Email, requireEnv, writeJson } from "./lib.ts";

const since = process.argv[2];
const limit = Number(process.argv[3] ?? 100);

if (!since || Number.isNaN(Date.parse(since))) {
  console.error("usage: npm run emails:pull -- <since YYYY-MM-DD> [limit=100]");
  process.exit(1);
}

const batch = `${since}_${limit}`;
const dir = join(BATCHES, batch);
if (existsSync(dir)) {
  console.error(`batch ${batch} already exists; batches are frozen so rounds stay comparable`);
  process.exit(1);
}

const client = new ImapFlow({
  host: "imap.gmail.com",
  port: 993,
  secure: true,
  auth: { user: requireEnv("GMAIL_USER"), pass: requireEnv("GMAIL_APP_PASSWORD") },
  logger: false,
});

await client.connect();
const lock = await client.getMailboxLock("INBOX");
let saved = 0;

try {
  const uids = (await client.search({ since: new Date(since) }, { uid: true })) || [];
  const newest = uids.slice(-limit);

  if (newest.length > 0) {
    for await (const message of client.fetch(newest, { source: true }, { uid: true })) {
      if (!message.source) continue;
      const parsed = await simpleParser(message.source);

      const email: Email = {
        id: String(message.uid),
        from: parsed.from?.text ?? "",
        subject: parsed.subject ?? "(no subject)",
        date: parsed.date?.toISOString() ?? "",
        text: (parsed.text ?? "").trim().slice(0, 20_000),
      };
      await writeJson(join(dir, "emails", `${email.id}.json`), email);
      saved++;
    }
  }
} finally {
  lock.release();
  await client.logout();
}

console.log(`saved ${saved} emails to batches/${batch}`);
