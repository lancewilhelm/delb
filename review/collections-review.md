# Exclusive collection implementation review

Two independent reviewers inspected the changes from `e624c9f` through `f8f8afa`. The Spec review used the accepted ADR at `e4fbd4f`, before implementation edits. The implementation agent addressed the findings below; verification after those fixes is recorded separately in [documentation status](../docs/developing/documentation-status.md#exclusive-collections-2026-11-05).

## Standards

- **P2, type boundary:** The migration trusted every SQL row as a generic record, then coerced IDs and paths to strings. This breached the loaded TypeScript and type-system standards for database boundaries. Snapshot reads now validate every field against authoritative schema metadata and expose named table-row types. A malformed legacy path test stops preview before changes.
- **P3, Duplicated Code, judgment call:** Copy creation and original-entry assignment independently selected the retained collection. Both stages now consume one resolved assignment per book. Existing split, Calibre mapping, file-copy, and TBR assertions remain in place.

No other material documented-standard breaches were identified. The second finding was a maintainability risk rather than an observed failure.

## Spec

- **P2, Dropbox recovery:** A claimed file could resolve a new target after restart, contradicting “Retain that destination throughout the batch” and “Do not silently redirect.” Each claim now persists its importing user and destination before renaming. Recovery uses that destination and rechecks authority; an unknown plan stops for review. Unit checks and a running local watcher cover changed configuration, preserved bytes, missing plans, and denied destinations.
- **P2, Calibre rescans:** Existing mapped entries skipped rechecking the batch destination, contradicting the requirement to stop when that target disappears or loses access. Every iteration now checks the retained batch target as well as the mapped entry. A database-triggered mid-batch revocation verifies that later entries remain unchanged.

No scope creep was identified. These checks use synthetic local data, not a real library or remote storage.

Findings: Standards 2 (one P2 boundary breach and one P3 judgment); Spec 2 (both P2 import-target failures). All four were addressed; there was no additional independent review of the fixes.
