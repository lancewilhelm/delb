/**
 * Legacy sync debounce helper.
 *
 * Settings sync is now intentionally lightweight:
 * - pull settings once on app load (when logged in)
 * - push settings only when they change (in the settings stores)
 *
 * This file is kept as a no-op placeholder to avoid build breaks in case
 * older code or downstream templates still import it.
 */

export const triggerDebouncedSync = () => {};
