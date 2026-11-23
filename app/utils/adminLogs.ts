export type AdminLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type AdminLogLevelFilter =
  | ''
  | 'debug'
  | 'info'
  | 'warn'
  | 'error'
  | 'info+'
  | 'warn+';

export type AdminLogDownloadFormat = 'text' | 'jsonl';
export type AdminLogDownloadScope = 'all' | 'filtered';

export interface AdminLogEntry {
  id: number;
  time: string;
  level: AdminLogLevel;
  message: string;
  component?: string;
  requestId?: string;
  attrs?: Record<string, unknown>;
}

export interface AdminLogStorageInfo {
  enabled: boolean;
  dir?: string;
  fileCount: number;
  totalBytes: number;
  maxFileBytes: number;
  maxFiles: number;
  maxTotalBytes: number;
  memoryEntries: number;
  memoryCapacity: number;
}

export interface AdminLogsQueryResult {
  entries: AdminLogEntry[];
  total: number;
  hasMore: boolean;
  limit: number;
  offset: number;
  components: string[];
  level: AdminLogLevel;
  storage: AdminLogStorageInfo;
}

export interface AdminLogsFilterState {
  levelFilter: AdminLogLevelFilter;
  component: string;
  requestId: string;
  q: string;
  limit?: number;
  offset?: number;
  order?: 'desc' | 'asc';
}

export function normalizeLogLevel(raw: string): AdminLogLevel {
  const lower = String(raw || '')
    .trim()
    .toLowerCase();
  if (lower === 'debug' || lower === 'trace') return 'debug';
  if (lower === 'warn' || lower === 'warning') return 'warn';
  if (lower === 'error' || lower === 'fatal') return 'error';
  return 'info';
}

export function buildAdminLogsQueryParams(
  filters: AdminLogsFilterState,
): URLSearchParams {
  const params = new URLSearchParams();
  const levelFilter = filters.levelFilter?.trim() || '';
  if (levelFilter === 'info+') {
    params.set('minLevel', 'info');
  } else if (levelFilter === 'warn+') {
    params.set('minLevel', 'warn');
  } else if (levelFilter) {
    params.set('level', levelFilter);
  }

  const component = filters.component?.trim();
  if (component) {
    params.set('component', component);
  }

  const requestId = filters.requestId?.trim();
  if (requestId) {
    params.set('requestId', requestId);
  }

  const q = filters.q?.trim();
  if (q) {
    params.set('q', q);
  }

  if (typeof filters.limit === 'number' && filters.limit > 0) {
    params.set('limit', String(filters.limit));
  }
  if (typeof filters.offset === 'number' && filters.offset > 0) {
    params.set('offset', String(filters.offset));
  }
  if (filters.order) {
    params.set('order', filters.order);
  }

  return params;
}

export function buildAdminLogsDownloadUrl(
  format: AdminLogDownloadFormat,
  scope: AdminLogDownloadScope,
  filters: AdminLogsFilterState,
): string {
  const params =
    scope === 'filtered'
      ? buildAdminLogsQueryParams({
          levelFilter: filters.levelFilter,
          component: filters.component,
          requestId: filters.requestId,
          q: filters.q,
        })
      : new URLSearchParams();

  params.set('format', format);
  params.set('scope', scope);
  return `/api/settings/admin/logs/download?${params.toString()}`;
}

export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx++;
  }
  return idx === 0 ? `${Math.round(val)} ${units[idx]}` : `${val.toFixed(1)} ${units[idx]}`;
}

export function formatLogTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

export function formatLogAttrsPreview(
  attrs?: Record<string, unknown>,
  maxItems = 4,
): string {
  if (!attrs) return '';
  const entries = Object.entries(attrs).filter(
    ([key]) => key !== 'stack' && key !== 'error',
  );
  if (entries.length === 0) {
    if (typeof attrs.error === 'string' && attrs.error) {
      return `error=${truncatePreview(attrs.error, 64)}`;
    }
    return '';
  }

  const parts: string[] = [];
  for (const [k, v] of entries.slice(0, maxItems)) {
    parts.push(`${k}=${formatInlineAttrValue(v)}`);
  }
  if (typeof attrs.error === 'string' && attrs.error && parts.length < maxItems) {
    parts.push(`error=${truncatePreview(attrs.error, 48)}`);
  }
  return parts.join(' ');
}

function formatInlineAttrValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'string') return truncatePreview(value, 36);
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return truncatePreview(JSON.stringify(value), 36);
  } catch {
    return String(value);
  }
}

function truncatePreview(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}…`;
}

export function extractAttachmentFilename(
  contentDisposition: string | null,
  fallback: string,
): string {
  if (!contentDisposition) return fallback;
  const match = contentDisposition.match(/filename="?([^";]+)"?/i);
  return match?.[1]?.trim() || fallback;
}
