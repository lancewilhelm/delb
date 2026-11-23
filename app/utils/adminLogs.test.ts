import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAdminLogsDownloadUrl,
  buildAdminLogsQueryParams,
  extractAttachmentFilename,
  formatByteSize,
  formatLogAttrsPreview,
  normalizeLogLevel,
} from './adminLogs.ts';

test('normalizeLogLevel maps level aliases to canonical levels', () => {
  assert.equal(normalizeLogLevel('DEBUG'), 'debug');
  assert.equal(normalizeLogLevel('trace'), 'debug');
  assert.equal(normalizeLogLevel('warning'), 'warn');
  assert.equal(normalizeLogLevel('FATAL'), 'error');
  assert.equal(normalizeLogLevel('unknown'), 'info');
});

test('buildAdminLogsQueryParams handles exact level, minLevel, and filters', () => {
  const exact = buildAdminLogsQueryParams({
    levelFilter: 'error',
    component: 'auth',
    requestId: 'req-42',
    q: 'rate limit',
    limit: 100,
    offset: 50,
    order: 'desc',
  });
  assert.equal(exact.get('level'), 'error');
  assert.equal(exact.get('minLevel'), null);
  assert.equal(exact.get('component'), 'auth');
  assert.equal(exact.get('requestId'), 'req-42');
  assert.equal(exact.get('q'), 'rate limit');
  assert.equal(exact.get('limit'), '100');
  assert.equal(exact.get('offset'), '50');
  assert.equal(exact.get('order'), 'desc');

  const minLvl = buildAdminLogsQueryParams({
    levelFilter: 'warn+',
    component: '',
    requestId: '',
    q: '',
  });
  assert.equal(minLvl.get('level'), null);
  assert.equal(minLvl.get('minLevel'), 'warn');
});

test('buildAdminLogsDownloadUrl scopes query params properly', () => {
  const filters = {
    levelFilter: 'error' as const,
    component: 'books',
    requestId: '',
    q: 'cover',
  };

  const allUrl = buildAdminLogsDownloadUrl('text', 'all', filters);
  assert.equal(
    allUrl,
    '/api/settings/admin/logs/download?format=text&scope=all',
  );

  const filteredUrl = buildAdminLogsDownloadUrl('jsonl', 'filtered', filters);
  assert.equal(
    filteredUrl,
    '/api/settings/admin/logs/download?level=error&component=books&q=cover&format=jsonl&scope=filtered',
  );
});

test('formatByteSize formats human readable byte sizes', () => {
  assert.equal(formatByteSize(0), '0 B');
  assert.equal(formatByteSize(512), '512 B');
  assert.equal(formatByteSize(1536), '1.5 KB');
  assert.equal(formatByteSize(5 * 1024 * 1024), '5.0 MB');
});

test('formatLogAttrsPreview renders compact summary omitting stack', () => {
  const preview = formatLogAttrsPreview({
    method: 'POST',
    path: '/api/books',
    status: 500,
    stack: 'goroutine 1 ...',
  });
  assert.equal(preview, 'method=POST path=/api/books status=500');
});

test('extractAttachmentFilename extracts quoted filename or returns fallback', () => {
  assert.equal(
    extractAttachmentFilename(
      'attachment; filename="delb-logs-20261123-093000.log"',
      'fallback.log',
    ),
    'delb-logs-20261123-093000.log',
  );
  assert.equal(extractAttachmentFilename(null, 'fallback.log'), 'fallback.log');
});
