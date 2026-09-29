import { describe, expect, it } from "vitest";
import { analyze, newFindings } from "../src/analyze.js";
import { DEFAULT_CONFIG } from "../src/config.js";

const rules = (text: string, config = DEFAULT_CONFIG) => analyze(text, config).findings.map((f) => f.rule);
const find = (text: string, rule: string) =>
  analyze(text, DEFAULT_CONFIG).findings.filter((f) => f.rule === rule);

describe("untrusted-checkout", () => {
  const pwn = `
on: pull_request_target
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: \${{ github.event.pull_request.head.sha }}
      - run: npm install && npm test
`;

  it("flags checking out the PR head in pull_request_target as critical", () => {
    const [f] = find(pwn, "untrusted-checkout");
    expect(f).toMatchObject({ severity: "critical", line: 8, job: "build" });
    expect(f?.message).toContain("pull_request_target");
  });

  it("also covers workflow_run and github.head_ref", () => {
    const text = pwn
      .replace("pull_request_target", "workflow_run")
      .replace("github.event.pull_request.head.sha", "github.head_ref");
    expect(find(text, "untrusted-checkout")).toHaveLength(1);
  });

  it("is fine for pull_request, which runs without secrets", () => {
    expect(find(pwn.replace("pull_request_target", "pull_request"), "untrusted-checkout")).toEqual([]);
  });

  it("is fine for pull_request_target that checks out the base", () => {
    expect(find(pwn.replace(/\n\s+with:\n.*\n/, "\n"), "untrusted-checkout")).toEqual([]);
  });

  it("reads triggers given as a list or a map", () => {
    const asList = pwn.replace("on: pull_request_target", "on: [push, pull_request_target]");
    const asMap = pwn.replace("on: pull_request_target", "on:\n  pull_request_target:\n    types: [opened]");
    expect(find(asList, "untrusted-checkout")).toHaveLength(1);
    expect(find(asMap, "untrusted-checkout")).toHaveLength(1);
  });
});

describe("script-injection", () => {
  const wf = (run: string) => `
on: issues
permissions: {}
jobs:
  greet:
    runs-on: ubuntu-latest
    steps:
      - run: ${run}
`;

  it("flags attacker-controlled context in run as high", () => {
    const [f] = find(wf('echo "\${{ github.event.issue.title }}"'), "script-injection");
    expect(f).toMatchObject({ severity: "high", line: 8, job: "greet" });
    expect(f?.message).toContain("github.event.issue.title");
  });

  it.each([
    "github.event.pull_request.body",
    "github.event.comment.body",
    "github.head_ref",
    "github.event.pull_request.head.ref",
    "github.event.head_commit.message",
    "github.event.commits[0].author.email",
    "github.event.review.body",
    "github.event.discussion.title",
    "github.event.workflow_run.head_branch",
  ])("knows %s", (expr) => {
    expect(find(wf(`echo \${{ ${expr} }}`), "script-injection")).toHaveLength(1);
  });

  it("ignores values an outsider can't choose", () => {
    expect(find(wf("echo ${{ github.event.issue.number }} ${{ github.sha }}"), "script-injection")).toEqual(
      [],
    );
  });

  it("ignores the same data passed through env, the safe way", () => {
    const safe = wf('echo "$TITLE"').replace(
      "      - run:",
      "      - env:\n          TITLE: ${{ github.event.issue.title }}\n        run:",
    );
    expect(find(safe, "script-injection")).toEqual([]);
  });

  it("checks the script of actions/github-script too", () => {
    const text = `
on: issue_comment
permissions: {}
jobs:
  bot:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@v7
        with:
          script: console.log("\${{ github.event.comment.body }}")
`;
    expect(find(text, "script-injection")).toHaveLength(1);
  });

  it("reports each expression once per step", () => {
    const text = wf('echo "${{ github.head_ref }}" "${{ github.head_ref }}"');
    expect(find(text, "script-injection")).toHaveLength(1);
  });
});

