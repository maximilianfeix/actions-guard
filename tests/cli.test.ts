import { describe, expect, it, vi } from "vitest";
import { run, type Io } from "../src/cli.js";

const SAFE =
  "on: push\npermissions: {}\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: make\n";
const RISKY = SAFE.replace("run: make", 'run: echo "${{ github.event.issue.title }}"');
const MEDIUM = SAFE.replace("run: make", "uses: some/action@v1");

function io(files: Record<string, string>) {
  const out: string[] = [];
  const err: string[] = [];
  const value: Io = {
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
    readFile: (path) => {
      if (!(path in files)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      return files[path]!;
    },
  };
  return { io: value, out: () => out.join(""), err: () => err.join("") };
}

describe("cli check", () => {
  it("prints findings per file and fails on a high risk", async () => {
    const t = io({ "ci.yml": RISKY });
    expect(await run(["ci.yml"], t.io)).toBe(1);
    expect(t.out()).toContain("ci.yml");
    expect(t.out()).toMatch(/7\s+high\s+script-injection/);
    expect(t.out()).toContain("1 risk: 1 high");
  });

  it("passes a clean file", async () => {
    const t = io({ "ci.yml": SAFE });
    expect(await run(["ci.yml"], t.io)).toBe(0);
    expect(t.out()).toContain("No risks found in 1 file");
  });

  it("only fails at --fail-on", async () => {
    expect(await run(["ci.yml"], io({ "ci.yml": MEDIUM }).io)).toBe(0);
    expect(await run(["--fail-on", "medium", "ci.yml"], io({ "ci.yml": MEDIUM }).io)).toBe(1);
  });

  it("compares with --base and reports only what's new", async () => {
    const t = io({ "old.yml": MEDIUM, "new.yml": MEDIUM + '      - run: echo "${{ github.head_ref }}"\n' });
    expect(await run(["--base", "old.yml", "--json", "new.yml"], t.io)).toBe(1);
    const [result] = JSON.parse(t.out());
    expect(result.path).toBe("new.yml");
    expect(result.findings.map((f: { rule: string }) => f.rule)).toEqual(["script-injection"]);
  });

  it("uses a config file and prints its warnings", async () => {
    const t = io({ "ci.yml": RISKY, "guard.yml": "ignore: [script-injection]\nfoo: 1\n" });
    expect(await run(["--config", "guard.yml", "ci.yml"], t.io)).toBe(0);
    expect(t.err()).toContain('Unknown setting "foo"');
  });

  it("treats --private as a private repository", async () => {
    const selfHosted = SAFE.replace("on: push", "on: pull_request").replace("ubuntu-latest", "self-hosted");
    expect(await run(["ci.yml"], io({ "ci.yml": selfHosted }).io)).toBe(1);
    expect(await run(["--private", "ci.yml"], io({ "ci.yml": selfHosted }).io)).toBe(0);
  });

  it("lists files it can't parse", async () => {
    const t = io({ "bad.yml": "on: [push\n" });
    expect(await run(["bad.yml"], t.io)).toBe(0);
    expect(t.out()).toContain("Invalid YAML");
  });

  it.each([
    [[], "no workflow files given"],
    [["--base", "a.yml", "b.yml", "c.yml"], "--base works with exactly one file"],
    [["--fail-on", "loud", "a.yml"], "--fail-on must be one of"],
    [["--nope"], "Unknown option"],
    [["missing.yml"], "ENOENT: missing.yml"],
  ])("exits 2 with a message for %j", async (argv, message) => {
    const t = io({ "a.yml": SAFE, "b.yml": SAFE, "c.yml": SAFE });
    expect(await run(argv, t.io)).toBe(2);
    expect(t.err()).toContain(message);
  });

  it("prints help and the version", async () => {
    const t = io({});
    expect(await run(["--help"], t.io)).toBe(0);
    expect(t.out()).toContain("Usage: actions-guard");
    expect(await run(["--version"], t.io)).toBe(0);
    expect(t.out()).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("cli setup", () => {
  it("hands the options to the setup flow", async () => {
    const setup = vi.fn(async () => {});
    const t = io({});
    const code = await run(
      [
        "setup",
        "--name",
        "My Guard",
        "--webhook-url",
        "https://x.dev/api/webhook",
        "--org",
        "acme",
        "--port",
        "4000",
      ],
      { ...t.io, setup },
    );
    expect(code).toBe(0);
    expect(setup).toHaveBeenCalledWith({
      name: "My Guard",
      webhookUrl: "https://x.dev/api/webhook",
      org: "acme",
      port: 4000,
    });
  });

  it("reports a failed setup", async () => {
    const t = io({});
    const setup = vi.fn(async () => Promise.reject(new Error(".env already exists")));
    expect(await run(["setup"], { ...t.io, setup })).toBe(1);
    expect(t.err()).toContain(".env already exists");
  });
});
