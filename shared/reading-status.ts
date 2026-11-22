/**
 * Canonical, built-in per-user book statuses (v1).
 *
 * Notes:
 * - Stored as strings for forward compatibility with "custom statuses" later.
 * - API should validate against this list for now.
 * - UI copy should prefer human labels:
 *   - to_be_read => "To be read"
 *   - reading => "Reading"
 *   - finished => "Finished"
 *   - dnf => "DNF"
 */
export const USER_BOOK_STATUSES = [
  'to_be_read',
  'reading',
  'finished',
  'dnf',
] as const;

export type UserBookStatusValue = (typeof USER_BOOK_STATUSES)[number];
