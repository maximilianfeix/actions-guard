import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { handleWebhook, type WebhookDeps } from "../src/webhook.js";
import { FakeGitHub } from "./fake-github.js";

const SECRET = "s3cret";
const sign = (body: string, secret = SECRET) =>
  "sha256=" + createHmac("sha256", secret).update(body).digest("hex");

const PR = JSON.stringify({
  action: "opened",
  installation: { id: 7 },
  pull_request: { number: 1, base: { sha: "b" }, head: { sha: "h" } },
  repository: { name: "shop", private: false, owner: { login: "acme" } },
});

/** signature null = no signature header at all */
function request(event: string, body: string, signature: string | null = sign(body)) {
  const headers: Record<string, string | undefined> = { "X-GitHub-Event": event, "X-GitHub-Delivery": "d-1" };
  if (signature !== null) headers["X-Hub-Signature-256"] = signature;
  return { headers, body };
}

function deps(overrides: Partial<WebhookDeps> = {}): WebhookDeps & { gh: FakeGitHub } {
  const gh = new FakeGitHub();
  return { secret: SECRET, apiFor: vi.fn(async () => gh), log: vi.fn(), gh, ...overrides };
}

describe("handleWebhook", () => {
  it("rejects requests without a signature or with a wrong one", async () => {
    expect((await handleWebhook(request("ping", "{}", null), deps())).status).toBe(401);
    expect((await handleWebhook(request("ping", "{}", sign("{}", "wrong")), deps())).status).toBe(401);
    expect((await handleWebhook(request("ping", "{}", "sha256=zz"), deps())).status).toBe(401);
  });

  it("answers GitHub's ping", async () => {
    expect(await handleWebhook(request("ping", "{}"), deps())).toEqual({ status: 200, body: "pong" });
  });

  it("accepts but ignores events it doesn't handle", async () => {
    const d = deps();
    expect(await handleWebhook(request("issues", "{}"), d)).toEqual({ status: 202, body: "ignored issues" });
    expect(d.apiFor).not.toHaveBeenCalled();
  });

  it("runs the check for a pull request as that installation", async () => {
    const d = deps();
    d.gh.changed = [{ filename: ".github/workflows/ci.yml", status: "added" }];
    d.gh.put(
      "h",
      ".github/workflows/ci.yml",
      "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n",
    );

    const res = await handleWebhook(request("pull_request", PR), d);

    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "checked", conclusion: "neutral", findings: 1, files: 1 });
    expect(d.apiFor).toHaveBeenCalledWith(7);
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("d-1 pull_request acme/shop#1: checked"));
  });

  it("says what's wrong with a malformed pull request payload", async () => {
    expect((await handleWebhook(request("pull_request", "{not json"), deps())).status).toBe(400);
    const noInstallation = JSON.stringify({ ...JSON.parse(PR), installation: undefined });
    expect(await handleWebhook(request("pull_request", noInstallation), deps())).toEqual({
      status: 400,
      body: "pull_request event without an installation",
    });
  });

  it("reports a failure as 500 and logs it, so GitHub shows the delivery as failed", async () => {
    const d = deps({ apiFor: vi.fn(async () => Promise.reject(new Error("token expired"))) });
    const res = await handleWebhook(request("pull_request", PR), d);
    expect(res).toEqual({ status: 500, body: "token expired" });
    expect(d.log).toHaveBeenCalledWith(expect.stringContaining("token expired"));
  });

  it("works without a logger", async () => {
    const d = deps({ log: undefined });
    expect(
      (
        await handleWebhook(
          request("pull_request", JSON.stringify({ ...JSON.parse(PR), action: "closed" })),
          d,
        )
      ).status,
    ).toBe(200);
  });
});
