# Actions Guard

[![ci](https://github.com/maximilianfeix/actions-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/maximilianfeix/actions-guard/actions/workflows/ci.yml)
[![codeql](https://github.com/maximilianfeix/actions-guard/actions/workflows/codeql.yml/badge.svg)](https://github.com/maximilianfeix/actions-guard/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A GitHub App that reviews pull requests which change GitHub Actions workflows, and flags the security risks they add** – script injection, "pwn requests", unpinned third-party actions, broad token permissions and more.

It only reports what the pull request **adds**. A repository with years of workflow history doesn't get a wall of findings on day one; a pull request that pastes `${{ github.event.issue.title }}` into a shell script gets stopped.

[Rules](https://maximilianfeix.github.io/actions-guard/#rules) · [Install](#install-the-app) · [Self-host](#self-host) · [CLI](#command-line) · [Settings](#settings) · [Privacy](#permissions-and-privacy)

## What it looks like

For every pull request that touches `.github/workflows/`, Actions Guard adds a check run with annotations on the changed lines, and keeps one comment up to date:

> ### 🛡️ Actions Guard: 2 new risks: 1 critical, 1 medium
>
> | Severity | Where                              | Rule               | What and how to fix                                                                                                             |
> | -------- | ---------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
> | critical | `.github/workflows/preview.yml:14` | untrusted-checkout | `pull_request_target` runs with a write token and the repository's secrets, and this step checks out the pull request's code. … |
> | medium   | `.github/workflows/preview.yml:19` | unpinned-action    | `some-org/deploy@v2` points to a tag or branch its owner can move at any time; … Pin it to a full commit SHA.                   |

The check fails at `high` and above by default, so branch protection can require it.

## Rules

| Rule                                                                                             | Severity | Catches                                                                                         |
| ------------------------------------------------------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------------- |
| [`untrusted-checkout`](https://maximilianfeix.github.io/actions-guard/#untrusted-checkout)       | critical | `pull_request_target` / `workflow_run` workflows that check out and run the pull request's code |
| [`script-injection`](https://maximilianfeix.github.io/actions-guard/#script-injection)           | high     | Titles, bodies, branch names, commit messages pasted into `run:` or `github-script`             |
| [`self-hosted-runner`](https://maximilianfeix.github.io/actions-guard/#self-hosted-runner)       | high     | Pull request code on your own machines, in public repositories                                  |
| [`excessive-permissions`](https://maximilianfeix.github.io/actions-guard/#excessive-permissions) | high–low | `write-all` (high), write access to code, releases, packages (medium), narrower scopes (low)    |
| [`unpinned-action`](https://maximilianfeix.github.io/actions-guard/#unpinned-action)             | medium   | Third-party actions, reusable workflows and Docker images on a movable tag instead of a SHA     |
| [`secrets-inherit`](https://maximilianfeix.github.io/actions-guard/#secrets-inherit)             | medium   | `secrets: inherit` handing every secret to a called workflow                                    |
| [`missing-permissions`](https://maximilianfeix.github.io/actions-guard/#missing-permissions)     | low      | Jobs that run with the repository's default token permissions                                   |
| [`curl-pipe-shell`](https://maximilianfeix.github.io/actions-guard/#curl-pipe-shell)             | low      | `curl … \| bash` and friends                                                                    |

The patterns follow GitHub's own [security hardening guide for GitHub Actions](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions). Run over 131 workflow files of seven large open-source projects (React, Next.js, VS Code, Node.js, PyTorch, Rust, Home Assistant), it parsed every file and would have failed the check on exactly one – VS Code's self-hosted runners for pull requests.

## Install the app

Install [Actions Guard](https://github.com/apps/actions-guard) on the repositories you want reviewed. It needs:

| Permission    | Access | Why                                                        |
| ------------- | ------ | ---------------------------------------------------------- |
| Contents      | read   | read the workflow files of the base and head commits       |
| Pull requests | write  | list the changed files and keep the review comment current |
| Checks        | write  | report the result as a check run with annotations          |
| Metadata      | read   | required by GitHub for every app                           |

It subscribes to one event: `pull_request`.

## Self-host

Run your own instance – on Vercel, in Docker or with plain Node.js.

**1. Register your app.** This opens GitHub with everything filled in; confirm the name and GitHub sends the credentials back to `.env`:

```bash
npx actions-guard setup --webhook-url https://your-host.example/api/webhook
# --org my-org registers it for an organization, --name picks another name
```

**2. Deploy.** The webhook lives at `/api/webhook`.

- **Vercel:** import the repository, set `APP_ID`, `WEBHOOK_SECRET` and `PRIVATE_KEY` (the PEM; newlines may be written as `\n`). `vercel.json` builds it and serves `api/webhook.js`.
- **Docker:** `docker build -t actions-guard . && docker run -p 3000:3000 --env-file .env -v "$PWD/actions-guard.private-key.pem:/app/key.pem" -e PRIVATE_KEY_PATH=/app/key.pem actions-guard`
- **Node.js ≥ 20:** `npm ci && npm run build && node --env-file=.env dist/main.js`

**3. Install** it from the link `setup` printed.

## Command line

The same rules, for a local check or any CI:

```bash
npx actions-guard .github/workflows/*.yml
npx actions-guard --base old.yml new.yml     # only what new.yml adds
npx actions-guard --fail-on medium --json .github/workflows/*.yml
```

It exits 1 when a finding reaches `--fail-on` (default `high`), 2 on a usage error.

## Settings

Optional, in `.github/actions-guard.yml` on the default branch. The app reads it from the **base** of each pull request, so a pull request can't relax its own review.

```yaml
fail_on: high # critical, high, medium, low or never
ignore: [curl-pipe-shell] # rules to skip
allow_unpinned: # may use a tag instead of a SHA (default: actions/*, github/*)
  - actions/*
  - github/*
  - my-org/*
```

## Permissions and privacy

Actions Guard reads workflow files and the list of changed files of the pull requests it is installed on. Nothing is stored: each webhook is handled in memory and forgotten, and the only things it writes are the check run and its comment. There are no analytics. Details: [privacy](https://maximilianfeix.github.io/actions-guard/#privacy). Security issues: see [SECURITY.md](SECURITY.md).

## Development

```bash
npm ci
npm test            # vitest
npm run coverage    # fails below 90 % lines / 85 % branches
npm run check       # format, types, coverage, build
npm run smoke       # the Vercel function answers a signed ping
```

Everything runs offline: GitHub is replaced by an in-memory fake (`tests/fake-github.ts`) and a recording `fetch`, and the app signs in with a key generated in the test.

## Support

Questions and bugs: [open an issue](https://github.com/maximilianfeix/actions-guard/issues) or write to [contact@aquaris.dev](mailto:contact@aquaris.dev).

## License

[MIT](LICENSE)
