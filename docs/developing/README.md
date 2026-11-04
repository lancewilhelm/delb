# Develop Delb

Read the [architecture](architecture.md), [data model](data-model.md), and [core request flows](core-workflows.md) before changing a workflow. Use the [glossary](../../GLOSSARY.md) for product terminology.

Use the [feature reference](reference/README.md) for contracts and the [UI component reference](ui/README.md) for presentation details. Past design discussions and investigations live in the [archive](../archive/README.md).

## Set up a local checkout

Use a Node version allowed by [`package.json`](../../package.json), such as Node 22.22.3, and the pinned pnpm version, currently 12.10.1.

```sh
pnpm install --frozen-lockfile
pnpm prepare:nuxt
pnpm --filter @delb/epub build
pnpm db:migrate
pnpm dev
```

Open `http://localhost:3000`. The database defaults to `data/delb.db`; managed files use `library/`. On the first visit, register an account. This creates local application data, so use a dedicated checkout when you need a disposable environment.

Generate and commit SQL migrations with `pnpm db:generate` when changing the schema. Apply committed migrations with `pnpm db:migrate`. `pnpm db:push` changes a database directly and is not the documented upgrade path for an existing deployment.

## Run the synthetic demo

Use a fresh dedicated checkout with no `.env` files, existing demo database, or real data in `data`, `library`, `dropbox`, or `calibre`. Setup refuses those conditions. Keep your normal installation in its own checkout.

From your usual Delb checkout:

```sh
git worktree add --detach ../delb-docs-demo HEAD
cd ../delb-docs-demo
pnpm install --frozen-lockfile
pnpm prepare:nuxt
pnpm --filter @delb/epub build
node review/setup-demo.mjs
node review/start-demo.mjs
```

Open `http://127.0.0.1:4317` and register a synthetic account. Upload `review/demo/ordinary.epub` to exercise the reader. Use invented names and `example.invalid` email addresses for additional accounts.

Setup creates the migrated `review/demo/synthetic.db`, disables Dropbox ingestion, and generates an ordinary two-chapter EPUB. The launcher supplies an ephemeral test auth secret, blocks outbound connections in the app process, and binds loopback. Metadata-provider searches therefore cannot be verified live in this demo.

Stop the launcher with Ctrl+C when finished. Reuse this demo for manual exploration. Automated smoke setup assumes a fresh fixture and creates fixed synthetic accounts, so use a fresh demo checkout for a new smoke run.

If that demo checkout already exists, enter it and run `node review/start-demo.mjs` to resume manual exploration. Do not rerun setup over its existing synthetic database.

In a second terminal at the same checkout:

```sh
node review/http-smoke.mjs
```

The smoke verifies guest rejection, registration, upload, listing, Personal collection access, and download authorization/filenames. It is API evidence; it does not exercise every UI control. [The review setup](../../review/README.md#cloud-or-local-setup) has additional fixtures and their limits.

## Check a change

Run the checks appropriate to the changed behavior:

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:integration
```

Integration checks use disposable fixtures. Keep synthetic/offline checks distinct from a live provider, container, filesystem, or device test. Document the actual evidence and remaining gaps in the PR.

For documentation-only changes:

```sh
pnpm docs:check
```

This checks local inline Markdown targets and heading anchors in the root README, glossary, and docs. Follow the changed procedures in the synthetic demo and record the result in [documentation status](documentation-status.md).

## Keep docs aligned with behavior

Update the user guide and backend explanation together when a user-visible workflow changes. Put exact options and contracts in a reference page and link it from the guide. Record unresolved disagreements without silently choosing a new product policy.

Keep historical evidence dated and separate from current instructions. Update the [feature map](architecture.md#feature-map) and [verification record](documentation-status.md) when a feature becomes documented or exercised. Write an architecture decision record only when a real decision has sufficient rationale to preserve.
