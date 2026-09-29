import { beforeEach, describe, expect, it } from "vitest";
import { handlePullRequest, type PullRequestEvent } from "../src/app.js";
import { ALL_CLEAR, COMMENT_MARKER } from "../src/report.js";
import { FakeGitHub } from "./fake-github.js";

const CI = ".github/workflows/ci.yml";
const SAFE =
  "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
const INJECTION = SAFE.replace("run: make", 'run: echo "${{ github.event.pull_request.title }}"').replace(
  "on: push",
  "on: pull_request",
);

const event = (action = "opened", isPrivate = false): PullRequestEvent => ({
  action,
  installation: { id: 7 },
  pull_request: { number: 12, base: { sha: "base" }, head: { sha: "head" } },
  repository: { name: "shop", private: isPrivate, owner: { login: "acme" } },
});

let gh: FakeGitHub;
beforeEach(() => {
  gh = new FakeGitHub();
});

describe("handlePullRequest", () => {
  it.each(["closed", "labeled", "edited"])("ignores %s without calling GitHub", async (action) => {
    expect(await handlePullRequest(gh, event(action))).toEqual({
      status: "ignored",
      reason: `action ${action}`,
    });
    expect(gh.calls).toEqual([]);
  });

  it("does nothing when no workflow changed", async () => {
    gh.changed = [
      { filename: "src/index.ts", status: "modified" },
      { filename: ".github/workflows/nested/x.yml", status: "added" }, // not a workflow: GitHub only reads the top level
      { filename: ".github/workflows/old.yml", status: "removed" },
    ];
    expect(await handlePullRequest(gh, event())).toEqual({
      status: "skipped",
      reason: "no workflow changes",
    });
    expect(gh.checks).toEqual([]);
    expect(gh.comments).toEqual([]);
  });

  it("fails the check and comments for a new workflow with a high risk", async () => {
    gh.changed = [{ filename: CI, status: "added" }];
    gh.put("head", CI, INJECTION);

    const result = await handlePullRequest(gh, event());

    expect(result).toEqual({ status: "checked", conclusion: "failure", findings: 1, files: 1 });
    const [check] = gh.checks;
    expect(check).toMatchObject({ head_sha: "head", name: "Actions Guard", conclusion: "failure" });
    expect(check!.output.annotations).toEqual([
      expect.objectContaining({ path: CI, start_line: 7, annotation_level: "failure" }),
    ]);
    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain(COMMENT_MARKER);
    expect(gh.comments[0]!.body).toContain("script-injection");
  });

  it("reports only what the pull request adds to an existing file", async () => {
    const before = SAFE.replace("run: make", "uses: some/action@v1");
    gh.changed = [{ filename: CI, status: "modified" }];
    gh.put("base", CI, before).put("head", CI, before + '      - run: echo "${{ github.head_ref }}"\n');

    await handlePullRequest(gh, event());

    const rules = gh.checks[0]!.output.annotations.map((a) => a.title);
    expect(rules).toEqual(["script-injection (high)"]);
  });

  it("compares a renamed file with its old name", async () => {
    const risky = SAFE.replace("run: make", "uses: some/action@v1");
    gh.changed = [{ filename: ".github/workflows/build.yaml", status: "renamed", previous_filename: CI }];
    gh.put("base", CI, risky).put("head", ".github/workflows/build.yaml", risky);

    const result = await handlePullRequest(gh, event());

    expect(result).toMatchObject({ conclusion: "success", findings: 0 });
    expect(gh.comments).toEqual([]); // nothing to say, and nothing said before
  });

  it("reads the settings from the base, so a pull request can't switch rules off", async () => {
    gh.changed = [
      { filename: CI, status: "added" },
      { filename: ".github/actions-guard.yml", status: "added" },
    ];
    gh.put("head", CI, INJECTION)
      .put("head", ".github/actions-guard.yml", "ignore: [script-injection]\n")
      .put("base", ".github/actions-guard.yml", "fail_on: never\ncolour: red\n");

    const result = await handlePullRequest(gh, event());

    expect(result).toMatchObject({ conclusion: "neutral", findings: 1 });
    expect(gh.checks[0]!.output.summary).toContain('Unknown setting "colour"');
  });

  it("updates its own comment, and says all clear once the risks are gone", async () => {
    gh.changed = [{ filename: CI, status: "added" }];
    gh.put("head", CI, INJECTION);
    await handlePullRequest(gh, event());
    gh.put("head", CI, SAFE);

    await handlePullRequest(gh, event("synchronize"));

    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toBe(ALL_CLEAR);
    expect(gh.checks.map((c) => c.conclusion)).toEqual(["failure", "success"]);
  });

  it("keeps one comment up to date while risks remain", async () => {
    gh.changed = [{ filename: CI, status: "added" }];
    gh.put("head", CI, INJECTION);
    await handlePullRequest(gh, event());
    gh.put("head", CI, INJECTION + "      - uses: some/action@v1\n");

    await handlePullRequest(gh, event("synchronize"));

    expect(gh.comments).toHaveLength(1);
    expect(gh.comments[0]!.body).toContain("2 new risks");
  });

  it("sends annotations in batches of 50", async () => {
    const steps = Array.from({ length: 120 }, (_, i) => `      - uses: some/action${i}@v1\n`).join("");
    gh.changed = [{ filename: CI, status: "added" }];
    gh.put("head", CI, SAFE.replace("      - run: make\n", steps));

    await handlePullRequest(gh, event());

    const [check] = gh.checks;
    expect(check!.output.annotations).toHaveLength(50);
    expect(check!.updates.map((u) => u.annotations.length)).toEqual([50, 20]);
    expect(check!.updates[0]!.title).toBe(check!.output.title);
  });

  it("lists files it can't parse without failing the check", async () => {
    gh.changed = [{ filename: CI, status: "modified" }];
    gh.put("base", CI, SAFE).put("head", CI, "on: [push\n");

    const result = await handlePullRequest(gh, event());

    expect(result).toMatchObject({ conclusion: "neutral", findings: 0 });
    expect(gh.checks[0]!.output.summary).toContain("Couldn't check");
  });

  it("skips a file that vanished between the event and the check", async () => {
    gh.changed = [{ filename: CI, status: "added" }];
    expect(await handlePullRequest(gh, event())).toMatchObject({ conclusion: "success", files: 0 });
  });

  it("knows self-hosted runners are only a risk in public repositories", async () => {
    const selfHosted = SAFE.replace("on: push", "on: pull_request").replace("ubuntu-latest", "self-hosted");
    gh.changed = [{ filename: CI, status: "added" }];
    gh.put("head", CI, selfHosted);

    expect(await handlePullRequest(gh, event("opened", true))).toMatchObject({ findings: 0 });
    expect(await handlePullRequest(gh, event("reopened", false))).toMatchObject({ findings: 1 });
  });
});
