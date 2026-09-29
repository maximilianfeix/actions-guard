import type { Config } from "./config.js";
import { RULE_IDS, RULES, SEVERITIES, type Finding } from "./rules.js";
import { parseWorkflow } from "./workflow.js";

export interface AnalyzeOptions {
  publicRepo?: boolean;
}

export interface Analysis {
  findings: Finding[];
  error?: string;
}

export function analyze(text: string, config: Config, options: AnalyzeOptions = {}): Analysis {
  const parsed = parseWorkflow(text);
  if (parsed.error !== undefined) return { findings: [], error: parsed.error };
  const context = { config, publicRepo: options.publicRepo ?? true };
  const findings = RULE_IDS.filter((id) => !config.ignore.includes(id)).flatMap((id) =>
    RULES[id](parsed.workflow, context),
  );
  return { findings: findings.sort(byLineThenSeverity) };
}

/** The findings of `head` that `base` doesn't have – compared by key, so moved lines don't count as new. */
export function newFindings(base: Finding[], head: Finding[]): Finding[] {
  const remaining = new Map<string, number>();
  for (const f of base) remaining.set(f.key, (remaining.get(f.key) ?? 0) + 1);
  return head.filter((f) => {
    const left = remaining.get(f.key) ?? 0;
    if (left > 0) {
      remaining.set(f.key, left - 1);
      return false;
    }
    return true;
  });
}

function byLineThenSeverity(a: Finding, b: Finding): number {
  return a.line - b.line || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity);
}
