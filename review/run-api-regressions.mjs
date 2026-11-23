import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const externalBaseUrl = (
  process.env.DELB_REVIEW_URL ||
  process.env.BASE_URL ||
  ''
).replace(/\/$/, '');
const reviewHost = process.env.DELB_REVIEW_HOST || '127.0.0.1';
const reviewPort = Number(process.env.DELB_REVIEW_PORT || '4317');
const defaultBaseUrl = `http://${reviewHost}:${reviewPort}`;
const baseUrl = externalBaseUrl || defaultBaseUrl;
const customServerCmd = process.env.DELB_SERVER_CMD || '';
const goBin = process.env.DELB_GO_BIN || path.join(root, 'bin', 'delb');

const environment = {
  PATH: process.env.PATH,
  DELB_REVIEW_URL: baseUrl,
  BASE_URL: baseUrl,
  DELB_REVIEW_HOST: reviewHost,
  DELB_REVIEW_PORT: String(reviewPort),
  ...(process.env.CHROME_BIN ? { CHROME_BIN: process.env.CHROME_BIN } : {}),
  ...(process.env.DELB_MCP_TEST_PYTHON
    ? { DELB_MCP_TEST_PYTHON: process.env.DELB_MCP_TEST_PYTHON }
    : {}),
};

async function run(args, cwd) {
  const child = spawn(process.execPath, args, { cwd, env: environment });
  let output = '';
  child.stdout.on('data', (bytes) => {
    output += bytes;
  });
  child.stderr.on('data', (bytes) => {
    output += bytes;
  });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (code !== 0) throw Error(output);
  process.stdout.write(output);
}

