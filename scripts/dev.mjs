import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function loadDotEnv(cwd) {
  const envPath = path.join(cwd, '.env');
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = withoutExport.slice(0, eqIdx).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;
    let val = withoutExport.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"') && val.length >= 2) ||
      (val.startsWith("'") && val.endsWith("'") && val.length >= 2)
    ) {
      const quote = val[0];
      val = val.slice(1, -1);
      if (quote === '"') {
        val = val
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .replace(/\\\\/g, '\\');
      }
    } else {
      const commentIdx = val.indexOf(' #');
      if (commentIdx >= 0) val = val.slice(0, commentIdx).trim();
    }
    process.env[key] = val;
  }
}

loadDotEnv(process.cwd());

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const frontHost = process.env.HOST ?? '';
const frontPort = Number(process.env.PORT || '3000');
const viteHost = process.env.DELB_UPSTREAM_HOST || '127.0.0.1';
const vitePort = Number(process.env.DELB_UPSTREAM_PORT || '3001');
const upstreamUrl = `http://${viteHost}:${vitePort}`;

const goBin = process.env.DELB_GO_BIN || path.join(repoRoot, 'bin', 'delb');
const goCmd = process.env.GO_BIN || 'go';

execFileSync(goCmd, ['build', '-o', goBin, './cmd/delb'], {
  cwd: repoRoot,
  env: { ...process.env, CGO_ENABLED: '0' },
  stdio: 'inherit',
});

const vite = spawn(
  process.execPath,
  [
    path.join(repoRoot, 'node_modules/vite/bin/vite.js'),
    '--host',
    viteHost,
    '--port',
    String(vitePort),
    '--strictPort',
  ],
  {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
  },
);

let goProc = null;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (goProc && goProc.exitCode === null) {
    goProc.kill('SIGTERM');
  }
  if (vite && vite.exitCode === null) {
    vite.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 200).unref();
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(0));
}

vite.on('exit', (code) => {
  if (!shuttingDown) shutdown(code ?? 1);
});

async function waitForPort(host, port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (vite.exitCode !== null) {
      throw new Error(`Vite dev server exited early with code ${vite.exitCode}`);
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
  throw new Error(`Timed out waiting for Vite dev server ${host}:${port}`);
}

try {
  await waitForPort(viteHost, vitePort, 30000);
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
    if (!shuttingDown) shutdown(code ?? 1);
  });
}
