/** The GitHubApi of app.ts on top of Octokit, and signing in as an installation of the GitHub App. */
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { GitHubApi } from "./app.js";

export function githubApi(octokit: Octokit): GitHubApi {
  return {
    async listPullRequestFiles(owner, repo, number) {
      const files = await octokit.paginate(octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number: number,
        per_page: 100,
      });
      return files.map((f) => ({
        filename: f.filename,
        status: f.status,
        previous_filename: f.previous_filename,
      }));
    },

    async getFileContent(owner, repo, path, ref) {
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
        if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
        return Buffer.from(data.content, "base64").toString("utf8");
      } catch (error) {
        if ((error as { status?: number }).status === 404) return null;
        throw error;
      }
    },

    async createCheckRun(owner, repo, input) {
      const { data } = await octokit.rest.checks.create({ owner, repo, status: "completed", ...input });
      return data.id;
    },

    async updateCheckRun(owner, repo, id, output) {
      await octokit.rest.checks.update({ owner, repo, check_run_id: id, output });
    },

    async findComment(owner, repo, number, marker) {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: number,
        per_page: 100,
      });
      // only a bot's comment: a person quoting the report must not have their comment taken over
      return comments.find((c) => c.user?.type === "Bot" && c.body?.startsWith(marker))?.id ?? null;
    },

    async createComment(owner, repo, number, body) {
      await octokit.rest.issues.createComment({ owner, repo, issue_number: number, body });
    },

    async updateComment(owner, repo, id, body) {
      await octokit.rest.issues.updateComment({ owner, repo, comment_id: id, body });
    },
  };
}

export interface AppCredentials {
  appId: number | string;
  privateKey: string;
  /** for tests */
  fetch?: typeof globalThis.fetch;
}

/** apiFor(installationId): a GitHubApi that acts as that installation of the app, with a short-lived token. */
export function appApiFactory({ appId, privateKey, fetch }: AppCredentials) {
  return async (installationId: number): Promise<GitHubApi> =>
    githubApi(
      new Octokit({
        authStrategy: createAppAuth,
        auth: { appId, privateKey, installationId },
        request: fetch ? { fetch } : undefined,
        userAgent: "actions-guard",
      }),
    );
}
