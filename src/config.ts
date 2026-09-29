/** Settings a repository can put in .github/actions-guard.yml. */
import { parse } from "yaml";
import { RULE_IDS, SEVERITIES, type RuleId, type Severity } from "./rules.js";

export interface Config {
  /** The check fails when a new finding is at least this severe; "never" keeps it neutral. */
  failOn: Severity | "never";
  ignore: RuleId[];
  /** Actions that may be used on a tag or branch: "owner/*" or "owner/repo". */
  allowUnpinned: string[];
}

export const CONFIG_PATH = ".github/actions-guard.yml";

export const DEFAULT_CONFIG: Config = {
  failOn: "high",
  ignore: [],
  allowUnpinned: ["actions/*", "github/*"],
};

const SETTINGS = ["fail_on", "ignore", "allow_unpinned"];

export interface ConfigResult {
  config: Config;
  warnings: string[];
}

/** Reads the config file; anything it can't use falls back to the default, with a warning that says why. */
export function parseConfig(text: string | null): ConfigResult {
  if (text === null || text.trim() === "") return { config: DEFAULT_CONFIG, warnings: [] };
  let raw: unknown;
  try {
    raw = parse(text);
  } catch {
    return { config: DEFAULT_CONFIG, warnings: [`${CONFIG_PATH} is not valid YAML, using the defaults.`] };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config: DEFAULT_CONFIG, warnings: [`${CONFIG_PATH} should be a mapping, using the defaults.`] };
  }
  const data = raw as Record<string, unknown>;
  const config: Config = { ...DEFAULT_CONFIG };
  const warnings: string[] = [];

  if ("fail_on" in data) {
    const value = data.fail_on;
    if (value === "never" || SEVERITIES.includes(value as Severity)) {
      config.failOn = value as Config["failOn"];
    } else {
      warnings.push(`fail_on must be one of ${[...SEVERITIES, "never"].join(", ")}; using "high".`);
    }
  }
  if ("ignore" in data) {
    const known = (id: string): id is RuleId => (RULE_IDS as readonly string[]).includes(id);
    const list = stringList(data.ignore);
    const unknown = list.filter((id) => !known(id));
    if (unknown.length > 0) warnings.push(`Unknown rules in ignore: ${unknown.join(", ")}.`);
    config.ignore = list.filter(known);
  }
  if ("allow_unpinned" in data) config.allowUnpinned = stringList(data.allow_unpinned);
  for (const key of Object.keys(data)) {
    if (!SETTINGS.includes(key)) warnings.push(`Unknown setting "${key}".`);
  }
  return { config, warnings };
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
