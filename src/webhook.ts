/** The webhook endpoint, independent of the web server: verify the delivery, then hand it to the app. */
import { verify } from "@octokit/webhooks-methods";
import { handlePullRequest, type GitHubApi, type PullRequestEvent } from "./app.js";

export interface WebhookRequest {
  headers: Record<string, string | undefined>;
  /** The raw body – the signature is computed over these exact bytes. */
  body: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

export interface WebhookDeps {
  secret: string;
  apiFor(installationId: number): Promise<GitHubApi>;
  log?(message: string): void;
}

export async function handleWebhook(request: WebhookRequest, deps: WebhookDeps): Promise<WebhookResponse> {
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const signature = headers["x-hub-signature-256"];
  if (!signature || !(await verified(deps.secret, request.body, signature))) {
    return { status: 401, body: "invalid signature" };
  }
  const event = headers["x-github-event"] ?? "";
  const delivery = headers["x-github-delivery"] ?? "-";
  if (event === "ping") return { status: 200, body: "pong" };
  if (event !== "pull_request") return { status: 202, body: `ignored ${event}` };

  let payload: PullRequestEvent;
  try {
    payload = JSON.parse(request.body) as PullRequestEvent;
  } catch {
    return { status: 400, body: "body is not JSON" };
  }
  const installation = payload.installation?.id;
  if (!installation) return { status: 400, body: "pull_request event without an installation" };

  const where = `${payload.repository.owner.login}/${payload.repository.name}#${payload.pull_request.number}`;
  try {
    const result = await handlePullRequest(await deps.apiFor(installation), payload);
    deps.log?.(
      `${delivery} ${event} ${where}: ${result.status}${"conclusion" in result ? ` ${result.conclusion}` : ""}`,
    );
    return { status: 200, body: JSON.stringify(result) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log?.(`${delivery} ${event} ${where}: error ${message}`);
    return { status: 500, body: message };
  }
}

async function verified(secret: string, body: string, signature: string): Promise<boolean> {
  try {
    return await verify(secret, body, signature);
  } catch {
    return false; // a malformed signature
  }
}
