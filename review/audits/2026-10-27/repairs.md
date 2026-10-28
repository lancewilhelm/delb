# Audit repair plan

Base: `ba80f27ff4da998d712bf25aaf0455a3b59a9c6f`. The audit baseline is included in this revision. The intervening README license change is preserved.

Done means every A01 through A37 finding has a repair or evidence-backed disposition, critical regressions are exercised with disposable data, tests/lint/typecheck/build pass, independent review findings are resolved, and a pull request is open for human review. No merge or deployment is part of this run.

## Workflow

- [x] Read the Principles section of poteto-mode.
- [x] Phase A: Frame.
- [x] Phase B: Design the workflow.
- [ ] Phase C: Run the loop.
- [ ] Phase D: Keep the audit trail.
- [ ] Phase E: Verify and hand back.

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

Use domain-owned visibility, status and storage operations. Two grounded candidates converged on this approach; an independent judge selected the design that hides recovery phases behind book operations. Retain all ambiguous recovery data. Store authoritative operation decisions in SQLite in the same transaction as record changes. Use exclusive filesystem ownership for active book mutations, with same-host dead-process recovery and fail-closed ownership on another host. Do not expire a live writer by elapsed time. This supports one host's processes; shared-library multi-host writers are refused rather than assumed safe.

Storage operations use `storage_operations(id, book_id, kind, created_at)` as a durable decision record. System bootstrap uses `system_state(key, value)` to remember completed initialization. Both have one migration, owned by the integration lead. Existing book layout and verified-copy fallback stay intact.

## Throughput checkpoint

- Blocking first steps. Audit baseline, design comparison, shared schema and isolated dependency install precede implementation.
- Independent workstreams. Server rules, storage lifecycle and client state use separate worktrees. The integration lead owns dependencies, transport and CI.
- Shared mutable state. Only the lead writes the migration and shared package/CI files. Workers own disjoint route families; overlaps integrate sequentially.
- Smallest safe decomposition. Each worker keeps coupled behavior together and returns tested commits. Integration checks run before later dependent units.

## Finding status

| Finding | Status                          | Evidence |
| ------- | ------------------------------- | -------- |
| A01     | Pending                         |          |
| A02     | Pending                         |          |
| A03     | Pending                         |          |
| A04     | Pending                         |          |
| A05     | Pending                         |          |
| A06     | Pending                         |          |
| A07     | Pending                         |          |
| A08     | Pending                         |          |
| A09     | Pending                         |          |
| A10     | Pending                         |          |
| A11     | Pending                         |          |
| A12     | Pending                         |          |
| A13     | Pending                         |          |
| A14     | Pending                         |          |
| A15     | Pending                         |          |
| A16     | Pending                         |          |
| A17     | Pending                         |          |
| A18     | Pending                         |          |
| A19     | Pending                         |          |
| A20     | Pending                         |          |
| A21     | Pending                         |          |
| A22     | Pending                         |          |
| A23     | Pending                         |          |
| A24     | Pending                         |          |
| A25     | Pending                         |          |
| A26     | Pending                         |          |
| A27     | Pending                         |          |
| A28     | Pending                         |          |
| A29     | Pending                         |          |
| A30     | Pending                         |          |
| A31     | Pending                         |          |
| A32     | Pending                         |          |
| A33     | Pending                         |          |
| A34     | Pending                         |          |
| A35     | Pending                         |          |
| A36     | Pending                         |          |
| A37     | Pending                         |          |
| R01     | Pending verification and repair |          |
| R02     | Pending bounded resource checks |          |
