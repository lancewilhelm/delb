# Audit repair plan

Base: `ba80f27ff4da998d712bf25aaf0455a3b59a9c6f`. The audit baseline is included in this revision. The intervening README license change is preserved.

Done means every A01 through A37 finding has a repair or evidence-backed disposition, critical regressions are exercised with disposable data, tests/lint/typecheck/build pass, independent review findings are resolved, and a pull request is open for human review. No merge or deployment is part of this run.

## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [x] Phase C: Run the loop.
- [x] Phase D: Keep the audit trail.
- [x] Phase E: Verify and hand back.

## Work units

1. Compare two grounded invariant designs and select the smallest safe interfaces.
2. Repair book visibility and owner/membership guards.
3. Preserve originals across file moves, replacement, ingest, deletion and recovery.
4. Repair atomic metadata, rating/cursor/status contracts.
5. Repair reader isolation, persistence, request ownership, settings and keyboard access.
6. Repair remote content confinement, parser limits, dependencies, runtime and CI.
7. Bound entity queries and update operational documentation.
8. Run full checks, disposable API/browser regressions and independent diff review.
9. Commit ordered units, push, create and attach the PR.

Throughput checkpoint: independent workers own separate worktrees and files. Integrate verified commits sequentially. If a unit introduces a failure, repair it before stacking dependent work. The audit status table below will distinguish implemented, verified and unresolved conditions.

## Design decision

Use domain-owned visibility, status and storage operations. Two grounded candidates converged on this approach; an independent judge selected the design that hides recovery phases behind book operations. Retain all ambiguous recovery data. Store authoritative operation decisions in SQLite in the same transaction as record changes. Use persistent per-book SQLite lock files and hold a write transaction for active mutations. The operating system releases ownership on process exit, including container recreation. Do not expire a live writer by elapsed time. SQLite file locking must work on the library filesystem; arbitrary network-filesystem writers remain unverified.

Storage operations use `storage_operations(id, book_id, kind, created_at)` as a durable decision record. System bootstrap uses `system_state(key, value)` to remember completed initialization. Migration 0003 adds both tables. Migration 0004 adds reader request ordering columns. Migration 0005 converts user settings revisions to milliseconds. The integration lead owns the shared migrations. Existing book layout and verified-copy fallback stay intact.

## Throughput checkpoint

- Blocking first steps. Audit baseline, design comparison, shared schema and isolated dependency install precede implementation.
- Independent workstreams. Server rules, storage lifecycle and client state use separate worktrees. The integration lead owns dependencies, transport and CI.
- Shared mutable state. Only the lead writes the migration and shared package/CI files. Workers own disjoint route families; overlaps integrate sequentially.
- Smallest safe decomposition. Each worker keeps coupled behavior together and returns tested commits. Integration checks run before later dependent units.

## Finding status

