/**
 * What the app does for a pull request: find the workflow files it changes, compare each with the base, and
 * report what's new as a check run and one comment that it keeps up to date.
 */
import { analyze, newFindings } from "./analyze.js";
import { CONFIG_PATH, parseConfig } from "./config.js";
import {
  ALL_CLEAR,
  COMMENT_MARKER,
  checkOutput,
  commentBody,
  conclusion,
  type CheckOutput,
  type Conclusion,
  type FileResult,
} from "./report.js";

export const CHECK_NAME = "Actions Guard";
const HANDLED_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"];
/** GitHub only runs workflows directly in this folder. */
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;
/** GitHub takes at most 50 annotations per request. */
const ANNOTATION_BATCH = 50;

export interface ChangedFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

export interface CheckRunInput {
  head_sha: string;
  name: string;
  conclusion: Conclusion;
  output: CheckOutput;
}

/** The few GitHub calls the app needs – see github.ts for the real one. */
export interface GitHubApi {
  listPullRequestFiles(owner: string, repo: string, number: number): Promise<ChangedFile[]>;
  /** null when the file doesn't exist at that commit */
  getFileContent(owner: string, repo: string, path: string, ref: string): Promise<string | null>;
  createCheckRun(owner: string, repo: string, input: CheckRunInput): Promise<number>;
  updateCheckRun(owner: string, repo: string, id: number, output: CheckOutput): Promise<void>;
  /** The id of the app's own comment that starts with `marker`, if there is one */
  findComment(owner: string, repo: string, number: number, marker: string): Promise<number | null>;
  createComment(owner: string, repo: string, number: number, body: string): Promise<void>;
  updateComment(owner: string, repo: string, id: number, body: string): Promise<void>;
}

export interface PullRequestEvent {
  action: string;
  installation?: { id: number };
  pull_request: { number: number; base: { sha: string }; head: { sha: string } };
  repository: { name: string; private: boolean; owner: { login: string } };
}

export type HandleResult =
  | { status: "ignored" | "skipped"; reason: string }
  | { status: "checked"; conclusion: Conclusion; findings: number; files: number };

export async function handlePullRequest(api: GitHubApi, event: PullRequestEvent): Promise<HandleResult> {
  if (!HANDLED_ACTIONS.includes(event.action)) return { status: "ignored", reason: `action ${event.action}` };
  const owner = event.repository.owner.login;
  const repo = event.repository.name;
  const { number, base, head } = event.pull_request;

  const files = (await api.listPullRequestFiles(owner, repo, number)).filter(
    (f) => f.status !== "removed" && WORKFLOW_FILE.test(f.filename),
  );
  if (files.length === 0) return { status: "skipped", reason: "no workflow changes" };

  // from the base: the pull request under review must not be able to relax its own review
  const { config, warnings } = parseConfig(await api.getFileContent(owner, repo, CONFIG_PATH, base.sha));
  const options = { publicRepo: !event.repository.private };

  const results: FileResult[] = [];
  for (const file of files) {
    const headText = await api.getFileContent(owner, repo, file.filename, head.sha);
    if (headText === null) continue;
    const basePath =
      file.status === "renamed" && file.previous_filename ? file.previous_filename : file.filename;
    const baseText =
      file.status === "added" ? null : await api.getFileContent(owner, repo, basePath, base.sha);
    const after = analyze(headText, config, options);
    const before = baseText === null ? { findings: [] } : analyze(baseText, config, options);
    results.push({
      path: file.filename,
      findings: newFindings(before.findings, after.findings),
      error: after.error,
    });
  }

  const result = conclusion(results, config.failOn);
  const output = checkOutput(results, warnings);
  const id = await api.createCheckRun(owner, repo, {
    head_sha: head.sha,
    name: CHECK_NAME,
    conclusion: result,
    output: { ...output, annotations: output.annotations.slice(0, ANNOTATION_BATCH) },
  });
  for (let i = ANNOTATION_BATCH; i < output.annotations.length; i += ANNOTATION_BATCH) {
    await api.updateCheckRun(owner, repo, id, {
      ...output,
      annotations: output.annotations.slice(i, i + ANNOTATION_BATCH),
    });
  }

  const findings = results.reduce((n, r) => n + r.findings.length, 0);
  const existing = await api.findComment(owner, repo, number, COMMENT_MARKER);
  if (findings > 0) {
    const body = commentBody(results, warnings);
    if (existing === null) await api.createComment(owner, repo, number, body);
    else await api.updateComment(owner, repo, existing, body);
  } else if (existing !== null) {
    await api.updateComment(owner, repo, existing, ALL_CLEAR);
  }
  return { status: "checked", conclusion: result, findings, files: results.length };
}
