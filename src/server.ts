/** Running the app: settings from the environment, a Node HTTP server, and a fetch handler for serverless hosts. */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { appApiFactory } from "./github.js";
import { handleWebhook, type WebhookDeps } from "./webhook.js";

const MAX_BODY = 5 * 1024 * 1024; // GitHub caps webhook payloads at 25 MB; pull_request events are far smaller
const STATUS = "Actions Guard is running. GitHub sends its webhooks here.";

export interface Env {
  appId: number;
  privateKey: string;
  webhookSecret: string;
  port: number;
}

type ReadFile = (path: string, encoding: "utf8") => string;

export function loadEnv(env: Record<string, string | undefined>, readFile: ReadFile = readFileSync): Env {
  const problems: string[] = [];
  const appId = Number(env.APP_ID);
  if (!Number.isInteger(appId) || appId <= 0) problems.push("APP_ID");
  const privateKey = env.PRIVATE_KEY
    ? env.PRIVATE_KEY.replace(/\\n/g, "\n") // hosting dashboards often keep the PEM on one line
    : env.PRIVATE_KEY_PATH
      ? readFile(env.PRIVATE_KEY_PATH, "utf8")
      : "";
  if (!privateKey) problems.push("PRIVATE_KEY or PRIVATE_KEY_PATH");
  if (!env.WEBHOOK_SECRET) problems.push("WEBHOOK_SECRET");
  if (problems.length > 0) throw new Error(`Missing or invalid: ${problems.join(", ")}`);
  return { appId, privateKey, webhookSecret: env.WEBHOOK_SECRET!, port: env.PORT ? Number(env.PORT) : 3000 };
}

export function depsFromEnv(env: Env, log: (message: string) => void = console.log): WebhookDeps {
  return {
    secret: env.webhookSecret,
    apiFor: appApiFactory({ appId: env.appId, privateKey: env.privateKey }),
    log,
  };
}

/** For hosts that speak the Fetch API (Vercel, Netlify, Deno, Bun, Cloudflare with nodejs_compat). */
export async function fetchHandler(request: Request, deps: WebhookDeps): Promise<Response> {
  if (request.method === "GET") return new Response(STATUS);
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  const result = await handleWebhook(
    { headers: Object.fromEntries(request.headers), body: await request.text() },
    deps,
  );
  return new Response(result.body, { status: result.status });
}

export function createWebhookServer(deps: WebhookDeps): Server {
  return createServer((req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
    };
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/" || path === "/healthz" || path === "/api/webhook")) {
      return reply(200, STATUS);
    }
    if (req.method !== "POST" || (path !== "/" && path !== "/api/webhook")) return reply(404, "not found");

    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooBig) return reply(413, "payload too large");
      const headers = Object.fromEntries(
        Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v]),
      );
      handleWebhook({ headers, body: Buffer.concat(chunks).toString("utf8") }, deps).then(
        (result) => reply(result.status, result.body),
        /* v8 ignore next */ (error: unknown) => reply(500, String(error)),
      );
    });
  });
}

export function start(
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.log,
): Server {
  const settings = loadEnv(env);
  const server = createWebhookServer(depsFromEnv(settings, log));
  server.listen(settings.port, () => log(`Actions Guard listening on :${settings.port}`));
  return server;
}

/**
 * A fetch handler that reads its settings on the first request and remembers them. Missing settings are
 * answered with a 500 that names them – on a serverless host that beats a crash with no explanation.
 */
export function envHandler(
  env: Record<string, string | undefined>,
  log: (message: string) => void = console.log,
): (request: Request) => Promise<Response> {
  let deps: WebhookDeps | undefined;
  return async (request) => {
    if (!deps) {
      try {
        deps = depsFromEnv(loadEnv(env), log);
      } catch (error) {
        const message = `Actions Guard isn't configured: ${(error as Error).message}`;
        log(message);
        return new Response(message, { status: 500 });
      }
    }
    return fetchHandler(request, deps);
  };
}
