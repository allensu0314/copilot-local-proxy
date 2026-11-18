import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createProxy } from './server.mjs';

const execute = promisify(execFile);

test('installed Codex surfaces proxy stream failures instead of silently ignoring them',
  { skip: process.platform !== 'win32' }, async t => {
    const powershell = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
    const { stdout } = await execute(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      "$app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; " +
      "if ($app) { Join-Path $app.InstallLocation 'app\\resources\\codex.exe' }"],
    { windowsHide: true, timeout: 15_000 });
    const cli = stdout.trim();
    if (!cli) { t.skip('Codex desktop is not installed'); return; }
    const root = await mkdtemp(join(tmpdir(), 'copilot-proxy-codex-stream-test-'));
    const localToken = 'synthetic-proxy-protocol-test-key-only';
    let upstreamBody;
    let calls = 0;
    const server = createProxy({
      localToken, getProviderToken: async () => 'synthetic-provider-key',
      fetchImpl: async url => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
        calls++;
        return new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      for (const [body, code] of [
        ['data: {"type":"response.created","response":{"id":"resp_synthetic"}}\n\n', 'upstream_stream_incomplete'],
        ['event: error\ndata: {"type":"error","code":"request_timeout","message":"PRIVATE_PROVIDER_DETAIL"}\n\n', 'upstream_reported_error'],
      ]) {
        upstreamBody = body;
        const previousCalls = calls;
        const args = ['exec', '--skip-git-repo-check', '--ephemeral', '--json',
          '-c', 'model_provider="stream-test"', '-c', 'model="gpt-6.1-sol"',
          '-c', 'web_search="disabled"',
          '-c', 'model_providers.stream-test.name="Synthetic protocol test"',
          '-c', `model_providers.stream-test.base_url="http://127.0.0.1:${server.address().port}/v1"`,
          '-c', 'model_providers.stream-test.wire_api="responses"',
          '-c', 'model_providers.stream-test.env_key="COPILOT_PROTOCOL_TEST_KEY"',
          '-c', 'model_providers.stream-test.supports_websockets=false',
          '-c', 'model_providers.stream-test.request_max_retries=0',
          '-c', 'model_providers.stream-test.stream_max_retries=0',
          'Synthetic stream protocol test. Do not execute tools.'];
        const run = execute(cli, args, {
          cwd: root, windowsHide: true, timeout: 30_000,
          env: { ...process.env, CODEX_HOME: root, COPILOT_PROTOCOL_TEST_KEY: localToken },
        });
        run.child.stdin.end();
        await assert.rejects(run, error => {
          const output = error.stdout + error.stderr;
          assert.equal(error.code, 1, output);
          assert.ok(output.includes(code), output);
          assert.match(output, /Request ID: [a-f0-9-]{36}/);
          assert.equal(output.includes('stream closed before response.completed'), false);
          assert.equal(output.includes('PRIVATE_PROVIDER_DETAIL'), false);
          return true;
        });
        assert.equal(calls, previousCalls + 1);
      }
    } finally {
      server.closeAllConnections();
      await new Promise(resolveClose => server.close(resolveClose));
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

test('desktop integration backs up config, is idempotent, and restores only owned top-level settings',
  { skip: process.platform !== 'win32' }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'copilot-proxy-desktop-test-'));
    try {
      const home = join(root, 'user');
      const local = join(root, 'local');
      const codex = join(home, '.codex');
      const data = join(local, 'CopilotProxy');
      await mkdir(codex, { recursive: true });
      await mkdir(data, { recursive: true });
      const original = 'model = "test-model"\r\nmodel_provider = "previous" # keep comment\r\n' +
        'web_search = "live"\r\n\r\n[unrelated]\r\nmodel_provider = "nested-untouched"\r\nvalue = 123\r\n';
      const config = join(codex, 'config.toml');
      await writeFile(config, original);
      const profile = '[model_providers.copilot-local]\nname = "Synthetic"\nbase_url = "http://127.0.0.1:39117/v1"\n';
      await writeFile(join(codex, 'copilot-local.config.toml'), profile);
      const run = async (...args) => {
        await execute(join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe'),
          ['-NoProfile', '-NonInteractive', '-File', resolve('configure-desktop.ps1'), ...args],
          { env: { ...process.env, USERPROFILE: home, LOCALAPPDATA: local }, timeout: 15000, windowsHide: true });
      };
      await run();
      const enabled = await readFile(config, 'utf8');
      assert.match(enabled, /^model_provider = "copilot-local"\r?$/m);
      assert.match(enabled, /^web_search = "disabled"\r?$/m);
      assert.ok(enabled.includes('[unrelated]\r\nmodel_provider = "nested-untouched"\r\nvalue = 123'));
      const backup = (await readdir(data)).find(name => name.startsWith('codex-config-backup-'));
      assert.equal(await readFile(join(data, backup), 'utf8'), original);
      await writeFile(join(codex, 'copilot-local.config.toml'), profile.replaceAll('\n', '\r\n'));
      await run();
      assert.equal(await readFile(config, 'utf8'), enabled);
      await run('-Remove');
      assert.equal((await readFile(config, 'utf8')).trimEnd(), original.trimEnd());
      await run();
      await writeFile(config, (await readFile(config, 'utf8')).replace('model_provider = "copilot-local"', 'model_provider = "user-changed"'));
      await run('-Remove');
      const removed = await readFile(config, 'utf8');
      assert.match(removed, /^model_provider = "user-changed"\r?$/m);
      assert.match(removed, /^web_search = "live"\r?$/m);
      assert.equal(removed.includes('[model_providers.copilot-local]'), false);
    } finally { await rm(root, { recursive: true, maxRetries: 5, retryDelay: 100 }); }
  });
