import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { ROOT, safeId } from "./lib.ts";

// read-only is all the pull needs; it can't send, delete or modify mail
const SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const SECRETS = join(ROOT, "..", "secrets");

/** One saved sign-in per inbox. The default account keeps the original file name. */
export const DEFAULT_ACCOUNT = "default";
const tokenFile = (account: string) => join(SECRETS, account === DEFAULT_ACCOUNT ? "gmail-token.json" : `gmail-token.${safeId(account)}.json`);

type Client = { client_id: string; client_secret: string; auth_uri: string; token_uri: string };
type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; error?: string; error_description?: string };

async function loadClient(): Promise<Client> {
  const file = (await readdir(SECRETS)).find((name) => name.startsWith("client_secret") && name.endsWith(".json"));
  if (!file) throw new Error("no client_secret_*.json found in secrets/");

  const json = JSON.parse(await readFile(join(SECRETS, file), "utf8")) as { installed?: Client };
  if (!json.installed) throw new Error("expected a Desktop app OAuth client (an `installed` section)");
  return json.installed;
}

async function requestToken(client: Client, params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(client.token_uri, {
    method: "POST",
    body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret, ...params }),
  });
  const body = (await response.json()) as TokenResponse;
  // report Google's error code only, never the response body, which can hold tokens
  if (!response.ok) throw new Error(`token request failed: ${body.error ?? response.status} ${body.error_description ?? ""}`.trim());
  return body;
}

/** One-time browser sign-in. Saves only the refresh token. */
export async function authorize(account = DEFAULT_ACCOUNT): Promise<void> {
  const client = await loadClient();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");

  const { code, redirectUri } = await new Promise<{ code: string; redirectUri: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("sign-in timed out after 3 minutes"));
    }, 180_000);

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }

      const code = url.searchParams.get("code");
      const ok = code !== null && url.searchParams.get("state") === state;
      res.writeHead(ok ? 200 : 400, { "content-type": "text/plain" }).end(ok ? "Signed in. You can close this tab." : "Sign-in failed.");
      server.close();
      clearTimeout(timer);

      if (ok) resolve({ code, redirectUri: `http://127.0.0.1:${port}` });
      else reject(new Error(url.searchParams.get("error") ?? "state mismatch"));
    });

    let port = 0;
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      const auth = new URL(client.auth_uri);
      auth.search = new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: `http://127.0.0.1:${port}`,
        response_type: "code",
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: "S256",
        state,
        access_type: "offline",
        prompt: "consent",
      }).toString();

      console.log(`opening browser to sign in (scope: ${SCOPE})\nif nothing opens, visit:\n${auth}`);
      execFile("open", [auth.toString()], () => {});
    });
  });

  const token = await requestToken(client, { grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier });
  if (!token.refresh_token) throw new Error("Google returned no refresh token; revoke the app's access and retry");

  const file = tokenFile(account);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ refresh_token: token.refresh_token, scope: SCOPE }), { mode: 0o600 });
  await chmod(file, 0o600);
  console.log(`signed in as account "${account}"; refresh token saved under secrets/`);
}

/** Short-lived access token from the saved refresh token. Kept in memory only. */
export async function getAccessToken(account = DEFAULT_ACCOUNT): Promise<string> {
  const saved = await readFile(tokenFile(account), "utf8").catch(() => {
    throw new Error(`account "${account}" is not signed in: run \`npm run emails:auth -- ${account}\` first`);
  });
  const { refresh_token } = JSON.parse(saved) as { refresh_token: string };
  return (await requestToken(await loadClient(), { grant_type: "refresh_token", refresh_token })).access_token;
}
