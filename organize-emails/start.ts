// usage: npm start
// For testers who cloned the repo: checks everything the app needs, then starts it and opens the browser.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

// lib.ts reads the data-folder setting when it loads, so nothing here may import it until that setting is made (see step 6).
const APP = dirname(fileURLToPath(import.meta.url));
const CLIENT_DIR = process.env.EMAIL_ORGANIZER_CLIENT_DIR ?? join(APP, "secrets");
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL ?? "gemma4:12b";
const PORT = Number(process.env.EMAILS_PORT ?? 3100);

const step = (text: string) => console.log(`\n• ${text}`);
function stop(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

/** Where a tester's mail, ratings and sign-in live: outside the clone, so updating the code never touches them. */
function dataDir(): string {
  if (process.env.EMAIL_ORGANIZER_DATA) return process.env.EMAIL_ORGANIZER_DATA;
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Email Organizer");
  if (platform() === "win32") return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Email Organizer");
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "email-organizer");
}

/* 1. node */
step("Checking Node.js");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) stop(`Node ${process.versions.node} is too old. Install Node 22.18 or newer from https://nodejs.org`);

/* 2. dependencies */
if (!existsSync(join(APP, "node_modules"))) {
  step("Installing dependencies (first run only)");
  const install = spawnSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: APP, stdio: "inherit", shell: platform() === "win32" });
  if (install.status !== 0) stop("npm install failed");
}

/* 3. ollama */
step("Checking Ollama");
const tags = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) })
  .then((response) => (response.ok ? (response.json() as Promise<{ models: { name: string }[] }>) : null))
  .catch(() => null);
if (!tags) stop(`Ollama isn't running. Install it from https://ollama.com/download, open it, then run this again.`);

/* 4. model */
step(`Checking the ${MODEL} model`);
if (tags.models.some((model) => model.name === MODEL || model.name === `${MODEL}:latest`)) {
  console.log("  already downloaded");
} else {
  console.log("  downloading (this is several GB and happens once)");
  const response = await fetch(`${OLLAMA_URL}/api/pull`, { method: "POST", body: JSON.stringify({ model: MODEL, stream: true }) });
  if (!response.ok || !response.body) stop(`Could not download ${MODEL}: ${await response.text()}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let last = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines.filter(Boolean)) {
      const update = JSON.parse(line) as { status?: string; total?: number; completed?: number; error?: string };
      if (update.error) stop(`Download failed: ${update.error}`);
      const text = update.total ? `${update.status} ${Math.round(((update.completed ?? 0) / update.total) * 100)}%` : (update.status ?? "");
      if (text !== last) process.stdout.write(`\r  ${text.padEnd(60)}`);
      last = text;
    }
  }
  console.log("\n  done");
}

/* 5. google client */
step("Checking the Google sign-in file");
const hasClient = existsSync(CLIENT_DIR) && readdirSync(CLIENT_DIR).some((name) => name.startsWith("client_secret") && name.endsWith(".json"));
if (!hasClient) {
  stop(`Missing the Google sign-in file.\n  Ask the project owner for the client_secret_*.json file and put it in:\n  ${CLIENT_DIR}`);
}

/* 6. start */
const data = dataDir();
mkdirSync(data, { recursive: true });
process.env.EMAIL_ORGANIZER_DATA = data;
process.env.EMAIL_ORGANIZER_CLIENT_DIR = CLIENT_DIR;
process.env.OLLAMA_MODEL = MODEL;

step("Starting the app");
console.log(`  your data is kept in ${data}`);
await import("./server.ts"); // listens on import

const url = `http://localhost:${PORT}/`;
const { openUrl } = await import("./lib.ts");
setTimeout(() => {
  console.log(`\n✓ Ready: ${url}  (leave this window open; press Ctrl+C to stop)`);
  if (!process.env.NO_OPEN) openUrl(url);
}, 800);
