# Contributing

Thanks for helping! Bug reports, false positives and new rules are all welcome.

```bash
npm ci
npm run check   # format, types, tests with coverage, build
```

- **False positive or missed risk?** Open an issue with the smallest workflow that shows it.
- **New rule:** add it to `src/rules.ts` with a `key` that doesn't contain line numbers (that's how pull requests are compared), tests in `tests/analyze.test.ts` that fail without it, and a section with the same anchor in `docs/index.html`.
- Tests run offline – GitHub is the in-memory fake in `tests/fake-github.ts`.
- Coverage must stay above the thresholds in `vitest.config.ts`.
