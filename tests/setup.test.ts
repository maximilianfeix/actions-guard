import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  appManifest,
  exchangeCode,
  runSetup,
  setupPage,
  writeCredentials,
  type Conversion,
} from "../src/setup.js";

const CONVERSION: Conversion = {
  id: 4242,
  slug: "my-guard",
  html_url: "https://github.com/apps/my-guard",
  pem: "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----\n",
  webhook_secret: "whsec",
};

describe("appManifest", () => {
  it("asks for the least the app needs and only pull request events", () => {
    const m = appManifest({ name: "Actions Guard", webhookUrl: "https://x.dev/api/webhook", port: 3000 });
    expect(m.default_permissions).toEqual({
      checks: "write",
      contents: "read",
      pull_requests: "write",
      metadata: "read",
    });
    expect(m.default_events).toEqual(["pull_request"]);
    expect(m.hook_attributes).toEqual({ url: "https://x.dev/api/webhook", active: true });
    expect(m.redirect_url).toBe("http://127.0.0.1:3000/callback");
    expect(m.public).toBe(true);
  });

  it("registers an inactive webhook when there is no URL yet", () => {
    expect(appManifest({ name: "A", port: 1 }).hook_attributes.active).toBe(false);
  });
});

describe("setupPage", () => {
  it("posts the manifest to GitHub, escaped, with the state", () => {
    const html = setupPage(appManifest({ name: `Tom's "Guard" <x>`, port: 1 }), "st4te");
    expect(html).toContain('action="https://github.com/settings/apps/new?state=st4te"');
    expect(html).toContain("&quot;Tom&#39;s \\&quot;Guard\\&quot; &lt;x&gt;&quot;");
    expect(html).not.toContain("<x>");
  });

  it("goes to the organization's settings with --org", () => {
    expect(setupPage(appManifest({ name: "A", port: 1 }), "s", "acme")).toContain(
      'action="https://github.com/organizations/acme/settings/apps/new?state=s"',
    );
  });
});

describe("exchangeCode", () => {
  it("trades the one-time code for the app's credentials", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(CONVERSION), { status: 201 }));
    expect(await exchangeCode("c0de", fetch)).toEqual(CONVERSION);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/c0de/conversions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("says why GitHub refused", async () => {
    const fetch = vi.fn(async () => new Response('{"message":"Not Found"}', { status: 404 }));
    await expect(exchangeCode("old", fetch)).rejects.toThrow("GitHub answered 404: Not Found");
  });
});

describe("writeCredentials", () => {
  it("writes .env and a private key only the owner can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-"));
    const { envPath, keyPath } = writeCredentials(dir, CONVERSION);
    expect(readFileSync(envPath, "utf8")).toBe(
      "APP_ID=4242\nWEBHOOK_SECRET=whsec\nPRIVATE_KEY_PATH=./my-guard.private-key.pem\n",
    );
    expect(readFileSync(keyPath, "utf8")).toBe(CONVERSION.pem);
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);
  });

  it("never overwrites an existing .env", () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-"));
    writeFileSync(join(dir, ".env"), "APP_ID=1\n");
    expect(() => writeCredentials(dir, CONVERSION)).toThrow(".env already exists");
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe("APP_ID=1\n");
  });
});

describe("runSetup", () => {
  it("serves the page, takes GitHub's redirect and saves the app", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-"));
    const log = vi.fn();
    const fetchGitHub = vi.fn(async () => new Response(JSON.stringify(CONVERSION), { status: 201 }));
    let base = "";
    const done = runSetup({
      port: 0,
      dir,
      fetch: fetchGitHub,
      log,
      open: (url) => {
        base = url;
      },
    });
    await vi.waitFor(() => expect(base).not.toBe(""));

    const page = await (await fetch(base)).text();
    const state = page.match(/state=([a-f0-9]+)/)![1];
    expect((await fetch(`${base}/callback?code=c&state=wrong`)).status).toBe(400);
    const finished = await fetch(`${base}/callback?code=c0de&state=${state}`);
    expect(await finished.text()).toContain("https://github.com/apps/my-guard/installations/new");
    await done;

    expect(fetchGitHub).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/c0de/conversions",
      expect.anything(),
    );
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("APP_ID=4242");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Install it"));
  });

  it("fails and stops when the exchange fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ag-"));
    let base = "";
    const done = runSetup({
      port: 0,
      dir,
      fetch: async () => new Response('{"message":"gone"}', { status: 404 }),
      log: () => {},
      open: (url) => {
        base = url;
      },
    });
    const outcome = done.then(
      () => "resolved",
      (error: Error) => error.message,
    ); // observed right away, so the rejection is never unhandled
    await vi.waitFor(() => expect(base).not.toBe(""));
    const state = (await (await fetch(base)).text()).match(/state=([a-f0-9]+)/)![1];
    const res = await fetch(`${base}/callback?code=x&state=${state}`);
    expect(res.status).toBe(500);
    expect(await outcome).toBe("GitHub answered 404: gone");
  });

  it("404s other paths", async () => {
    let base = "";
    const done = runSetup({
      port: 0,
      dir: mkdtempSync(join(tmpdir(), "ag-")),
      fetch: async () => new Response(JSON.stringify(CONVERSION), { status: 201 }),
      log: () => {},
      open: (url) => {
        base = url;
      },
    });
    await vi.waitFor(() => expect(base).not.toBe(""));
    expect((await fetch(`${base}/favicon.ico`)).status).toBe(404);
    const state = (await (await fetch(base)).text()).match(/state=([a-f0-9]+)/)![1];
    await fetch(`${base}/callback?code=c&state=${state}`);
    await done;
  });
});
