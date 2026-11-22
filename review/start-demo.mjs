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
const host = process.env.DELB_REVIEW_HOST || '127.0.0.1';
const port = String(process.env.DELB_REVIEW_PORT || '4317');
const baseUrl = `http://${host}:${port}`;
const env = {
  PATH: process.env.PATH,
  HOME: path.resolve('.review-home'),
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  DATABASE_URL: 'file:./review/demo/synthetic.db',
  BETTER_AUTH_URL: baseUrl,
  BETTER_AUTH_TRUSTED_ORIGINS: baseUrl,
  NUXT_TELEMETRY_DISABLED: '1',
  NODE_OPTIONS:
    '--require ' +
    path.resolve('review/deny-outbound.cjs') +
    (process.argv.includes('--fake-codex')
      ? ' --require ' + path.resolve('review/fake-codex-provider.cjs')
      : ''),
  LOG_LEVEL: 'warn',
  NITRO_HOST: host,
  NITRO_PORT: port,
  NODE_ENV: process.argv.includes('--production')
    ? 'production'
    : 'development',
};
const child = spawn(
  process.execPath,
  process.argv.includes('--production')
    ? ['.output/server/index.mjs']
    : [
        'node_modules/nuxt/bin/nuxt.mjs',
        'dev',
        '--host',
        host,
        '--port',
        port,
      ],
  { env, stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
