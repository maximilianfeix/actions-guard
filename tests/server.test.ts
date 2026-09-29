import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWebhookServer, envHandler, fetchHandler, loadEnv, start } from "../src/server.js";
import type { WebhookDeps } from "../src/webhook.js";
import { FakeGitHub } from "./fake-github.js";

const SECRET = "s3cret";
const sign = (body: string) => "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
const deps = (): WebhookDeps => ({ secret: SECRET, apiFor: async () => new FakeGitHub() });

describe("loadEnv", () => {
  it("reads the app settings, with escaped newlines in the key", () => {
    expect(
      loadEnv({
        APP_ID: "123",
        PRIVATE_KEY: "-----BEGIN-----\\nabc\\n-----END-----",
        WEBHOOK_SECRET: "s",
        PORT: "8080",
      }),
    ).toEqual({
      appId: 123,
      privateKey: "-----BEGIN-----\nabc\n-----END-----",
      webhookSecret: "s",
      port: 8080,
    });
  });

  it("can read the key from a file and defaults the port", () => {
    const read = vi.fn(() => "PEM");
    expect(loadEnv({ APP_ID: "1", PRIVATE_KEY_PATH: "/k.pem", WEBHOOK_SECRET: "s" }, read)).toMatchObject({
      privateKey: "PEM",
      port: 3000,
    });
    expect(read).toHaveBeenCalledWith("/k.pem", "utf8");
  });

  it("takes PORT=0 literally (any free port)", () => {
    expect(loadEnv({ APP_ID: "1", PRIVATE_KEY: "k", WEBHOOK_SECRET: "s", PORT: "0" }).port).toBe(0);
  });

  it("names everything that is missing or wrong", () => {
    expect(() => loadEnv({})).toThrow(
      "Missing or invalid: APP_ID, PRIVATE_KEY or PRIVATE_KEY_PATH, WEBHOOK_SECRET",
    );
    expect(() => loadEnv({ APP_ID: "abc", PRIVATE_KEY: "k", WEBHOOK_SECRET: "s" })).toThrow("APP_ID");
  });
});

describe("fetchHandler", () => {
  it("passes a POST on to the webhook and answers with its result", async () => {
    const res = await fetchHandler(
      new Request("https://x.dev/api/webhook", {
        method: "POST",
        headers: { "x-github-event": "ping", "x-hub-signature-256": sign("{}") },
        body: "{}",
      }),
      deps(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("pong");
  });

  it("answers GET with a short status line", async () => {
    const res = await fetchHandler(new Request("https://x.dev/api/webhook"), deps());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Actions Guard");
  });

  it("refuses other methods", async () => {
    expect(
      (await fetchHandler(new Request("https://x.dev/", { method: "PUT", body: "x" }), deps())).status,
    ).toBe(405);
  });
});

describe("createWebhookServer", () => {
  let close = () => {};
  afterEach(() => close());

  async function start() {
    const server = createWebhookServer(deps());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("serves the webhook on /api/webhook and /", async () => {
    const url = await start();
    for (const path of ["/api/webhook", "/"]) {
      const res = await fetch(url + path, {
        method: "POST",
        headers: { "x-github-event": "ping", "x-hub-signature-256": sign("{}") },
        body: "{}",
      });
      expect([path, res.status, await res.text()]).toEqual([path, 200, "pong"]);
    }
  });

  it("answers health checks and 404s everything else", async () => {
    const url = await start();
    expect((await fetch(url + "/healthz")).status).toBe(200);
    expect((await fetch(url + "/nope")).status).toBe(404);
  });

  it("turns away bodies over 5 MB", async () => {
    const url = await start();
    const res = await fetch(url + "/api/webhook", { method: "POST", body: "x".repeat(5 * 1024 * 1024 + 1) });
    expect(res.status).toBe(413);
  });
});

describe("start", () => {
  it("starts a server from the environment and signs deliveries with its secret", async () => {
    const log = vi.fn();
    const server = start({ APP_ID: "1", PRIVATE_KEY: "PEM", WEBHOOK_SECRET: SECRET, PORT: "0" }, log);
    await new Promise((resolve) => server.once("listening", resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/webhook`;
      const ok = await fetch(url, {
        method: "POST",
        headers: { "x-github-event": "ping", "x-hub-signature-256": sign("{}") },
        body: "{}",
      });
      expect(ok.status).toBe(200);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Actions Guard listening"));
    } finally {
      server.close();
    }
  });
});

describe("envHandler", () => {
  it("says which settings are missing instead of crashing", async () => {
    const handler = envHandler({ APP_ID: "1" });
    const res = await handler(new Request("https://x.dev/api/webhook"));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe(
      "Actions Guard isn't configured: Missing or invalid: PRIVATE_KEY or PRIVATE_KEY_PATH, WEBHOOK_SECRET",
    );
  });

  it("reads the settings once and then handles requests", async () => {
    const env = { APP_ID: "1", PRIVATE_KEY: "PEM", WEBHOOK_SECRET: SECRET };
    const handler = envHandler(env);
    const post = () =>
      handler(
        new Request("https://x.dev/api/webhook", {
          method: "POST",
          headers: { "x-github-event": "ping", "x-hub-signature-256": sign("{}") },
          body: "{}",
        }),
      );
    expect(await (await post()).text()).toBe("pong");
    env.WEBHOOK_SECRET = "changed later";
    expect((await post()).status).toBe(200);
  });
});
