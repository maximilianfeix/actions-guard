/**
 * `actions-guard setup`: registers a GitHub App from a manifest (GitHub's "create an app in one click" flow)
 * and saves what GitHub hands back. A local page posts the manifest to GitHub; after the user confirms, GitHub
 * redirects back with a one-time code, which is exchanged for the app's ID, webhook secret and private key.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { DOCS_URL } from "./report.js";

export interface SetupOptions {
  name?: string;
  webhookUrl?: string;
  org?: string;
  port?: number;
  /** where .env and the key go (default: the current directory) */
  dir?: string;
  fetch?: typeof globalThis.fetch;
  log?(message: string): void;
  open?(url: string): void;
}

export interface Conversion {
  id: number;
  slug: string;
  html_url: string;
  pem: string;
  webhook_secret: string;
}

export function appManifest({ name, webhookUrl, port }: { name: string; webhookUrl?: string; port: number }) {
  return {
    name,
    url: DOCS_URL,
    description:
      "Reviews pull requests that change GitHub Actions workflows and flags the security risks they add.",
    // GitHub wants a URL even for an inactive webhook; set the real one once the app is deployed
    hook_attributes: {
      url: webhookUrl ?? "https://example.com/actions-guard-webhook",
      active: Boolean(webhookUrl),
    },
    redirect_url: `http://127.0.0.1:${port}/callback`,
    public: true,
    default_permissions: { checks: "write", contents: "read", pull_requests: "write", metadata: "read" },
    default_events: ["pull_request"],
  };
}

export function setupPage(manifest: object, state: string, org?: string): string {
  const target = org
    ? `https://github.com/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  return `<!doctype html>
<meta charset="utf-8">
<title>Actions Guard setup</title>
<form method="post" action="${target}?state=${state}">
  <input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
  <p>Register your Actions Guard GitHub App – you'll confirm the name on GitHub.</p>
  <button type="submit">Create the GitHub App</button>
</form>
<script>document.forms[0].submit()</script>
`;
}

export async function exchangeCode(
  code: string,
  fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<Conversion> {
  const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: { accept: "application/vnd.github+json", "user-agent": "actions-guard" },
  });
  const data = (await res.json()) as Conversion & { message?: string };
  if (!res.ok) throw new Error(`GitHub answered ${res.status}: ${data.message ?? "no message"}`);
  return data;
}

export function writeCredentials(dir: string, app: Conversion): { envPath: string; keyPath: string } {
  const envPath = join(dir, ".env");
  if (existsSync(envPath))
    throw new Error(`${envPath}: .env already exists – move it away and run setup again`);
  const keyName = `${app.slug}.private-key.pem`;
  const keyPath = join(dir, keyName);
  writeFileSync(keyPath, app.pem, { mode: 0o600 });
  writeFileSync(
    envPath,
    `APP_ID=${app.id}\nWEBHOOK_SECRET=${app.webhook_secret}\nPRIVATE_KEY_PATH=./${keyName}\n`,
    { mode: 0o600 },
  );
  return { envPath, keyPath };
}

export function runSetup(options: SetupOptions = {}): Promise<void> {
  const log = options.log ?? console.log;
  const open = options.open ?? openBrowser;
  const dir = options.dir ?? process.cwd();
  const state = randomBytes(16).toString("hex");

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const send = (status: number, body: string) => {
        res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        res.end(body);
      };
      if (url.pathname === "/") {
        const manifest = appManifest({
          name: options.name ?? "Actions Guard",
          webhookUrl: options.webhookUrl,
          port: (server.address() as AddressInfo).port,
        });
        return send(200, setupPage(manifest, state, options.org));
      }
      if (url.pathname !== "/callback") return send(404, "not found");
      // the state proves the redirect answers the page this run served, not someone else's request
      if (url.searchParams.get("state") !== state)
        return send(400, "State doesn't match – start setup again.");

      exchangeCode(url.searchParams.get("code") ?? "", options.fetch)
        .then((app) => {
          const { envPath } = writeCredentials(dir, app);
          const install = `${app.html_url}/installations/new`;
          send(
            200,
            `<p>Done – your app <b>${escapeHtml(app.slug)}</b> is registered.</p>` +
              `<p><a href="${escapeHtml(install)}">Install it on your repositories: ${escapeHtml(install)}</a></p>`,
          );
          log(`Saved the app's credentials to ${envPath}. Install it: ${install}`);
          server.close();
          resolve();
        })
        .catch((error: unknown) => {
          send(500, `Setup failed: ${escapeHtml(String(error))}`);
          server.close();
          reject(error);
        });
    });
    server.listen(options.port ?? 3000, "127.0.0.1", () => {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      log(`Opening ${url} – confirm the new app on GitHub.`);
      open(url);
    });
  });
}

/* v8 ignore start – starts the user's browser */
function openBrowser(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(command, [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}
/* v8 ignore stop */

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
