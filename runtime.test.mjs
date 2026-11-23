import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { stateDirectory, loadRuntimeConfiguration, readLocalToken } from './runtime.mjs';
import { resolveGh } from './server.mjs';

const execute = promisify(execFile);
const key = 'synthetic-portable-local-key-not-a-real-credential';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'copilot portable test '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const data = join(root, 'private state');
  await mkdir(data, { mode: 0o700 });
  const keyPath = join(data, 'local-key');
  await writeFile(keyPath, key + '\n', { mode: 0o600 });
  const configPath = join(data, 'installation.json');
  const listener = createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolveClose => listener.close(resolveClose));
  await writeFile(configPath, JSON.stringify({ port, ghPath: process.execPath, localTokenPath: keyPath }));
  const env = { ...process.env, COPILOT_PROXY_CONFIG: configPath };
  delete env.COPILOT_PROXY_LOCAL_TOKEN;
  delete env.COPILOT_PROXY_LOCAL_TOKEN_FILE;
  return { root, data, keyPath, configPath, port, env };
}

test('native state paths support Windows, macOS, and absolute Linux XDG overrides', () => {
  const home = resolve('synthetic-home');
  const local = resolve('synthetic-local');
  const xdg = resolve('synthetic-xdg');
  assert.equal(stateDirectory({ platform: 'win32', home, env: { LOCALAPPDATA: local } }), join(local, 'CopilotProxy'));
  assert.equal(stateDirectory({ platform: 'darwin', home, env: {} }), join(home, 'Library', 'Application Support', 'CopilotProxy'));
  assert.equal(stateDirectory({ platform: 'linux', home, env: { XDG_STATE_HOME: xdg } }), join(xdg, 'copilot-proxy'));
  assert.equal(stateDirectory({ platform: 'linux', home, env: { XDG_STATE_HOME: 'relative' } }), join(home, '.local', 'state', 'copilot-proxy'));
  assert.equal(stateDirectory({ home, env: { COPILOT_PROXY_DATA_DIR: xdg } }), xdg);
  assert.equal(resolveGh(undefined, { platform: 'linux', env: { LOCALAPPDATA: 'missing' } }), 'gh');
  assert.equal(resolveGh(undefined, { platform: 'darwin', env: {} }), 'gh');
  assert.equal(resolveGh(undefined, { platform: 'win32', env: { LOCALAPPDATA: 'missing' } }), 'gh.exe');
  assert.equal(resolveGh(process.execPath), process.execPath);
});

test('runtime and command-backed local auth read configuration and keys at paths containing spaces', async t => {
  const { configPath, env, port } = await fixture(t);
  const config = await loadRuntimeConfiguration({ env });
  assert.equal(config.localToken, key);
  assert.equal(config.config.port, port);
  const { stdout, stderr } = await execute(process.execPath, [resolve('manage.mjs'), 'token', '--config', configPath], { env, windowsHide: true });
  assert.equal(stdout, key + '\n');
  assert.equal(stderr, '');
  await assert.rejects(loadRuntimeConfiguration({ env: { ...env, COPILOT_PROXY_LOCAL_TOKEN: 'too-short' } }), /strong local bearer/);
});

test('configured service starts without PowerShell or an environment bearer key', async t => {
  const { env, port } = await fixture(t);
  const child = spawn(process.execPath, [resolve('server.mjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { errors += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
  const deadline = Date.now() + 10_000;
  while (!output.includes('"event":"listening"')) {
    if (child.exitCode !== null || Date.now() > deadline) assert.fail(output + errors);
    await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
  }
  assert.deepEqual(await (await fetch(`http://127.0.0.1:${port}/health`)).json(), { service: 'copilot-proxy', status: 'ok' });
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/models`)).status, 401);
  assert.equal(output.includes(key), false);
  assert.equal(errors, '');
  child.kill('SIGTERM');
  await exited;
});

test('Windows runtime retains DPAPI command-backed auth and clears inherited credential variables', async () => {
  let invoked;
  const token = await readLocalToken({ sourceDir: resolve('synthetic source'), pwshPath: 'synthetic-pwsh' }, {
    platform: 'win32', env: { GH_TOKEN: 'PRIVATE_TRANSIENT', GITHUB_TOKEN: 'PRIVATE_TRANSIENT' },
    executeImpl: async (...args) => { invoked = args; return { stdout: key + '\r\n' }; },
  });
  assert.equal(token, key);
  assert.equal(invoked[0], 'synthetic-pwsh');
  assert.equal(invoked[1].at(-1), join(resolve('synthetic source'), 'token.ps1'));
  assert.equal(invoked[2].env.GH_TOKEN, undefined);
  assert.equal(invoked[2].env.GITHUB_TOKEN, undefined);
  assert.equal(invoked[2].windowsHide, true);
});

test('Unix auth rejects readable-by-others and symlink keys', { skip: process.platform === 'win32' }, async t => {
  const { keyPath, configPath, env } = await fixture(t);
  await chmod(keyPath, 0o644);
  await assert.rejects(loadRuntimeConfiguration({ env }), /mode 0600/);
  await chmod(keyPath, 0o600);
  const link = keyPath + '.link';
  await symlink(keyPath, link);
  await assert.rejects(readLocalToken({ localTokenPath: link }, { configPath, env: {} }), error => error.code === 'ELOOP');
  assert.equal((await readFile(keyPath, 'utf8')).trim(), key);
});
