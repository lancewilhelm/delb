import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { assertNoEnvironmentFiles } from './isolation.mjs';

await assertNoEnvironmentFiles();
if (
  (await readFile('review/demo/.synthetic-review', 'utf8')).trim() !==
  'synthetic-delb-review'
) {
  throw new Error('Run review/setup-demo.mjs in a fresh checkout first');
}

const goBin = process.env.DELB_GO_BIN || path.resolve('bin/delb');
if (!existsSync(goBin)) {
  throw new Error(`Standalone Go binary not found at ${goBin}. Run \`pnpm build\` first.`);
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
  LOG_LEVEL: 'warn',
  HOST: host,
  PORT: port,
  NODE_ENV: 'production',
};
const child = spawn(goBin, [], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 1));
