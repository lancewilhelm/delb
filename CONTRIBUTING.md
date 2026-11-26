# Contributing to Delb

Thanks for your interest in Delb. This page explains how to propose a change and what a pull request needs before it can merge.

## Before you start

- **Bugs:** open an issue with the bug report template. Include the steps to reproduce it and the Delb version.
- **Features:** open an issue with the feature request template before you write code. Small fixes can go straight to a pull request, but larger changes should be agreed on first so that your work isn't wasted.
- **Security problems:** do not open a public issue. Report them privately with **Report a vulnerability** on the repository's Security tab.

## Set up and check your work

The [contributor guide](docs/developing/README.md) covers local setup, the synthetic demo, and the checks to run. Read the [architecture](docs/developing/architecture.md) and [data model](docs/developing/data-model.md) before changing a workflow.

Every pull request must pass the same checks that CI runs:

```sh
pnpm docs:check
pnpm test
pnpm typecheck
pnpm lint
pnpm build
go vet ./...
go test -count=1 ./...
pnpm test:integration
```

## Open a pull request

1. Create a branch from `main` with a prefix such as `feat/`, `fix/`, or `docs/`.
2. Write commit subjects in [Conventional Commits](https://www.conventionalcommits.org/) form, such as `feat: add a finish-date filter`.
3. Update the documentation in the same pull request when user-visible behavior changes. The contributor guide explains [how docs stay aligned with behavior](docs/developing/README.md#keep-docs-aligned-with-behavior).
4. Fill in the pull request template, including the manual verification section.
5. Use a pull request title that describes the change. GitHub uses that title in the release notes. Apply `enhancement`, `bug`, or `documentation` where it fits.

See [Publish a release](docs/developing/releasing.md) for the release checklist.

## Manual verification

Automated checks do not show that a feature works the way a reader would use it. Every pull request therefore describes a manual check of the changed behavior. For example, you might use the feature in the synthetic demo, try it on a phone, or call an endpoint and inspect the response. Name what you checked and what you saw. If something could not be checked, say so.

Use only synthetic data. Screenshots and logs must not show a real library, real account details, or API keys.

## Coding agents

You may use AI coding agents, and you don't need to disclose it. You are still responsible for the change. Read the code before you submit it, and do the manual verification yourself. [AGENTS.md](AGENTS.md) gives agents the repository's commands and rules, and `CLAUDE.md` imports it for Claude Code.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
