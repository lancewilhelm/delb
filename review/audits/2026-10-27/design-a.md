# Candidate A: repair invariants at existing domain boundaries

## Problem
Nuxt handlers mix authorization, DB mutations and filesystem operations. The existing collection-membership model intentionally permits resharing after visibility; personal collections have stronger removal rules. Storage runs on Unraid, where EUCLEAN/EXDEV rename requires the existing hash-verified copy fallback. A database transaction cannot atomically commit filesystem changes. The design retains existing handlers and cover journal rather than introducing a generic transaction framework.

## Usage (caller's view)
```ts
// Existing single and bulk collection assignment endpoints
const visible = await requireVisibleBooks(tx, userId, requestedBookIds); // invisible/nonexistent: same 404 or documented bulk omission
await assignVisibleBooks(tx, { userId, bookIds: visible, add, remove }); // validates roles and personal guard inside same transaction

// Existing upload, replacement, delete, canonical move handlers
await withBookMutation(bookId, async () => {
  await recoverBookOperations(bookId); // only abandoned operations under same book lock
  return replaceBookFile({ bookId, stagedFile, commit: async tx => updateFileRow(tx) });
});

// Single and bulk status handlers
const result = await transitionStatuses(userId, [{ bookId, status, rank }]);
```

## Shape and ownership
- `server/utils/books/visibility.ts`: `visibleBookIds(db, userId, ids)` and `requireVisibleBooks(...)` use membership join; result is a visible-ID set, not global duplicate matches. Filter all entity search and duplicate results through the same visibility predicate. Gate introductions on visibility *before* adding, and target collection edit rights, within one transaction; keep legitimate reshare and personal rules. Authorize membership management before user lookup; return indistinguishable unknown/invisible results. Protect collection/system owner transitions at both delete surfaces, with durable bootstrap completion and explicit transfer semantics.
- `server/utils/books/storage/` owns per-book mutation coordination and operations, building on existing `cover-update-transaction.ts`, not replacing its rename-first, exclusive copy, sync, size/hash verification, or retained recovery journals. Suggested domain shape: `Operation = {id, bookId, kind: 'move'|'replace'|'delete'|'ingest', phase: 'prepared'|'db-committed', entries: [{source, staged, target, backup, expectedHash}]}`. Validate all journal paths under allowed roots. Prepare and persist recoverable originals/staged bytes before DB changes; transactionally commit paths/membership plus durable operation identity; roll forward committed operations and roll back uncommitted operations idempotently. File cleanup is after commit and only when verified safe. Use exclusive destinations; same-path/collision is never assumed equivalent without size/hash comparison. Remove directories only if empty. A crash between DB commit and journal phase update requires authoritative DB operation marker, not path equality alone. Recovery uses the same per-book lock as mutation; process-local locks alone do not protect multi-process deployments, so use a DB-backed claim/lease with crash recovery or explicitly enforce one writer. No destructive cleanup if ambiguous; retain journal and report recovery failure.
- Dropbox claims have unique exclusive names and durable/recoverable owner/phase; startup reconciles abandoned claims without stealing active claims. Preserve original until DB commit; failed inputs get collision-resistant names and never overwrite. Create/import normalizes identifiers and DB relationships in one transaction; stage filesystem inputs and remove only after safe commit or leave recoverable journal. Delete stages recoverable files, commits related row removals, then finalizes. Failures are surfaced rather than silently swallowed.
- `server/utils/books/status-transition.ts`: `transitionStatuses(userId, changes: readonly {bookId:string; status: Status|null; rank?: number|null}[]): Promise<{updated:number; cleared:number}>`; load and update status rows within one SQLite write transaction, use actual upsert outcomes, preserve defined date behavior, derive unique contiguous TBR ranks on every single/bulk/clear path. Define deterministic order for bulk adds. Test overlapping transitions with real separate DB connections.
- UI request owners remain in existing components/composables: monotonically increasing generation and cancellation guard commits, errors and loading; a reset schedules a new request even if prior request is in flight. Reader has pending location flush on in-app navigation and generation version ownership; browser-close delivery is best effort. Settings pull applies only fields unchanged since pull began; account change resets persisted filters. Provider search uses independently settled results and scoped errors. Accessibility uses native controls and dialog/combobox semantics with focus restoration.
- `external-image.ts`: each redirect resolves and rejects forbidden IPs and connects to an approved resolved IP without a second DNS lookup, retaining original hostname for Host, TLS SNI and certificate checks. Enforce timeout, redirect, stream byte and decoded-pixel bounds; validate raster signatures or decode/re-encode; reject SVG and unknown active formats. Apply restrictive proxy response headers. Controlled DNS and actual socket tests must show rebinding cannot reach loopback/private addresses. Reader disables scripted content and isolates untrusted iframe origin/sandbox with both modes checked for EPUB compatibility; request and archive limits are enforced before allocation/extraction and tested with bounded fixtures.
- Narrow direct fixes: atomic metadata/link updates, half-star integer contract, cursor units, realpath-confined Calibre paths, bounded entity index, Node/toolchain/security triage, complete CI and same-revision publish gating, Docker ignore and onboarding. Avoid claiming measured performance without a baseline.

## Tradeoffs and alternatives
Accept a little durable operation metadata and recovery logic in exchange for preserving bytes across crash/DB failure; don't unify every filesystem operation into a general-purpose saga. A one-shot DB transaction with ad hoc filesystem cleanup exposes crash coordination and cannot provide atomicity. A global storage lock hides races but unnecessarily blocks unrelated books and still needs durable cross-process ownership. A global identity lookup followed by output filtering is unsafe for writes; visibility must constrain selection before mutation.

## Risks and next step
Can this deployment run more than one Nitro process or share a SQLite file across instances? Locking must cover the actual topology; leases need fencing and clock-safe abandonment rules. Can existing users recover an owner without reopening bootstrap? Define a deliberate operator recovery procedure and migration. Do not assume browser unload guarantees save delivery. First capture the two-account visibility and controlled storage fault regressions, then implement each boundary with restart tests.

## Partition into three worker seams
1. Authorization/DB domain: A01 A02 A09 A11 A12 A18 A19 A20 A21 A31 A32 A33; own shared visibility and status helpers, coordinate DB migration for bootstrap.
2. Storage: A04 A05 A06 A13 A14 A15 A16 A17 A30; own all journals/locks, file lifecycle and storage fault tests. Agree narrow transaction hook with worker 1 for create/import.
3. Client/transport/tooling: A03 A07 A08 A10 A22-A29 A34-A37 R01 R02; split serially within worker as needed, no changes to storage modules. Parent integrates and runs actual API/browser/CI and restart checks.
