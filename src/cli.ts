/** actions-guard on the command line: check workflow files, or register the GitHub App (setup). */
import { parseArgs } from "node:util";
import { analyze, newFindings } from "./analyze.js";
import { DEFAULT_CONFIG, parseConfig, type Config } from "./config.js";
import { conclusion, type FileResult } from "./report.js";
import { SEVERITIES, type Severity } from "./rules.js";
import type { SetupOptions } from "./setup.js";
import { VERSION } from "./version.js";

export interface Io {
  stdout(text: string): void;
  stderr(text: string): void;
  readFile(path: string): string;
  /** for tests; defaults to the real setup flow */
  setup?(options: SetupOptions): Promise<void>;
}

const HELP = `Usage: actions-guard [options] <workflow files...>
       actions-guard setup [--name NAME] [--webhook-url URL] [--org ORG] [--port PORT]

Checks GitHub Actions workflows for script injection, pwn requests, unpinned actions,
broad token permissions and more. Exits 1 when a finding reaches --fail-on.

Options:
  --base FILE       compare with this older version of the file; report only what's new
  --config FILE     settings file (default: none; the app reads .github/actions-guard.yml)
  --fail-on LEVEL   critical, high (default), medium, low or never
  --private         the repository is private (self-hosted runners are then fine)
  --json            print the results as JSON
  -h, --help        show this help
  -v, --version     print the version

setup registers your own instance of the GitHub App in the browser and writes .env
with its ID, webhook secret and private key.
`;

export async function run(argv: string[], io: Io): Promise<number> {
  try {
    if (argv[0] === "setup") return await setup(argv.slice(1), io);
    return check(argv, io);
  } catch (error) {
    io.stderr(`actions-guard: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function check(argv: string[], io: Io): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      base: { type: "string" },
      config: { type: "string" },
      "fail-on": { type: "string" },
      private: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.help) return print(io, HELP);
  if (values.version) return print(io, `${VERSION}\n`);
  if (positionals.length === 0) throw new Error("no workflow files given (try --help)");
  if (values.base && positionals.length !== 1) throw new Error("--base works with exactly one file");

  let config: Config = DEFAULT_CONFIG;
  if (values.config) {
    const parsed = parseConfig(io.readFile(values.config));
    config = parsed.config;
    for (const warning of parsed.warnings) io.stderr(`warning: ${warning}\n`);
  }
  const failOn = values["fail-on"];
  if (failOn !== undefined) {
    if (failOn !== "never" && !SEVERITIES.includes(failOn as Severity)) {
      throw new Error(`--fail-on must be one of ${[...SEVERITIES, "never"].join(", ")}`);
    }
    config = { ...config, failOn: failOn as Config["failOn"] };
  }

  const options = { publicRepo: !values.private };
  const results: FileResult[] = positionals.map((path) => {
    const after = analyze(io.readFile(path), config, options);
    const before = values.base ? analyze(io.readFile(values.base), config, options).findings : [];
    return { path, findings: newFindings(before, after.findings), error: after.error };
  });

  if (values.json) {
    io.stdout(JSON.stringify(results, null, 2) + "\n");
  } else {
    io.stdout(text(results));
  }
  return conclusion(results, config.failOn) === "failure" ? 1 : 0;
}

function text(results: FileResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    if (r.error) lines.push(`${r.path}\n  ${r.error}`);
    if (r.findings.length === 0) continue;
    lines.push(r.path);
    for (const f of r.findings) {
      lines.push(
        `  ${String(f.line).padStart(4)}  ${f.severity.padEnd(8)}  ${f.rule.padEnd(21)}  ${f.message}`,
      );
    }
  }
  const findings = results.flatMap((r) => r.findings);
  if (findings.length === 0) {
    lines.push(`No risks found in ${results.length} file${results.length === 1 ? "" : "s"}.`);
  } else {
    const counts = SEVERITIES.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
      .filter(([, n]) => n > 0)
      .map(([s, n]) => `${n} ${s}`);
    lines.push("", `${findings.length} risk${findings.length === 1 ? "" : "s"}: ${counts.join(", ")}`);
  }
  return lines.join("\n") + "\n";
}

async function setup(argv: string[], io: Io): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      name: { type: "string" },
      "webhook-url": { type: "string" },
      org: { type: "string" },
      port: { type: "string" },
    },
  });
  const options: SetupOptions = {
    name: values.name,
    webhookUrl: values["webhook-url"],
    org: values.org,
    port: values.port ? Number(values.port) : undefined,
  };
  const runSetup = io.setup ?? (await import("./setup.js")).runSetup;
  try {
    await runSetup(options);
    return 0;
  } catch (error) {
    io.stderr(`setup failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

function print(io: Io, text: string): number {
  io.stdout(text);
  return 0;
}