if (!externalBaseUrl) {
  if (!customServerCmd && !existsSync(goBin)) {
    throw Error(
      `Standalone Go binary not found at ${goBin}. Run \`pnpm build\` first.`,
    );
  }
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(reviewPort, reviewHost, resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
}

const suites = [
  'review/audits/2026-10-27/bootstrap-regression.mjs',
  'review/audits/2026-10-27/server-regression.mjs',
  'review/tag-features-api.mjs',
  'review/dashboard-api.mjs',
  'review/tbr-api.mjs',
  'review/pdf-reader-api.mjs',
  'review/collections-api.mjs',
  'review/bookshelf-api.mjs',
  'review/collection-bookshelf-api.mjs',
  'review/bookshelf-pictures-api.mjs',
  'review/spine-artwork-api.mjs',
  'review/spine-generation-api.mjs',
  'review/personal-shelves-api.mjs',
  'review/mcp-api.mjs',
  'review/mcp-library-api.mjs',
  'review/mcp-progress-api.mjs',
];
const requested = process.argv.slice(2);
if (
  requested.some(
    (suite) =>
      ![
        ...suites,
        'review/http-smoke.mjs',
        'review/collections-browser.mjs',
        'review/bookshelf-load-browser.mjs',
        'review/personal-shelves-browser.mjs',
        'review/spine-generation-browser.mjs',
      ].includes(suite),
  )
)
  throw Error('Choose a known API regression suite');

if (externalBaseUrl) {
  let ready = false;
  try {
    const res = await fetch(`${baseUrl}/api/books`, {
      signal: AbortSignal.timeout(2000),
    });
    ready = res.status === 401 || res.status === 200;
  } catch {
    ready = false;
  }
  if (!ready) {
    throw Error(`External server at ${baseUrl} did not respond on /api/books`);
  }
  for (const suite of requested.length ? requested : suites) {
    await run([suite], root);
  }
  console.log(`PASS API regressions against ${baseUrl}`);
  process.exit(0);
}

/**
 * Starts a loopback HTTP bridge wrapping review/fake-codex-provider.cjs so the
 * standalone Go binary can talk to the deterministic fake Codex provider over
 * DELB_CODEX_AUTH_URL / DELB_CODEX_API_URL without making outbound calls.
 */
async function startFakeCodexBridge(directory) {
  const prevCwd = process.cwd();
  const prevFetch = globalThis.fetch;
  const fakeCodexPath = path.join(directory, 'review/fake-codex-provider.cjs');
  const req = createRequire(fakeCodexPath);
  req(fakeCodexPath);
  const patchedFetch = globalThis.fetch;
  globalThis.fetch = prevFetch;

  const bridge = createHttpServer(async (incoming, res) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const targetOrigin =
        incoming.url && incoming.url.startsWith('/backend-api/')
          ? 'https://chatgpt.com'
          : 'https://auth.openai.com';
      process.chdir(directory);
      let response;
      try {
        response = await patchedFetch(`${targetOrigin}${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers,
          ...(incoming.method !== 'GET' && incoming.method !== 'HEAD'
            ? { body }
            : {}),
        });
      } finally {
        process.chdir(prevCwd);
      }
      res.statusCode = response.status;
      const ct = response.headers.get('content-type');
      if (ct) res.setHeader('content-type', ct);
      const buf = Buffer.from(await response.arrayBuffer());
      res.end(buf);
    } catch (err) {
      res.statusCode = 500;
      res.end(String(err));
    }
  });
  await new Promise((resolve, reject) => {
    bridge.once('error', reject);
    bridge.listen(0, '127.0.0.1', resolve);
  });
  const addr = bridge.address();
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => bridge.close(() => resolve())),
  };
}

for (const suite of requested.length ? requested : suites) {
  const directory = await mkdtemp(path.join(tmpdir(), 'delb-api-regression-'));
  let server;
  let fakeCodexBridge = null;
  let serverOutput = '';
  try {
    const needsFakeCodex = [
      'review/spine-generation-api.mjs',
      'review/spine-generation-browser.mjs',
    ].includes(suite);

    for (const file of [
      'package.json',
      'review/isolation.mjs',
      'review/fetch-auth.mjs',
      'review/sqlite-client.mjs',
      'review/test-image.mjs',
      'review/setup-demo.mjs',
      'review/http-smoke.mjs',
      'review/pdf-fixture.mjs',
      suite,
      ...(suite === 'review/mcp-api.mjs'
        ? ['review/mcp-python-client.py']
        : []),
      ...(needsFakeCodex ? ['review/fake-codex-provider.cjs'] : []),
    ]) {
      const destination = path.join(directory, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(root, file), destination);
    }
    await cp(path.join(root, '.drizzle'), path.join(directory, '.drizzle'), {
      recursive: true,
    });
    await symlink(
      path.join(root, 'node_modules'),
      path.join(directory, 'node_modules'),
      'dir',
    );
    await run(['review/setup-demo.mjs'], directory);

    if (needsFakeCodex) {
      fakeCodexBridge = await startFakeCodexBridge(directory);
    }

    await mkdir(path.join(directory, '.review-home'), { recursive: true });
    const serverEnv = {
      ...environment,
      HOME: path.join(directory, '.review-home'),
      HOST: reviewHost,
      HOSTNAME: reviewHost,
      PORT: String(reviewPort),
      DATABASE_URL: 'file:./review/demo/synthetic.db',
      BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      BETTER_AUTH_URL: baseUrl,
      BETTER_AUTH_TRUSTED_ORIGINS: baseUrl,
      LOG_LEVEL: 'warn',
      NODE_ENV: 'production',
      ...(fakeCodexBridge
        ? {
            DELB_CODEX_AUTH_URL: fakeCodexBridge.baseUrl,
            DELB_CODEX_API_URL: fakeCodexBridge.baseUrl,
          }
        : {}),
    };

    if (customServerCmd) {
      server = spawn(customServerCmd, {
        cwd: directory,
        shell: true,
        env: serverEnv,
        detached: true,
      });
    } else {
      server = spawn(goBin, [], {
        cwd: directory,
        env: serverEnv,
        detached: true,
      });
    }

    const record = (bytes) => {
      serverOutput = (serverOutput + bytes).slice(-20000);
    };
    server.stdout.on('data', record);
    server.stderr.on('data', record);
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw Error(serverOutput);
      try {
        ready =
          (
            await fetch(`${baseUrl}/api/books`, {
              signal: AbortSignal.timeout(500),
            })
          ).status === 401;
      } catch {
        ready = false;
      }
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!ready)
      throw Error(
        'Disposable standalone Go server did not become ready.\n' + serverOutput,
      );
    try {
      await run([suite], directory);
    } catch (error) {
      throw new Error(`${String(error)}\nServer output:\n${serverOutput}`);
    }
    if (suite.endsWith('/server-regression.mjs'))
      await run(['review/http-smoke.mjs'], directory);
  } finally {
    if (server && server.exitCode === null) {
      const closed = new Promise((resolve) => server.once('close', resolve));
      process.kill(-server.pid, 'SIGTERM');
      await closed;
    }
    if (fakeCodexBridge) {
      await fakeCodexBridge.close();
    }
    await rm(directory, { recursive: true, force: true });
  }
}
console.log('PASS isolated standalone Go binary bootstrap and API regressions');
