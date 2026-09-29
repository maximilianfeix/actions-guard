/**
 * A small, forgiving model of a GitHub Actions workflow file: just what the rules need, each piece with the line
 * it starts on. Anything with an unexpected shape is left out rather than rejected – GitHub reports broken
 * workflows itself, this only has to find risks in the parts that make sense.
 */
import { isMap, isScalar, isSeq, LineCounter, parseDocument, type Node, type Pair, type YAMLMap } from "yaml";

export interface PermissionScope {
  scope: string;
  level: string;
  line: number;
}

export interface Permissions {
  line: number;
  /** "read-all", "write-all" or "" for a map of scopes */
  shorthand: string;
  scopes: PermissionScope[];
}

export interface Step {
  line: number;
  uses?: string;
  run?: string;
  with: Record<string, string>;
}

export interface Job {
  id: string;
  line: number;
  runsOn: string[];
  runsOnLine: number;
  permissions?: Permissions;
  uses?: string;
  usesLine: number;
  secretsInheritLine?: number;
  steps: Step[];
}

export interface Workflow {
  triggers: string[];
  permissions?: Permissions;
  jobs: Job[];
}

export type ParseResult = { workflow: Workflow; error?: undefined } | { workflow?: undefined; error: string };

export function parseWorkflow(text: string): ParseResult {
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: false });
  if (doc.errors.length > 0) {
    return { error: `Invalid YAML: ${doc.errors[0]!.message.split("\n")[0]}` };
  }
  const root = doc.contents;
  if (!isMap(root)) {
    return { error: "This file is not a workflow (expected a mapping with `on` and `jobs`)." };
  }
  const lineOf = (node: unknown): number => {
    const range = (node as Node | null | undefined)?.range;
    return range ? lines.linePos(range[0]).line : 1;
  };

  const jobsNode = get(root, "jobs");
  const jobs: Job[] = [];
  if (isMap(jobsNode)) {
    for (const pair of jobsNode.items) {
      if (isMap(pair.value)) jobs.push(parseJob(String(scalar(pair.key)), pair, pair.value, lineOf));
    }
  }
  return {
    workflow: {
      triggers: triggers(get(root, "on")),
      permissions: permissions(pairOf(root, "permissions"), lineOf),
      jobs,
    },
  };
}

function parseJob(id: string, pair: Pair, job: YAMLMap, lineOf: (node: unknown) => number): Job {
  const runsOnPair = pairOf(job, "runs-on");
  const usesPair = pairOf(job, "uses");
  const secretsPair = pairOf(job, "secrets");
  const stepsNode = get(job, "steps");
  const steps: Step[] = [];
  if (isSeq(stepsNode)) {
    for (const item of stepsNode.items) {
      if (!isMap(item)) continue;
      const withNode = get(item, "with");
      const withValues: Record<string, string> = {};
      if (isMap(withNode)) {
        for (const p of withNode.items) {
          const value = scalar(p.value);
          if (value !== undefined) withValues[String(scalar(p.key))] = String(value);
        }
      }
      steps.push({
        line: lineOf(item),
        uses: text(get(item, "uses")),
        run: text(get(item, "run")),
        with: withValues,
      });
    }
  }
  return {
    id,
    line: lineOf(pair.key),
    runsOn: strings(runsOnPair?.value),
    runsOnLine: lineOf(runsOnPair?.key),
    permissions: permissions(pairOf(job, "permissions"), lineOf),
    uses: text(usesPair?.value),
    usesLine: lineOf(usesPair?.key),
    secretsInheritLine: scalar(secretsPair?.value) === "inherit" ? lineOf(secretsPair?.key) : undefined,
    steps,
  };
}

function permissions(pair: Pair | undefined, lineOf: (node: unknown) => number): Permissions | undefined {
  if (!pair) return undefined;
  const result: Permissions = { line: lineOf(pair.key), shorthand: "", scopes: [] };
  if (isMap(pair.value)) {
    for (const p of pair.value.items) {
      result.scopes.push({
        scope: String(scalar(p.key)),
        level: String(scalar(p.value)),
        line: lineOf(p.key),
      });
    }
  } else {
    result.shorthand = String(scalar(pair.value) ?? "");
  }
  return result;
}

function triggers(node: unknown): string[] {
  if (isMap(node)) return node.items.map((p) => String(scalar(p.key)));
  return strings(node);
}

function strings(node: unknown): string[] {
  if (isSeq(node))
    return node.items
      .map(scalar)
      .filter((v) => v !== undefined)
      .map(String);
  const value = scalar(node);
  return value === undefined ? [] : [String(value)];
}

function pairOf(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => scalar(p.key) === key);
}

function get(map: YAMLMap, key: string): unknown {
  return pairOf(map, key)?.value;
}

function scalar(node: unknown): string | number | boolean | undefined {
  if (!isScalar(node)) return undefined;
  const value = node.value;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : undefined;
}

function text(node: unknown): string | undefined {
  const value = scalar(node);
  return typeof value === "string" ? value : undefined;
}
