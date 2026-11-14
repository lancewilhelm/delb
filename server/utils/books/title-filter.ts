import { sql, type SQLWrapper } from 'drizzle-orm';

export function titleFilter(column: SQLWrapper, title: string) {
  if (!title) return undefined;
  const escape = (value: string) =>
    value.replace(/[[\]*?]/g, (char) => `[${char === '[' ? '[' : char}]`);
  const pattern = Array.from(title)
    .map((char) => {
      const forms = [
        ...new Set([char, char.toLowerCase(), char.toUpperCase()]),
      ];
      return forms.length > 1 &&
        forms.every((form) => Array.from(form).length === 1)
        ? `[${forms.join('')}]`
        : escape(char);
    })
    .join('');
  return sql`${column} GLOB ${`*${pattern}*`}`;
}
