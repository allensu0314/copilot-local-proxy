import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, resolve } from 'node:path';
import { configureClient, providerConfiguration, installPortable, uninstallPortable, serviceDefinition } from './manage.mjs';
import { loadRuntimeConfiguration } from './runtime.mjs';

const execute = promisify(execFile);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'copilot setup test '));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = join(root, 'user');
  const data = join(root, 'state');
  await mkdir(join(home, '.codex'), { recursive: true });
  await mkdir(data, { mode: 0o700 });
  const provider = providerConfiguration({ port: 39117, directory: resolve('.'), configPath: join(data, 'installation.json') });
  const path = join(home, '.codex', 'config.toml');
  const original = 'model = "existing"\r\nmodel_provider = "existing" # keep comment\r\nweb_search = "live"\r\n\r\n[unrelated]\r\nweb_search = "unchanged"\r\n';
  await writeFile(path, original);
  return { root, home, data, provider, path, original };
}

test('portable CLI profile leaves desktop defaults intact and removes only its own files', async t => {
  const f = await fixture(t);
  await configureClient(f);
  assert.equal(await readFile(f.path, 'utf8'), f.original);
  const profile = join(f.home, '.codex', 'copilot-local.config.toml');
  const text = await readFile(profile, 'utf8');
  assert.match(text, /^# Managed by copilot-local-proxy\nmodel = "gpt-6.1-sol"/);
  assert.ok(text.includes(JSON.stringify(join(f.data, 'installation.json'))));
  await configureClient(f);
  assert.equal((await readdir(f.data)).filter(name => name.includes('backup')).length, 0);
  await configureClient({ ...f, remove: true });
  assert.equal(await readFile(f.path, 'utf8'), f.original);
  await assert.rejects(readFile(profile), { code: 'ENOENT' });
});

test('portable desktop integration is idempotent and restores owned defaults while preserving user edits', async t => {
  const f = await fixture(t);
  await configureClient({ ...f, desktop: true });
  const configured = await readFile(f.path, 'utf8');
  assert.match(configured, /^model_provider = "copilot-local"\r?$/m);
  assert.ok(configured.includes('[unrelated]\r\nweb_search = "unchanged"'));
  await configureClient({ ...f, desktop: true });
  assert.equal(await readFile(f.path, 'utf8'), configured);
  assert.equal((await readdir(f.data)).filter(name => name.startsWith('codex-config-backup')).length, 1);
  await writeFile(f.path, configured.replace('model_provider = "copilot-local"', 'model_provider = "user-selected"'));
  await configureClient({ ...f, remove: true });
  const restored = await readFile(f.path, 'utf8');
  assert.match(restored, /^model_provider = "user-selected"\r?$/m);
  assert.match(restored, /^web_search = "live"\r?$/m);
  assert.equal(restored.includes('[model_providers.copilot-local]'), false);
});

test('unmanaged client profiles and providers cannot be overwritten', async t => {
  const f = await fixture(t);
  await writeFile(join(f.home, '.codex', 'copilot-local.config.toml'), 'unmanaged');
  await assert.rejects(configureClient(f), /unmanaged/);
  assert.equal(await readFile(f.path, 'utf8'), f.original);
});

test('user service definitions keep paths as arguments and escape native configuration syntax', () => {
  const directory = resolve('source with spaces $cash% "quote" & tag');
  const data = resolve('state with spaces $cash% & tag');
  const linux = serviceDefinition({ platform: 'linux', home: resolve('user'), env: {}, data, directory });
  assert.match(linux.content, /ExecStart="[^\n]+" "[^\n]+server\.mjs"/);
  assert.ok(linux.content.includes('$$cash%%'));
  const environment = linux.content.split('\n').find(line => line.startsWith('Environment='));
  assert.ok(environment.includes('$cash%%'));
  assert.equal(environment.includes('$$cash'), false);
  const mac = serviceDefinition({ platform: 'darwin', home: resolve('user'), env: {}, data, directory });
  assert.ok(mac.content.includes('&amp;'));
  assert.ok(mac.content.includes('&quot;quote&quot;'));
  assert.match(mac.content, /<key>ProgramArguments<\/key><array><string>.+<\/string><string>.+<\/string><\/array>/);
  assert.throws(() => serviceDefinition({ platform: 'linux', data, directory: 'bad\npath' }), /line breaks/);
});

test('native service configuration passes the platform parser', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const directory = join(f.root, 'source with spaces $cash% "quote" & tag');
  await mkdir(directory);
  const definition = serviceDefinition({ home: f.home, env: {}, data: f.data, directory });
  const path = join(f.root, process.platform === 'darwin' ? 'com.copilot.proxy.plist' : 'copilot-proxy.service');
  await writeFile(path, definition.content);
  try {
    if (process.platform === 'darwin') await execute('plutil', ['-lint', path]);
    else await execute('systemd-analyze', ['--user', 'verify', path]);
  } catch (error) {
    if (error.code === 'ENOENT') { t.skip('Native service parser is not installed'); return; }
    throw error;
  }
});

test('Unix install, reconfigure, and uninstall keep a stable private key and restore the desktop config',
  { skip: process.platform === 'win32' }, async t => {
    const f = await fixture(t);
    const options = { home: f.home, env: { COPILOT_PROXY_DATA_DIR: f.data }, ghPath: process.execPath, service: false, desktop: true };
    const installed = await installPortable(options);
    const env = { COPILOT_PROXY_CONFIG: installed.configPath };
    const first = await loadRuntimeConfiguration({ env });
    assert.equal(first.localToken.length >= 32, true);
    assert.equal((await stat(first.config.localTokenPath)).mode & 0o077, 0);
    assert.equal((await stat(f.data)).mode & 0o077, 0);
    await installPortable({ ...options, desktop: false, port: 39118 });
    const second = await loadRuntimeConfiguration({ env });
    assert.equal(second.localToken, first.localToken);
    assert.equal(second.config.port, 39118);
    assert.match(await readFile(f.path, 'utf8'), /^model_provider = "copilot-local"\r?$/m);
    await uninstallPortable(options);
    assert.equal((await readFile(f.path, 'utf8')).trimEnd(), f.original.trimEnd());
    await assert.rejects(readFile(installed.configPath), { code: 'ENOENT' });
    assert.ok((await readdir(f.data)).some(name => name.startsWith('codex-config-backup')));
  });

test('a missing user service bus can recover to foreground installation without losing the key',
  { skip: process.platform !== 'linux' }, async t => {
    const f = await fixture(t);
    const options = { home: f.home, env: { COPILOT_PROXY_DATA_DIR: f.data }, ghPath: process.execPath,
      executeImpl: async () => { throw Object.assign(new Error('no user service bus'), { code: 1, stderr: 'Failed to connect to user scope bus: No medium found' }); } };
    await assert.rejects(installPortable(options), /install --no-service/);
    const configPath = join(f.data, 'installation.json');
    const first = await loadRuntimeConfiguration({ env: { COPILOT_PROXY_CONFIG: configPath } });
    const installed = await installPortable({ ...options, service: false });
    assert.equal(installed.config.service, false);
    assert.equal((await loadRuntimeConfiguration({ env: { COPILOT_PROXY_CONFIG: configPath } })).localToken, first.localToken);
    await uninstallPortable(options);
  });
