# Security

Please report vulnerabilities privately through [GitHub's security advisories](https://github.com/maximilianfeix/actions-guard/security/advisories/new) or to contact@aquaris.dev – not in a public issue. You'll get an answer within a few days.

Worth reporting: a way to make the app act on a forged webhook, to read files it shouldn't, to edit comments it didn't write, or a rule that can be bypassed with a workflow GitHub would still run.

The app verifies every webhook's `X-Hub-Signature-256`, uses short-lived installation tokens, reads its settings from the pull request's base commit, and stores nothing.