describe("unpinned-action", () => {
  const wf = (uses: string) => `
on: push
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: ${uses}
`;

  it("flags third-party actions on a tag as medium", () => {
    const [f] = find(wf("some-org/deploy-action@v2"), "unpinned-action");
    expect(f).toMatchObject({ severity: "medium", line: 8 });
    expect(f?.message).toContain("some-org/deploy-action@v2");
  });

  it("accepts a full commit SHA", () => {
    expect(
      find(wf("some-org/deploy-action@0123456789abcdef0123456789abcdef01234567"), "unpinned-action"),
    ).toEqual([]);
  });

  it("allows actions/* and github/* by default, and local actions", () => {
    expect(find(wf("actions/setup-node@v4"), "unpinned-action")).toEqual([]);
    expect(find(wf("github/codeql-action/init@v3"), "unpinned-action")).toEqual([]);
    expect(find(wf("./.github/actions/local"), "unpinned-action")).toEqual([]);
  });

  it("follows allow_unpinned from the config", () => {
    const config = { ...DEFAULT_CONFIG, allowUnpinned: ["some-org/*"] };
    expect(rules(wf("some-org/deploy-action@v2"), config)).not.toContain("unpinned-action");
    expect(rules(wf("actions/setup-node@v4"), config)).toContain("unpinned-action");
  });

  it("flags docker images without a digest", () => {
    expect(find(wf("docker://alpine:3.20"), "unpinned-action")).toHaveLength(1);
    expect(find(wf("docker://alpine@sha256:" + "a".repeat(64)), "unpinned-action")).toEqual([]);
  });

  it("covers reusable workflows from other repositories", () => {
    const text = `
on: push
permissions: {}
jobs:
  call:
    uses: other-org/workflows/.github/workflows/build.yml@main
`;
    expect(find(text, "unpinned-action")).toHaveLength(1);
  });
});

describe("excessive-permissions", () => {
  it("flags write-all as high", () => {
    const text =
      "on: push\npermissions: write-all\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
    expect(find(text, "excessive-permissions")).toMatchObject([{ severity: "high", line: 2 }]);
  });

  it("flags every write scope as medium, per job", () => {
    const text = `
on: push
permissions:
  contents: read
jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      packages: write
    steps:
      - run: true
`;
    const found = find(text, "excessive-permissions");
    expect(found.map((f) => f.message)).toEqual([
      expect.stringContaining("contents: write"),
      expect.stringContaining("packages: write"),
    ]);
    expect(found.every((f) => f.severity === "medium" && f.job === "release")).toBe(true);
  });

  it("rates narrow write scopes low and explains id-token as OIDC", () => {
    const text = `
on: push
permissions:
  id-token: write
  pull-requests: write
jobs:
  a:
    runs-on: x
    steps:
      - run: true
`;
    const [idToken, pullRequests] = find(text, "excessive-permissions");
    expect(idToken).toMatchObject({ severity: "low", line: 4 });
    expect(idToken!.message).toContain("OIDC");
    expect(idToken!.message).not.toContain("change id-token");
    expect(pullRequests).toMatchObject({ severity: "low" });
    expect(pullRequests!.message).toContain("change pull requests");
  });
});

describe("missing-permissions", () => {
  it("flags a job that runs with the default token permissions", () => {
    const text = "on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n";
    expect(find(text, "missing-permissions")).toMatchObject([{ severity: "low", job: "a" }]);
  });

  it("is satisfied by a workflow-level or job-level block", () => {
    const top = "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n";
    const job = "on: push\njobs:\n  a:\n    runs-on: x\n    permissions: {}\n    steps:\n      - run: true\n";
    expect(find(top, "missing-permissions")).toEqual([]);
    expect(find(job, "missing-permissions")).toEqual([]);
  });
});

