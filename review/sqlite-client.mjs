import { DatabaseSync } from 'node:sqlite';

function toSqlitePath(url) {
  if (!url || url === ':memory:') return ':memory:';
  if (url.startsWith('file:')) {
    return url.slice('file:'.length);
  }
  return url;
}

function normalizeArgs(args) {
  if (!args) return [];
  return args.map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (v instanceof Date) return v.getTime();
    return v;
  });
}

function attachIndexAccess(row) {
  if (!row || typeof row !== 'object') return row;
  const values = Object.values(row);
  for (let i = 0; i < values.length; i++) {
    if (!(i in row)) {
      Object.defineProperty(row, i, {
        value: values[i],
        enumerable: false,
        configurable: true,
      });
    }
  }
  return row;
}

export function createClient({ url }) {
  const db = new DatabaseSync(toSqlitePath(url));
  db.exec('PRAGMA busy_timeout = 5000;');

  return {
    async execute(input) {
      const sql = typeof input === 'string' ? input : input.sql;
      const args = normalizeArgs(typeof input === 'string' ? [] : input.args);
      const stmt = db.prepare(sql);
      const isQuery =
        /^\s*(?:SELECT|PRAGMA|WITH|EXPLAIN)\b/i.test(sql) ||
        /\bRETURNING\b/i.test(sql);
      if (isQuery) {
        const rows = stmt.all(...args).map(attachIndexAccess);
        return { rows, rowsAffected: 0 };
      }
      const res = stmt.run(...args);
      return {
        rows: [],
        rowsAffected: Number(res.changes ?? 0),
        lastInsertRowid: res.lastInsertRowid,
      };
    },
    async executeMultiple(sql) {
      db.exec(sql);
    },
    close() {
      db.close();
    },
  };
}
