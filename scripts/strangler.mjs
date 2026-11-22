import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const isDev = process.argv.includes('--dev');
const frontHost = process.env.HOST ?? (isDev ? '' : '127.0.0.1');
const frontPort = Number(process.env.PORT || '3000');
const upstreamHost = process.env.DELB_UPSTREAM_HOST || '127.0.0.1';
const upstreamPort = Number(
  process.env.DELB_UPSTREAM_PORT || String(isDev ? 3001 : frontPort + 1000),
);
const upstreamUrl = `http://${upstreamHost}:${upstreamPort}`;

const goBin = process.env.DELB_GO_BIN || path.join(repoRoot, 'bin', 'delb');
if (!existsSync(goBin)) {
  console.error(
    `Go binary not found at ${goBin}. Build it first with: CGO_ENABLED=0 go build -o bin/delb ./cmd/delb`,
  );
  process.exit(1);
}

// Run pending SQLite migrations via Go before Nitro boots so Nitro's startup
// plugins (storage recovery, Dropbox watcher) always see an initialized schema.
execFileSync(goBin, ['--migrate-only'], {
  cwd: process.cwd(),
  env: process.env,
  stdio: 'inherit',
});

const nodeOptionsParts = [];
if (process.env.NODE_OPTIONS) {
  nodeOptionsParts.push(process.env.NODE_OPTIONS);
}
if (!isDev) {
  const denyOutbound = path.resolve('review/deny-outbound.cjs');
  if (existsSync(denyOutbound)) {
    nodeOptionsParts.push(`--require ${denyOutbound}`);
  }
  const fakeCodex = path.resolve('review/fake-codex-provider.cjs');
  if (existsSync(fakeCodex)) {
    nodeOptionsParts.push(`--require ${fakeCodex}`);
  }
}

const nitroEnv = {
  ...process.env,
  HOST: upstreamHost,
  HOSTNAME: upstreamHost,
  PORT: String(upstreamPort),
  NITRO_HOST: upstreamHost,
  NITRO_PORT: String(upstreamPort),
  ...(nodeOptionsParts.length
    ? { NODE_OPTIONS: nodeOptionsParts.join(' ') }
    : {}),
};

const nitroArgs = isDev
  ? [
      path.join(repoRoot, 'node_modules/nuxt/bin/nuxt.mjs'),
      'dev',
      '--host',
      upstreamHost,
      '--port',
      String(upstreamPort),
    ]
  : [path.join(repoRoot, '.output/server/index.mjs')];

const nitro = spawn(process.execPath, nitroArgs, {
  cwd: process.cwd(),
  env: nitroEnv,
  stdio: 'inherit',
});

let goProc = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (goProc && goProc.exitCode === null) {
    goProc.kill('SIGTERM');
  }
  if (nitro && nitro.exitCode === null) {
    nitro.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}

nitro.on('exit', (code) => {
  if (!shuttingDown) {
    shutdown(code ?? 1);
  }
});

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (nitro.exitCode !== null) {
      throw new Error(
        `Upstream Nitro exited early with code ${nitro.exitCode}`,
      );
    }
    const ok = await new Promise((resolve) => {
      const sock = createConnection({ host, port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Timed out waiting for upstream ${host}:${port}`);
}

try {
  await waitForPort(upstreamHost, upstreamPort, isDev ? 60000 : 15000);
} catch (err) {
  console.error(String(err));
  shutdown(1);
}

if (!shuttingDown) {
  goProc = spawn(goBin, [], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: frontHost,
      PORT: String(frontPort),
      DELB_UPSTREAM_URL: upstreamUrl,
    },
    stdio: 'inherit',
  });

  goProc.on('exit', (code) => {
    if (!shuttingDown) {
      shutdown(code ?? 1);
    }
  });
}