describe("secrets-inherit", () => {
  it("flags passing all secrets to a reusable workflow", () => {
    const text = `
on: push
permissions: {}
jobs:
  call:
    uses: ./.github/workflows/deploy.yml
    secrets: inherit
`;
    expect(find(text, "secrets-inherit")).toMatchObject([{ severity: "medium", line: 7, job: "call" }]);
  });
});

describe("self-hosted-runner", () => {
  const wf = (trigger: string) => `
on: ${trigger}
permissions: {}
jobs:
  test:
    runs-on: [self-hosted, linux]
    steps:
      - run: make test
`;

  it("flags self-hosted runners on pull request triggers in public repos", () => {
    const found = analyze(wf("pull_request"), DEFAULT_CONFIG, { publicRepo: true }).findings;
    expect(found.filter((f) => f.rule === "self-hosted-runner")).toMatchObject([
      { severity: "high", line: 6 },
    ]);
  });

  it("is quiet for private repos and for push", () => {
    expect(analyze(wf("pull_request"), DEFAULT_CONFIG, { publicRepo: false }).findings).toEqual([]);
    expect(analyze(wf("push"), DEFAULT_CONFIG, { publicRepo: true }).findings).toEqual([]);
  });
});

describe("curl-pipe-shell", () => {
  it.each(["curl -sSL https://x.sh | bash", "wget -qO- https://x.sh | sh", "curl https://x | sudo bash -s"])(
    "flags %s",
    (cmd) => {
      const text = `on: push\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: ${cmd}\n`;
      expect(find(text, "curl-pipe-shell")).toMatchObject([{ severity: "low", line: 7 }]);
    },
  );

  it("ignores a download to a file", () => {
    const text =
      "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: curl -o x.sh https://x\n";
    expect(find(text, "curl-pipe-shell")).toEqual([]);
  });
});

describe("analyze", () => {
  it("returns an error instead of findings for broken YAML", () => {
    const result = analyze("on: [push\njobs: {", DEFAULT_CONFIG);
    expect(result.findings).toEqual([]);
    expect(result.error).toMatch(/YAML/);
  });

  it("returns an error for YAML that isn't a workflow", () => {
    expect(analyze("- just\n- a list\n", DEFAULT_CONFIG).error).toMatch(/not a workflow/);
    expect(analyze("", DEFAULT_CONFIG).error).toMatch(/not a workflow/);
  });

  it("skips rules listed in ignore", () => {
    const text = "on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: true\n";
    expect(rules(text, { ...DEFAULT_CONFIG, ignore: ["missing-permissions"] })).toEqual([]);
  });

  it("orders findings by line, most severe first on the same line", () => {
    const text = `
on: pull_request_target
jobs:
  a:
    runs-on: x
    steps:
      - uses: some/action@v1
      - run: echo "\${{ github.event.pull_request.title }}"
`;
    expect(analyze(text, DEFAULT_CONFIG).findings.map((f) => [f.line, f.rule])).toEqual([
      [4, "missing-permissions"],
      [7, "unpinned-action"],
      [8, "script-injection"],
    ]);
  });

  it("survives odd but valid shapes", () => {
    const text = `
on:
jobs:
  a:
    steps:
      - null
      - uses: 42
      - run:
  b: just-a-string
`;
    expect(analyze(text, DEFAULT_CONFIG).error).toBeUndefined();
  });
});

describe("newFindings", () => {
  const base = `
on: push
permissions: {}
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: some-org/old@v1
`;

  it("keeps only what the head adds, even when lines move", () => {
    const head =
      base.replace("steps:\n", "steps:\n      - run: echo moved\n") + "      - uses: some-org/new@v1\n";
    const added = newFindings(analyze(base, DEFAULT_CONFIG).findings, analyze(head, DEFAULT_CONFIG).findings);
    expect(added.map((f) => f.message)).toEqual([expect.stringContaining("some-org/new@v1")]);
  });

  it("treats every finding as new for a new file", () => {
    expect(newFindings([], analyze(base, DEFAULT_CONFIG).findings)).toHaveLength(1);
  });
});
