import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readFile, mkdir } from 'node:fs/promises';
import { assertNoEnvironmentFiles } from './isolation.mjs';
await assertNoEnvironmentFiles();
if (
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim() !==
  'synthetic-delb-review'
) {
  throw new Error('Run review/setup-demo.mjs in a fresh checkout first');
}
await mkdir('.review-home', { recursive: true });
const env = {
  PATH: process.env.PATH,
  HOME: path.resolve('.review-home'),
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  DATABASE_URL: 'file:./review/demo/synthetic.db',
  BETTER_AUTH_URL: 'http://127.0.0.1:4317',
  BETTER_AUTH_TRUSTED_ORIGINS: 'http://127.0.0.1:4317',
  NUXT_TELEMETRY_DISABLED: '1',
  NODE_OPTIONS: '--require ' + path.resolve('review/deny-outbound.cjs'),
  LOG_LEVEL: 'warn',
};
const child = spawn(
  process.execPath,
  [
    'node_modules/nuxt/bin/nuxt.mjs',
    'dev',
    '--host',
    '127.0.0.1',
    '--port',
    '4317',
  ],
  { env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
