/**
 * Server roles. `owner` is the system owner: an admin whose role cannot be
 * changed. Admins manage users and settings, editors (and admins) can change
 * the shared catalog, and readers are read-only on the catalog.
 */
export type ServerRole = 'owner' | 'admin' | 'editor' | 'reader';

/** Roles that an admin can assign to another account. */
export type AssignableRole = Exclude<ServerRole, 'owner'>;

export const ASSIGNABLE_ROLES: readonly {
  value: AssignableRole;
  label: string;
}[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'editor', label: 'Editor' },
  { value: 'reader', label: 'Reader' },
];

export const DEFAULT_ASSIGNABLE_ROLE: AssignableRole = 'reader';

/** Normalizes a role string from the API. Unknown values become `reader`. */
export function normalizeRole(role: string | null | undefined): ServerRole {
  switch (role) {
    case 'owner':
    case 'admin':
    case 'editor':
    case 'reader':
      return role;
    default:
      return 'reader';
  }
}

/** Owners and admins manage users, tag visibility rules, and settings. */
export function roleIsAdmin(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** Owners, admins, and editors can add books and edit the shared catalog. */
export function roleCanEditCatalog(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin' || role === 'editor';
}

/** The role that the admin user editor should select for an account. */
export function editableRole(role: string | null | undefined): AssignableRole {
  const normalized = normalizeRole(role);
  return normalized === 'owner' ? 'admin' : normalized;
}

/** Tag visibility rules apply only to editor and reader accounts. */
export function roleUsesTagRules(role: string | null | undefined): boolean {
  return !roleIsAdmin(role);
}

export function roleLabel(role: string | null | undefined): string {
  const normalized = normalizeRole(role);
  if (normalized === 'owner') return 'Owner';
  return (
    ASSIGNABLE_ROLES.find((option) => option.value === normalized)?.label ??
    'Reader'
  );
}
