/** Turns findings into what GitHub shows: a check run with annotations, and a pull request comment. */
import type { Config } from "./config.js";
import { SEVERITIES, type Finding, type Severity } from "./rules.js";

export interface FileResult {
  path: string;
  findings: Finding[];
  /** Set when the file couldn't be read as a workflow. */
  error?: string;
}

export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "failure" | "warning" | "notice";
  title: string;
  message: string;
}

export interface CheckOutput {
  title: string;
  summary: string;
  annotations: Annotation[];
}

export type Conclusion = "success" | "neutral" | "failure";

export const DOCS_URL = "https://maximilianfeix.github.io/actions-guard/";
export const COMMENT_MARKER = "<!-- actions-guard -->";
export const ALL_CLEAR = `${COMMENT_MARKER}
### ✅ Actions Guard: No new risks

The workflow changes in this pull request no longer add any of the risks Actions Guard looks for.
`;

const LEVEL: Record<Severity, Annotation["annotation_level"]> = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "notice",
};

export function conclusion(results: FileResult[], failOn: Config["failOn"]): Conclusion {
  const findings = results.flatMap((r) => r.findings);
  if (failOn !== "never") {
    const limit = SEVERITIES.indexOf(failOn);
    if (findings.some((f) => SEVERITIES.indexOf(f.severity) <= limit)) return "failure";
  }
  return findings.length > 0 || results.some((r) => r.error) ? "neutral" : "success";
}

export function checkOutput(results: FileResult[], warnings: string[]): CheckOutput {
  return {
    title: headline(results),
    summary: details(results, warnings),
    annotations: results.flatMap((r) =>
      r.findings.map((f) => ({
        path: r.path,
        start_line: f.line,
        end_line: f.line,
        annotation_level: LEVEL[f.severity],
        title: `${f.rule} (${f.severity})`,
        message: f.message,
      })),
    ),
  };
}

export function commentBody(results: FileResult[], warnings: string[]): string {
  return `${COMMENT_MARKER}
### 🛡️ Actions Guard: ${headline(results)}

${details(results, warnings)}`;
}

function headline(results: FileResult[]): string {
  const findings = results.flatMap((r) => r.findings);
  if (findings.length === 0) {
    return `No new risks in ${results.length} workflow file${results.length === 1 ? "" : "s"}`;
  }
  const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return `${findings.length} new risk${findings.length === 1 ? "" : "s"}: ${counts.join(", ")}`;
}

function details(results: FileResult[], warnings: string[]): string {
  const parts: string[] = [];
  const rows = results.flatMap((r) =>
    r.findings.map(
      (f) =>
        `| ${f.severity} | \`${r.path}:${f.line}\` | [${f.rule}](${DOCS_URL}#${f.rule}) | ${cell(f.message)} |`,
    ),
  );
  if (rows.length > 0) {
    parts.push("| Severity | Where | Rule | What and how to fix |", "|---|---|---|---|", ...rows, "");
  }
  const unreadable = results.filter((r) => r.error);
  if (unreadable.length > 0) {
    parts.push("**Couldn't check:**", ...unreadable.map((r) => `- \`${r.path}\`: ${r.error}`), "");
  }
  if (warnings.length > 0) {
    parts.push("**Configuration:**", ...warnings.map((w) => `- ${w}`), "");
  }
  parts.push(
    `<sub>Only risks this pull request adds are listed – what was there before is left alone. ` +
      `[Rules and settings](${DOCS_URL})</sub>`,
  );
  return parts.join("\n");
}

/** Markdown table cells can't hold pipes or line breaks. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
