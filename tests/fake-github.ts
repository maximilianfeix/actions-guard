import type { ChangedFile, CheckRunInput, GitHubApi } from "../src/app.js";
import type { CheckOutput } from "../src/report.js";

/** An in-memory GitHub: files per commit, and a record of the checks and comments written. */
export class FakeGitHub implements GitHubApi {
  files = new Map<string, string>(); // `${ref}:${path}` -> content
  changed: ChangedFile[] = [];
  checks: (CheckRunInput & { id: number; updates: CheckOutput[] })[] = [];
  comments: { id: number; body: string; bot: boolean }[] = [];
  calls: string[] = [];

  put(ref: string, path: string, content: string): this {
    this.files.set(`${ref}:${path}`, content);
    return this;
  }

  async listPullRequestFiles(): Promise<ChangedFile[]> {
    this.calls.push("listPullRequestFiles");
    return this.changed;
  }

  async getFileContent(_owner: string, _repo: string, path: string, ref: string): Promise<string | null> {
    this.calls.push(`getFileContent ${ref}:${path}`);
    return this.files.get(`${ref}:${path}`) ?? null;
  }

  async createCheckRun(_owner: string, _repo: string, input: CheckRunInput): Promise<number> {
    const id = this.checks.length + 1;
    this.checks.push({ ...input, id, updates: [] });
    return id;
  }

  async updateCheckRun(_owner: string, _repo: string, id: number, output: CheckOutput): Promise<void> {
    this.checks[id - 1]!.updates.push(output);
  }

  async findComment(_owner: string, _repo: string, _number: number, marker: string): Promise<number | null> {
    return this.comments.find((c) => c.bot && c.body.startsWith(marker))?.id ?? null;
  }

  async createComment(_owner: string, _repo: string, _number: number, body: string): Promise<void> {
    this.comments.push({ id: this.comments.length + 1, body, bot: true });
  }

  async updateComment(_owner: string, _repo: string, id: number, body: string): Promise<void> {
    this.comments.find((c) => c.id === id)!.body = body;
  }
}
