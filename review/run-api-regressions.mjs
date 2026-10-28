import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const environment = { PATH: process.env.PATH, NUXT_TELEMETRY_DISABLED: '1' };
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

const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once('error', reject);
  probe.listen(4317, '127.0.0.1', resolve);
});
await new Promise((resolve) => probe.close(resolve));

for (const suite of [
  'review/audits/2026-10-27/bootstrap-regression.mjs',
  'review/audits/2026-10-27/server-regression.mjs',
  'review/tag-features-api.mjs',
]) {
  const directory = await mkdtemp(path.join(tmpdir(), 'delb-api-regression-'));
  let server;
  let serverOutput = '';
  try {
    for (const file of [
      'package.json',
      'packages/epub/package.json',
      'review/isolation.mjs',
      'review/fetch-auth.mjs',
      'review/setup-demo.mjs',
      'review/start-demo.mjs',
      'review/deny-outbound.cjs',
      'review/http-smoke.mjs',
      suite,
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
    await symlink(
      path.join(root, 'packages/epub/node_modules'),
      path.join(directory, 'packages/epub/node_modules'),
      'dir',
    );
    await symlink(
      path.join(root, '.output'),
      path.join(directory, '.output'),
      'dir',
    );
    await run(['review/setup-demo.mjs'], directory);
    server = spawn(
      process.execPath,
      ['review/start-demo.mjs', '--production'],
      { cwd: directory, env: environment, detached: true },
    );
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
            await fetch('http://127.0.0.1:4317/api/books', {
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
        'Disposable production server did not become ready.\n' + serverOutput,
      );
    await run([suite], directory);
    if (suite.endsWith('/server-regression.mjs'))
      await run(['review/http-smoke.mjs'], directory);
  } finally {
    if (server && server.exitCode === null) {
      const closed = new Promise((resolve) => server.once('close', resolve));
      process.kill(-server.pid, 'SIGTERM');
      await closed;
    }
    await rm(directory, { recursive: true, force: true });
  }
}
console.log('PASS isolated production bootstrap and API regressions');
