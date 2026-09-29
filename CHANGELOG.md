# Changelog

## 0.1.0 – 2026-09-29

First release.

- GitHub App: checks pull requests that change `.github/workflows/*.yml` and reports only the risks they add, as a check run with annotations and one comment it keeps current
- Rules: `untrusted-checkout`, `script-injection`, `self-hosted-runner`, `excessive-permissions`, `unpinned-action`, `secrets-inherit`, `missing-permissions`, `curl-pipe-shell`
- Settings in `.github/actions-guard.yml`, read from the pull request's base
- `actions-guard` CLI for local checks and any CI, with `--base` to compare two versions
- `actions-guard setup` registers your own instance from a manifest and saves its credentials
- Runs on Vercel (`api/webhook.js`), in Docker or on Node.js
