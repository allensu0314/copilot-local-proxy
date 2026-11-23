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

test('installed Codex recovers connection and early stream failures and surfaces exhausted recovery',
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
    let upstreamBodies;
    let responseIndex;
    let calls = 0;
    const server = createProxy({
      localToken, getProviderToken: async () => 'synthetic-provider-key',
      connectionRetryDelaysMs: [1, 2, 4, 8, 16],
      fetchImpl: async (url, init) => {
        if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gpt-6.1-sol' }] });
        const request = JSON.parse(init.body);
        assert.equal(request.store, false);
        calls++;
        const upstreamBody = upstreamBodies[Math.min(responseIndex++, upstreamBodies.length - 1)];
        if (upstreamBody?.errorCode) throw new TypeError('PRIVATE_TRANSPORT_DETAIL', {
          cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code: upstreamBody.errorCode }),
        });
        return new Response(upstreamBody, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const event = data => `data: ${JSON.stringify(data)}\n\n`;
      const earlyEof = event({ type: 'response.created', response: { id: 'resp_discarded' } }) +
        event({ type: 'response.output_item.added', item: { id: 'reasoning_discarded', type: 'reasoning' } });
      const item = { id: 'msg_recovered', type: 'message', role: 'assistant',
        content: [{ type: 'output_text', text: 'RECOVERED', annotations: [] }] };
      const recovered = event({ type: 'response.created', response: { id: 'resp_recovered' } }) +
        event({ type: 'response.output_item.added', item: { ...item, content: [] }, output_index: 0 }) +
        event({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'RECOVERED' }) +
        event({ type: 'response.output_item.done', item, output_index: 0 }) +
        event({ type: 'response.completed', response: { id: 'resp_recovered' } });
      for (const { bodies, code, expectedCalls } of [
        { bodies: [...Array.from({ length: 4 }, () => ({ errorCode: 'UND_ERR_CONNECT_TIMEOUT' })), recovered],
          expectedCalls: 5 },
        { bodies: [{ errorCode: 'UND_ERR_CONNECT_TIMEOUT' }], code: 'UND_ERR_CONNECT_TIMEOUT', expectedCalls: 6 },
        { bodies: [earlyEof, recovered], expectedCalls: 2 },
        { bodies: [earlyEof], code: 'upstream_stream_incomplete', expectedCalls: 3 },
        { bodies: ['event: error\ndata: {"type":"error","code":"request_timeout","message":"PRIVATE_PROVIDER_DETAIL"}\n\n'],
          code: 'upstream_reported_error', expectedCalls: 1 },
      ]) {
        upstreamBodies = bodies;
        responseIndex = 0;
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
        if (code) {
          await assert.rejects(run, error => {
            const output = error.stdout + error.stderr;
            assert.equal(error.code, 1, output);
            assert.ok(output.includes(code), output);
            assert.match(output, /request id: [a-f0-9-]{36}/i);
            assert.equal(output.includes('stream closed before response.completed'), false);
            assert.equal(output.includes('PRIVATE_'), false);
            return true;
          });
        } else {
          const { stdout } = await run;
          const events = stdout.trim().split('\n').map(line => JSON.parse(line));
          assert.ok(events.some(e => e.type === 'turn.completed'), stdout);
          assert.ok(events.some(e => e.type === 'item.completed' &&
            e.item.type === 'agent_message' && e.item.text === 'RECOVERED'), stdout);
          assert.equal(events.some(e => e.type === 'error' || e.type === 'turn.failed'), false);
          assert.equal(stdout.includes('resp_discarded'), false);
        }
        assert.equal(calls, previousCalls + expectedCalls);
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