| Finding | Status                                             | Evidence                                                                                                                                  |
| ------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| A01     | Repaired; live API                                 | Foreign bulk and single assignment denied; legitimate re-sharing preserved.                                                               |
| A02     | Repaired; live API                                 | Duplicate candidates require caller visibility; private UUID cannot be introduced.                                                        |
| A03     | Repaired; live browser                             | Uploaded script-marker EPUB cannot access parent in pages or scroll mode.                                                                 |
| A04     | Repaired; automated and restart                    | Move fault/collision tests retain originals; actual startup preserves differing partial copy.                                             |
| A05     | Repaired; automated                                | Replacement stages unique bytes, retains book ID and relationships, and journals retirement.                                              |
| A06     | Repaired; automated                                | Failed Dropbox commit preserves input; durable claim decisions reconcile retries.                                                         |
| A07     | Repaired with residual low advisory                | Frozen install and advisory scan reduce 47 advisories to one low deepmerge tooling advisory with no patch.                                |
| A08     | Repaired; static and local runtime                 | Docker, CI and engines align on supported Node; local checks run Node 22.22.3.                                                            |
| A09     | Repaired; live API                                 | Editor cannot demote owner; authorized manager lookup occurs first.                                                                       |
| A10     | Repaired; real transport tests                     | Connection uses validated selected IP; DNS redirects, mapped/private addresses and deadlines checked.                                     |
| A11     | Repaired; live API                                 | Search/entity details scope metadata to visible books.                                                                                    |
| A12     | Repaired; live API                                 | Injected link failure rolls back metadata; normalized author/tag identities deduplicate.                                                  |
| A13     | Repaired; live API and automated                   | Import is atomic; create journals preserve staged upload inputs on failure.                                                               |
| A14     | Repaired; automated                                | Per-book cross-process lock excludes live recovery; cover commit decision handles same-path updates.                                      |
| A15     | Repaired; automated                                | Delete journal stages files, commits rows atomically, then finalizes owned paths.                                                         |
| A16     | Repaired; automated                                | Restart reconciles Dropbox processing claims using durable commit IDs.                                                                    |
| A17     | Repaired; automated                                | Failed destinations are unique and exclusive; colliding payloads survive.                                                                 |
| A18     | Repaired; live API                                 | Half-star values 1 through 10 and clear round-trip without reinterpretation.                                                              |
| A19     | Repaired; live API                                 | Seconds-based cursors traverse ascending/descending dates, ties and nulls.                                                                |
| A20     | Repaired; live API                                 | Concurrent single/bulk status transitions use transactional upserts.                                                                      |
| A21     | Repaired; live API                                 | Shared transition normalizes ranks through bulk/single/clear.                                                                             |
| A22     | Repaired; source execution tests                   | Grid/list request generations reject old successes, errors and finalizers.                                                                |
| A23     | Repaired; live browser and automated               | Rapid exit saves exact displayed CFI; same-session sequence rejects late older requests.                                                  |
| A24     | Repaired; source execution tests                   | Delayed generation reconciles current location; absent computed percentage preserves saved percentage.                                    |
| A25     | Repaired; source execution tests                   | Deferred pull retains local edits; millisecond revisions, persisted reloads, rejected-write rebase and delayed GET guards preserve edits. |
| A26     | Repaired; static and source tests                  | Signout/account switch reset filters and persisted key.                                                                                   |
| A27     | Repaired; live keyboard; assistive tech unverified | Named native controls; search/palette selected IDs and focus containment; no screen-reader run.                                           |
| A28     | Repaired; source execution tests                   | Search invalidates immediately on query change/close and ignores stale completion.                                                        |
| A29     | Repaired; source execution tests                   | Provider results settle separately and retain successful responses.                                                                       |
| A30     | Repaired; automated                                | Calibre realpath confinement rejects traversal, absolute and symlink escapes.                                                             |
| A31     | Repaired; live API                                 | Owner deletion/demotion denied on both surfaces; concurrent bootstrap runs once durably.                                                  |
| A32     | Repaired; live API                                 | Nonmanager known/unknown email probes have equivalent authorization result.                                                               |
| A33     | Repaired; live API                                 | Foreign rating writes fail before existence disclosure.                                                                                   |
| A34     | Repaired; local checks and static CI               | Recursive full test runner; explicit prepare; aligned plugins; publishing needs reusable verification.                                    |
| A35     | Repaired; static; Docker unverified                | Context excludes env, Calibre, runtime/review data and public fixture link.                                                               |
| A36     | Repaired; automated; production scale unmeasured   | SQL pagination and preview caps; accented/literal searches; saved All preference retained.                                                |
| A37     | Repaired; local setup                              | Supported Node, frozen install, prepare, EPUB build, migrations and dev/production commands documented.                                   |
| R01     | Mitigated; automated transport                     | Reject SVG/spoof; decode/re-encode allowed raster, CSP and nosniff.                                                                       |
| R02     | Mitigated; real HTTP and archive tests             | Oversize/stalled HTTP rejected before EOF; ZIP entry/inflated sizes, pixel and byte bounds checked.                                       |

Detailed coverage, runnable checks and remaining limits are in [repair-verification.md](repair-verification.md). Storage operations and deployment cautions are in [storage-recovery.md](../../../docs/storage-recovery.md).
