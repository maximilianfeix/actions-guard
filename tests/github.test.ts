import { generateKeyPairSync } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { appApiFactory, githubApi } from "../src/github.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
  auth?: string | null;
}

/** A fetch that answers from a table of routes and records every request. */
function fakeFetch(routes: Record<string, (url: URL) => { status?: number; body: unknown; link?: string }>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      path: decodeURIComponent(url.pathname) + url.search,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      auth: headers.get("authorization"),
    });
    const route = routes[`${method} ${decodeURIComponent(url.pathname)}`];
    if (!route) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    const { status = 200, body, link } = route(url);
    const responseHeaders: Record<string, string> = { "content-type": "application/json" };
    if (link) responseHeaders.link = link;
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: responseHeaders });
  };
  return { fetch, calls };
}

const api = (routes: Parameters<typeof fakeFetch>[0]) => {
  const fake = fakeFetch(routes);
  return { api: githubApi(new Octokit({ request: { fetch: fake.fetch } })), calls: fake.calls };
};

describe("githubApi", () => {
  it("lists every changed file across pages", async () => {
    const { api: gh, calls } = api({
      "GET /repos/acme/shop/pulls/12/files": (url) =>
        url.searchParams.get("page") === "2"
          ? { body: [{ filename: "b.yml", status: "renamed", previous_filename: "a.yml" }] }
          : {
              body: [{ filename: "x.ts", status: "modified" }],
              link: '<https://api.github.com/repos/acme/shop/pulls/12/files?per_page=100&page=2>; rel="next"',
            },
    });
    expect(await gh.listPullRequestFiles("acme", "shop", 12)).toEqual([
      { filename: "x.ts", status: "modified", previous_filename: undefined },
      { filename: "b.yml", status: "renamed", previous_filename: "a.yml" },
    ]);
    expect(calls).toHaveLength(2);
  });

  it("decodes file contents at a commit", async () => {
    const { api: gh, calls } = api({
      "GET /repos/acme/shop/contents/.github/workflows/ci.yml": () => ({
        body: { type: "file", encoding: "base64", content: Buffer.from("on: push\n").toString("base64") },
      }),
    });
    expect(await gh.getFileContent("acme", "shop", ".github/workflows/ci.yml", "abc")).toBe("on: push\n");
    expect(calls[0]!.path).toBe("/repos/acme/shop/contents/.github/workflows/ci.yml?ref=abc");
  });

  it("returns null for a missing file or a directory", async () => {
    const { api: gh } = api({ "GET /repos/acme/shop/contents/dir": () => ({ body: [{ name: "x" }] }) });
    expect(await gh.getFileContent("acme", "shop", "missing.yml", "abc")).toBeNull();
    expect(await gh.getFileContent("acme", "shop", "dir", "abc")).toBeNull();
  });

  it("passes other errors on", async () => {
    const { api: gh } = api({
      "GET /repos/acme/shop/contents/x.yml": () => ({ status: 500, body: { message: "boom" } }),
    });
    await expect(gh.getFileContent("acme", "shop", "x.yml", "abc")).rejects.toMatchObject({ status: 500 });
  });

  it("creates a completed check run and adds annotations to it", async () => {
    const { api: gh, calls } = api({
      "POST /repos/acme/shop/check-runs": () => ({ status: 201, body: { id: 99 } }),
      "PATCH /repos/acme/shop/check-runs/99": () => ({ body: { id: 99 } }),
    });
    const output = { title: "t", summary: "s", annotations: [] };
    const id = await gh.createCheckRun("acme", "shop", {
      head_sha: "abc",
      name: "Actions Guard",
      conclusion: "neutral",
      output,
    });
    await gh.updateCheckRun("acme", "shop", id, output);
    expect(id).toBe(99);
    expect(calls[0]!.body).toMatchObject({
      head_sha: "abc",
      status: "completed",
      conclusion: "neutral",
      output,
    });
    expect(calls[1]).toMatchObject({ method: "PATCH", body: { output } });
  });

  it("finds only its own comment, by the marker", async () => {
    const { api: gh } = api({
      "GET /repos/acme/shop/issues/12/comments": () => ({
        body: [
          { id: 1, body: "<!-- m --> copied by a person", user: { type: "User" } },
          { id: 2, body: "something else", user: { type: "Bot" } },
          { id: 3, body: "<!-- m --> report", user: { type: "Bot" } },
          { id: 4, user: null },
        ],
      }),
    });
    expect(await gh.findComment("acme", "shop", 12, "<!-- m -->")).toBe(3);
    expect(await gh.findComment("acme", "shop", 12, "<!-- other -->")).toBeNull();
  });

  it("creates and updates comments", async () => {
    const { api: gh, calls } = api({
      "POST /repos/acme/shop/issues/12/comments": () => ({ status: 201, body: { id: 5 } }),
      "PATCH /repos/acme/shop/issues/comments/5": () => ({ body: { id: 5 } }),
    });
    await gh.createComment("acme", "shop", 12, "hello");
    await gh.updateComment("acme", "shop", 5, "again");
    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["POST", { body: "hello" }],
      ["PATCH", { body: "again" }],
    ]);
  });
});

describe("appApiFactory", () => {
  it("signs in as the app installation and uses its token", async () => {
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const fake = fakeFetch({
      "POST /app/installations/7/access_tokens": () => ({
        status: 201,
        body: { token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString() },
      }),
      "POST /repos/acme/shop/issues/1/comments": () => ({ status: 201, body: { id: 1 } }),
    });

    const apiFor = appApiFactory({ appId: 123, privateKey, fetch: fake.fetch });
    await (await apiFor(7)).createComment("acme", "shop", 1, "hi");

    expect(fake.calls[0]!.auth).toMatch(/^bearer ey/); // a JWT signed with the app's key
    expect(fake.calls[1]!.auth).toBe("token ghs_installation");
  });
});
