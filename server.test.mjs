import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { channel } from 'node:diagnostics_channel';
import { createProxy, createTokenSource, githubTokenSource } from './server.mjs';

const localToken = 'synthetic-local-test-key-not-a-real-credential';
const headers = { authorization: `Bearer ${localToken}`, 'content-type': 'application/json' };
const payload = { model: 'test-model', input: 'Synthetic test input', stream: true };

async function fixture(t, options = {}) {
  const server = createProxy({
    localToken, getProviderToken: async () => 'synthetic-upstream-token',
    fetchImpl: async () => new Response('{}', { headers: { 'content-type': 'application/json' } }),
    connectionRetryDelaysMs: [1, 2, 4, 8, 16],
    ...options,
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = payload, extra = {}) => fetch(`${base}/v1/responses`, {
    method: 'POST', headers, body: JSON.stringify(body), ...extra,
  });
  return { base, post };
}

test('health is public; inference rejects missing/wrong keys, browser origins, and rebinding hosts', async t => {
  let upstreamCalls = 0;
  const { base } = await fixture(t, { fetchImpl: async () => { upstreamCalls++; return new Response('{}'); } });
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: 'ok', service: 'copilot-proxy' });
  for (const [extra, expected] of [
    [{}, 401],
    [{ authorization: 'Bearer invalid' }, 401],
    [{ ...headers, origin: 'https://example.test' }, 403],
  ]) {
    const r = await fetch(`${base}/v1/models`, { headers: extra });
    assert.equal(r.status, expected);
    await r.body.cancel();
  }
  const reboundStatus = await new Promise((resolve, reject) => {
    get(`${base}/v1/models`, { headers: { ...headers, host: 'attacker.example' } }, res => {
      res.resume();
      resolve(res.statusCode);
    }).once('error', reject);
  });
  assert.equal(reboundStatus, 403);
  assert.equal(upstreamCalls, 0);
});

test('forwards bytes and native SSE tool/reasoning events without forwarding client headers', async t => {
  const events = 'event: response.output_item.added\ndata: {"type":"function_call","arguments":"{}"}\n\n' +
    'event: response.completed\ndata: {"type":"response.completed","reasoning":{"encrypted_content":"synthetic"}}\n\n';
  let captured;
  const { post } = await fixture(t, {
    fetchImpl: async (url, init) => {
      captured = { url, init };
      return new Response(events, { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const body = { ...payload, tools: [{ type: 'function', name: 'probe', parameters: { type: 'object' } }], store: false };
  const r = await post(body, { headers: { ...headers, 'x-upstream-override': 'https://example.test', cookie: 'private' } });
  assert.equal(await r.text(), events);
  assert.equal(captured.url, 'https://api.githubcopilot.com/responses');
  assert.deepEqual(JSON.parse(captured.init.body), body);
  assert.equal(captured.init.redirect, 'error');
  assert.equal(captured.init.headers.authorization, 'Bearer synthetic-upstream-token');
  assert.equal(captured.init.headers['x-initiator'], 'user');
  assert.equal(captured.init.headers.cookie, undefined);
  assert.equal(captured.init.headers['x-upstream-override'], undefined);
});

test('client tool output is forwarded untouched and classified as agent continuation', async t => {
  let captured;
  const { post } = await fixture(t, { fetchImpl: async (_, init) => { captured = init; return new Response('{}'); } });
  const input = [
    { type: 'message', role: 'user', content: 'Synthetic request' },
    { type: 'function_call', name: 'probe', call_id: 'test', arguments: '{}' },
    { type: 'function_call_output', call_id: 'test', output: 'SYNTHETIC_RESULT' },
  ];
  await (await post({ ...payload, input })).text();
  assert.equal(captured.headers['x-initiator'], 'agent');
  assert.deepEqual(JSON.parse(captured.body).input, input);
});

test('models and compaction use only fixed native paths; queries and other endpoints are rejected', async t => {
  const paths = [];
  const { base } = await fixture(t, { fetchImpl: async url => { paths.push(url); return new Response('{}'); } });
  await (await fetch(`${base}/v1/models`, { headers })).text();
  await (await fetch(`${base}/v1/responses/compact`, { method: 'POST', headers, body: JSON.stringify(payload) })).text();
  for (const path of ['/v1/models?url=https://example.test', '/v1/chat/completions', '/v1/responses/arbitrary']) {
    assert.equal((await fetch(base + path, { headers })).status, 404);
  }
  assert.deepEqual(paths, ['https://api.githubcopilot.com/models', 'https://api.githubcopilot.com/responses/compact']);
});

test('rejects invalid and oversized requests before contacting Copilot', async t => {
  let calls = 0;
  const { post } = await fixture(t, { maxBodyBytes: 150, fetchImpl: async () => { calls++; return new Response('{}'); } });
  for (const [body, extra, status] of [
    [{ input: 'no model' }, {}, 400],
    [{ ...payload, input: {} }, {}, 400],
    [payload, { body: '{invalid' }, 400],
    [payload, { headers: { ...headers, 'content-type': 'text/plain' } }, 415],
    [{ ...payload, input: 'x'.repeat(151) }, {}, 413],
  ]) {
    const r = await post(body, extra);
    assert.equal(r.status, status);
    await r.body.cancel();
  }
  assert.equal(calls, 0);
});

test('a pre-stream 401 is retried once only when refreshed credentials change', async t => {
  const used = [];
  const refreshes = [];
  const { post } = await fixture(t, {
    getProviderToken: async (options = {}) => { refreshes.push(!!options.refresh); return options.refresh ? 'new' : 'old'; },
    fetchImpl: async (_, init) => {
      used.push(init.headers.authorization);
      return new Response('{}', { status: used.length === 1 ? 401 : 200 });
    },
  });
  assert.equal((await post()).status, 200);
  assert.deepEqual(used, ['Bearer old', 'Bearer new']);
  assert.deepEqual(refreshes, [false, true]);
});

test('unchanged unauthorized credentials, HTTP errors, and ambiguous network failures are not retried or echoed', async t => {
  for (const status of [401, 403, 429, 500, 'network']) {
    await t.test(String(status), async t => {
      let calls = 0;
      const { post } = await fixture(t, {
        fetchImpl: async () => {
          calls++;
          if (status === 'network') throw new Error('PRIVATE_PROVIDER_DETAIL');
          return new Response('PRIVATE_PROVIDER_DETAIL', { status, headers: { 'retry-after': '7' } });
        },
      });
      const r = await post();
      assert.equal(r.status, status === 'network' ? 502 : status);
      assert.equal((await r.text()).includes('PRIVATE_PROVIDER_DETAIL'), false);
      if (status === 429) assert.equal(r.headers.get('retry-after'), '7');
      assert.equal(calls, 1);
    });
  }
});

test('connection-establishment failures retry with the same request bytes, ID, and credential', async t => {
  const calls = [];
  const logs = [];
  let credentialReads = 0;
  const { post } = await fixture(t, {
    getProviderToken: async () => { credentialReads++; return 'synthetic-upstream-token'; },
    log: entry => logs.push(entry),
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (calls.length <= 2) {
        throw new TypeError('PRIVATE_NETWORK_DETAIL', {
          cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
        });
      }
      return new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const r = await post();
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'data: {"type":"response.completed"}\n\n');
  assert.equal(calls.length, 3);
  assert.equal(credentialReads, 1);
  for (const call of calls) {
    assert.equal(call.url, calls[0].url);
    assert.deepEqual(call.init, calls[0].init);
    assert.equal(call.init.headers['x-request-id'], r.headers.get('x-request-id'));
  }
  const failures = logs.filter(entry => entry.event === 'upstream_connection_error');
  assert.deepEqual(failures.map(entry => [entry.attempt, entry.reason, entry.retrying]), [
    [1, 'UND_ERR_CONNECT_TIMEOUT', true], [2, 'UND_ERR_CONNECT_TIMEOUT', true],
  ]);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
});

test('temporary DNS failures stop after six attempts and return a correlated, redacted 502', async t => {
  const logs = [];
  let calls = 0;
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: async () => {
      calls++;
      throw new TypeError('PRIVATE_NETWORK_DETAIL', {
        cause: Object.assign(new Error('PRIVATE_HOST'), { code: 'EAI_AGAIN' }),
      });
    },
  });
  const r = await post();
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.error.code, 'upstream_unavailable');
  assert.match(body.error.message, /does not indicate a rejected GitHub login/);
  assert.equal(calls, 6);
  const failures = logs.filter(entry => entry.event === 'upstream_connection_error');
  assert.deepEqual(failures.map(entry => entry.retrying), [true, true, true, true, true, false]);
  assert.deepEqual(failures.map(entry => entry.retry_delay_ms), [1, 2, 4, 8, 16, undefined]);
  assert.ok(failures.every(entry => entry.request_id === r.headers.get('x-request-id')));
  assert.equal(JSON.stringify([body, logs]).includes('PRIVATE_'), false);
});

test('a proxy running over an hour refreshes credentials and recovers beyond three connect timeouts', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let credentialReads = 0;
  const requests = [];
  const logs = [];
  const { post } = await fixture(t, {
    getProviderToken: createTokenSource(async () => `synthetic-credential-${++credentialReads}`),
    log: entry => logs.push(entry),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (requests.length > 1 && requests.length < 6) {
        throw new TypeError('PRIVATE_NETWORK_DETAIL', {
          cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
        });
      }
      return Response.json({ recovered: true });
    },
  });
  assert.equal((await post()).status, 200);
  t.mock.timers.tick(61 * 60_000);
  const r = await post({ ...payload, input: 'Synthetic continuation after one hour' });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { recovered: true });
  assert.equal(credentialReads, 2);
  assert.equal(requests.length, 6);
  assert.equal(requests[0].init.headers.authorization, 'Bearer synthetic-credential-1');
  assert.equal(requests[1].init.headers.authorization, 'Bearer synthetic-credential-2');
  for (const request of requests.slice(1)) {
    assert.deepEqual(request, requests[1]);
    assert.equal(request.init.headers['x-request-id'], r.headers.get('x-request-id'));
  }
  const recovered = logs.find(entry => entry.event === 'upstream_connection_recovered');
  assert.equal(recovered.attempt, 5);
  assert.equal(recovered.request_id, r.headers.get('x-request-id'));
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
});

test('exhausted connect timeouts report the safe reason, attempt count, and request ID', async t => {
  const logs = [];
  let calls = 0;
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: async () => {
      calls++;
      throw new TypeError('PRIVATE_NETWORK_DETAIL', {
        cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
      });
    },
  });
  const r = await post();
  assert.equal(r.status, 502);
  const body = await r.json();
  assert.equal(body.error.code, 'upstream_connect_timeout');
  assert.match(body.error.message, /UND_ERR_CONNECT_TIMEOUT.*after 6 attempts/);
  assert.match(body.error.message, /does not indicate a rejected GitHub login/);
  assert.equal(calls, 6);
  assert.ok(logs.every(entry => entry.request_id === r.headers.get('x-request-id')));
  assert.equal(logs.some(entry => entry.event === 'upstream_connection_recovered'), false);
  assert.equal(JSON.stringify([body, logs]).includes('PRIVATE_'), false);
});

test('real TLS-handshake resets are retried before any HTTP request can be sent', async t => {
  const peer = createTcpServer(socket => {
    socket.once('data', () => socket.destroy());
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  t.after(() => new Promise(resolve => peer.close(resolve)));
  const logs = [];
  let calls = 0;
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: async (_, init) => {
      if (++calls === 3) return new Response('{}');
      return fetch(`https://127.0.0.1:${peer.address().port}`, init);
    },
  });
  const r = await post();
  assert.equal(r.status, 200);
  await r.body.cancel();
  assert.equal(calls, 3);
  const failures = logs.filter(entry => entry.event === 'upstream_connection_error');
  assert.equal(failures.length, 2);
  assert.ok(failures.every(entry => entry.reason === 'ECONNRESET' &&
    entry.phase === 'connect' && entry.retrying));
});

test('real resets after HTTP headers are sent are not replayed', async t => {
  let receivedHttp = false;
  const peer = createTcpServer(socket => {
    socket.once('data', data => {
      receivedHttp = data.toString().startsWith('POST ');
      socket.destroy();
    });
  });
  peer.listen(0, '127.0.0.1');
  await once(peer, 'listening');
  t.after(() => new Promise(resolve => peer.close(resolve)));
  let calls = 0;
  const logs = [];
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: (_, init) => {
      calls++;
      return fetch(`http://127.0.0.1:${peer.address().port}`, init);
    },
  });
  const r = await post();
  assert.equal(r.status, 502);
  await r.body.cancel();
  assert.equal(receivedHttp, true);
  assert.equal(calls, 1);
  assert.equal(logs[0].phase, 'unknown');
  assert.equal(logs[0].retrying, false);
});

test('connection diagnostics do not make certificate failures or unknown errors retryable', async t => {
  for (const code of ['CERT_HAS_EXPIRED', 'PRIVATE_CODE']) {
    await t.test(code, async t => {
      let calls = 0;
      const logs = [];
      const { post } = await fixture(t, {
        log: entry => logs.push(entry),
        fetchImpl: async () => {
          calls++;
          const error = Object.assign(new Error('PRIVATE_DETAIL'), { code });
          channel('undici:client:connectError').publish({ error });
          throw new TypeError('fetch failed', { cause: error });
        },
      });
      const r = await post();
      assert.equal(r.status, 502);
      await r.body.cancel();
      assert.equal(calls, 1);
      assert.equal(logs[0].phase, 'connect');
      assert.equal(logs[0].retrying, false);
      assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
    });
  }
});

test('ambiguous delivery failures, certificate errors, and unknown error codes are never replayed', async t => {
  for (const code of ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET',
    'UND_ERR_HEADERS_TIMEOUT', 'CERT_HAS_EXPIRED', 'PRIVATE_ERROR_CODE']) {
    await t.test(code, async t => {
      let calls = 0;
      const logs = [];
      const { post } = await fixture(t, {
        log: entry => logs.push(entry),
        fetchImpl: async () => {
          calls++;
          throw new TypeError('PRIVATE_NETWORK_DETAIL', { cause: Object.assign(new Error(), { code }) });
        },
      });
      const r = await post();
      assert.equal(r.status, 502);
      await r.body.cancel();
      assert.equal(calls, 1);
      assert.equal(logs[0].reason, code === 'PRIVATE_ERROR_CODE' ? 'unknown' : code);
      assert.equal(logs[0].retrying, false);
      assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
    });
  }
});

test('aggregate connection errors retry only when every cause proves a connection-establishment failure', async t => {
  for (const codes of [['ECONNREFUSED', 'ENETUNREACH'], ['ECONNREFUSED', 'ECONNRESET'], ['ECONNREFUSED', undefined]]) {
    await t.test(codes.join(', '), async t => {
      let calls = 0;
      const { post } = await fixture(t, {
        fetchImpl: async () => {
          if (++calls === 1) {
            throw new TypeError('fetch failed', {
              cause: new AggregateError(codes.map(code => Object.assign(new Error(), { code }))),
            });
          }
          return new Response('{}');
        },
      });
      const r = await post();
      const safe = codes.every(code => code === 'ECONNREFUSED' || code === 'ENETUNREACH');
      assert.equal(r.status, safe ? 200 : 502);
      await r.body.cancel();
      assert.equal(calls, safe ? 2 : 1);
    });
  }
});

test('the overall deadline cancels connection retry backoff without another attempt', async t => {
  let calls = 0;
  const { post } = await fixture(t, {
    timeoutMs: 100,
    connectionRetryDelaysMs: [250, 1_000, 4_000, 10_000, 20_000],
    fetchImpl: async () => {
      calls++;
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error(), { code: 'ECONNREFUSED' }),
      });
    },
  });
  const r = await post();
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.code, 'upstream_timeout');
  assert.equal(calls, 1);
});

test('client cancellation stops connection retry backoff and releases the active request', async t => {
  let calls = 0;
  let onRetry;
  let onFinished;
  const retry = new Promise(resolve => { onRetry = resolve; });
  const done = new Promise(resolve => { onFinished = resolve; });
  const { post } = await fixture(t, {
    maxConcurrent: 1,
    connectionRetryDelaysMs: [250, 1_000, 4_000, 10_000, 20_000],
    log: entry => {
      if (entry.event === 'upstream_connection_error') onRetry();
      if (entry.event === 'request') onFinished();
    },
    fetchImpl: async () => {
      if (++calls === 1) throw Object.assign(new Error('PRIVATE_DETAIL'), { code: 'ECONNREFUSED' });
      return Response.json({ recovered: true });
    },
  });
  const controller = new AbortController();
  const cancelled = assert.rejects(post(payload, { signal: controller.signal }), { name: 'AbortError' });
  await retry;
  controller.abort();
  await cancelled;
  await done;
  assert.equal(calls, 1);
  assert.equal((await post()).status, 200);
  assert.equal(calls, 2);
});

test('SSE is delivered incrementally and client cancellation aborts the upstream operation', async t => {
  let controller;
  let aborted;
  const cancellation = new Promise(resolve => { aborted = resolve; });
  const { post } = await fixture(t, {
    fetchImpl: async (_, init) => {
      init.signal.addEventListener('abort', aborted, { once: true });
      return new Response(new ReadableStream({
        start(c) { controller = c; c.enqueue(new TextEncoder().encode('data: first\n\n')); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const r = await post();
  const reader = r.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: first\n\n');
  controller.enqueue(new TextEncoder().encode('data: second\n\n'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: second\n\n');
  await reader.cancel();
  await Promise.race([cancellation, new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Upstream was not cancelled')), 3000);
    timer.unref();
  })]);
});

test('a partially streamed failure sends an explicit redacted SSE error without repeating generation', async t => {
  let stream;
  let calls = 0;
  const logs = [];
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({
        start(c) { stream = c; c.enqueue(new TextEncoder().encode('data: synthetic\n\n')); },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const r = await post();
  const reader = r.body.getReader();
  await reader.read();
  stream.error(new Error('PRIVATE_PROVIDER_DETAIL'));
  const error = new TextDecoder().decode((await reader.read()).value);
  assert.match(error, /event: response.failed\n/);
  assert.match(error, /"code":"upstream_stream_error"/);
  const failure = JSON.parse(error.split('\n')[1].slice(6));
  assert.equal(failure.type, 'response.failed');
  assert.equal(failure.response.status, 'failed');
  assert.match(failure.response.error.message, new RegExp(r.headers.get('x-request-id')));
  assert.equal((await reader.read()).done, true);
  assert.equal(calls, 1);
  assert.equal(logs.find(entry => entry.event === 'upstream_stream_error').reason, 'unknown');
  assert.equal(error.includes('PRIVATE_PROVIDER_DETAIL'), false);
  assert.equal(JSON.stringify(logs).includes('PRIVATE_PROVIDER_DETAIL'), false);
});

test('valid final terminal events missing a delimiter are repaired, including split UTF-8 and CRLF', async t => {
  for (const ending of ['', '\n', '\r', '\r\n']) {
    await t.test(JSON.stringify(ending), async t => {
      const event = 'event: response.completed\r\ndata: {"type":"response.completed","text":"\u4f60"}';
      const bytes = new TextEncoder().encode(event + ending);
      const logs = [];
      const { post } = await fixture(t, {
        log: entry => logs.push(entry),
        fetchImpl: async () => new Response(new ReadableStream({
          start(c) {
            for (const byte of bytes) c.enqueue(Uint8Array.of(byte));
            c.close();
          },
        }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }),
      });
      const r = await post();
      const text = await r.text();
      assert.equal(text, event + ending + (ending.endsWith('\n') ? '\n' : '\n\n'));
      assert.equal(logs.at(-1).terminal_event, 'response.completed');
      assert.equal(logs.at(-1).repaired_final_delimiter, true);
      assert.equal(logs.some(entry => entry.event === 'upstream_stream_error'), false);
    });
  }
});

test('terminal events finish promptly and cancel upstream without waiting for HTTP EOF', async t => {
  for (const type of ['response.completed', 'response.failed', 'response.incomplete']) {
    await t.test(type, async t => {
      let cancelled = false;
      const frame = `event: ${type}\r\ndata: {"type":"${type}"}\r\n\r\n`;
      const { post } = await fixture(t, {
        timeoutMs: 200,
        fetchImpl: async () => new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(frame)); },
          cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream' } }),
      });
      const r = await post();
      assert.equal(await r.text(), frame);
      assert.equal(cancelled, true);
    });
  }
});

test('a clean HTTP EOF without a terminal event is not reported as response completion or retried', async t => {
  for (const tail of ['', 'data: [DONE]\n\n', 'data: {"type":"response.completed"', 'data: {"type":"response.output_text.delta","delta":"response.completed"}\n\n']) {
    await t.test(JSON.stringify(tail), async t => {
      const logs = [];
      let calls = 0;
      const initial = 'data: {"type":"response.created"}\n\n';
      const { post } = await fixture(t, {
        log: entry => logs.push(entry),
        fetchImpl: async () => {
          calls++;
          return new Response(initial + tail, { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      const r = await post();
      const text = await r.text();
      assert.ok(text.startsWith(initial));
      assert.match(text, /event: response.failed\ndata: \{"type":"response.failed"/);
      assert.match(text, /"code":"upstream_stream_incomplete"/);
      assert.equal(text.includes('"type":"response.completed"'), false);
      assert.equal(calls, 1);
      assert.equal(logs.find(entry => entry.event === 'upstream_stream_error').reason, 'upstream_stream_incomplete');
      assert.equal(logs.at(-1).terminal_event, undefined);
    });
  }
});

const sse = event => `data: ${JSON.stringify(event)}\n\n`;
const reasoningPrefix = id => sse({ type: 'response.created', response: { id } }) +
  sse({ type: 'response.in_progress', response: { id } }) +
  sse({ type: 'response.output_item.added', item: { type: 'reasoning', id: `${id}_reasoning` } });

test('a stateless stream truncated during initial reasoning recovers without leaking the failed prefix', async t => {
  const logs = [];
  const requests = [];
  const recovered = reasoningPrefix('recovered') +
    sse({ type: 'response.output_text.delta', delta: 'RECOVERED' }) +
    sse({ type: 'response.completed', response: { id: 'recovered' } });
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return new Response(requests.length === 1 ? reasoningPrefix('discarded') : recovered,
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const body = { ...payload, store: false, tools: [{ type: 'function', name: 'probe' }] };
  const r = await post(body);
  assert.equal(await r.text(), recovered);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(JSON.parse(requests[1].init.body), body);
  const retry = logs.find(entry => entry.event === 'upstream_stream_retry');
  assert.equal(retry.reason, 'upstream_stream_incomplete');
  assert.equal(retry.last_item_type, 'reasoning');
  assert.equal(retry.output_committed, false);
  assert.equal(retry.request_id, r.headers.get('x-request-id'));
  assert.equal(logs.at(-1).stream_attempt, 2);
  assert.equal(logs.at(-1).terminal_event, 'response.completed');
  assert.equal(JSON.stringify(logs).includes('discarded'), false);
});

test('stateless early stream recovery stops after three attempts without inventing completion', async t => {
  const logs = [];
  let calls = 0;
  const { post } = await fixture(t, {
    log: entry => logs.push(entry),
    fetchImpl: async () => {
      return new Response(reasoningPrefix(`discarded_${++calls}`),
        { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const text = await (await post({ ...payload, store: false })).text();
  assert.equal(calls, 3);
  assert.equal(text.includes('discarded'), false);
  const event = JSON.parse(text.split('\n')[1].slice(6));
  assert.equal(event.type, 'response.failed');
  assert.equal(event.response.error.code, 'upstream_stream_incomplete');
  assert.equal(logs.filter(entry => entry.event === 'upstream_stream_retry').length, 2);
  assert.equal(logs.at(-1).stream_attempt, 3);
  assert.equal(logs.at(-1).terminal_event, undefined);
});

test('delivered text, reasoning, tool-call events, unknown events, and large prefixes are never replayed', async t => {
  for (const event of [
    { type: 'response.output_text.delta', delta: 'visible output' },
    { type: 'response.reasoning_summary_text.delta', delta: 'visible reasoning' },
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'probe' } },
    { type: 'response.function_call_arguments.delta', delta: '{}' },
    { type: 'response.custom_tool_call_input.delta', delta: 'probe' },
    { type: 'future_unknown_event' },
    { type: 'response.output_item.added', item: { type: 'reasoning', encrypted_content: 'x'.repeat(1024 * 1024) } },
  ]) {
    await t.test(event.type, async t => {
      let calls = 0;
      const source = reasoningPrefix('original') + sse(event);
      const { post } = await fixture(t, {
        fetchImpl: async () => {
          calls++;
          return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      const text = await (await post({ ...payload, store: false })).text();
      assert.ok(text.startsWith(source));
      assert.match(text, /"code":"upstream_stream_incomplete"/);
      assert.equal(calls, 1);
    });
  }
});

test('stored, stateful, background, and hosted-tool requests are not regenerated even before output', async t => {
  for (const options of [
    { store: undefined }, { store: true }, { previous_response_id: 'resp_previous' },
    { conversation: 'conv_synthetic' }, { background: true },
    { tools: [{ type: 'web_search' }] }, { tools: [{ type: 'mcp' }] },
    { tools: [{ type: 'future_tool' }] },
  ]) {
    await t.test(JSON.stringify(options), async t => {
      let calls = 0;
      const source = reasoningPrefix('original');
      const { post } = await fixture(t, {
        fetchImpl: async () => {
          calls++;
          return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      const text = await (await post({ ...payload, store: false, ...options })).text();
      assert.ok(text.startsWith(source));
      assert.equal(calls, 1);
    });
  }
});

test('early recovery never retries native terminal failures or rate limits on a replacement request', async t => {
  for (const type of ['response.failed', 'response.incomplete', 'error', 'retry_429']) {
    await t.test(type, async t => {
      let calls = 0;
      const { post } = await fixture(t, {
        fetchImpl: async () => {
          calls++;
          if (type === 'retry_429') {
            return calls === 1 ?
              new Response(reasoningPrefix('discarded'), { headers: { 'content-type': 'text/event-stream' } }) :
              new Response('PRIVATE_RATE_LIMIT', { status: 429, headers: { 'retry-after': '7' } });
          }
          return new Response(sse({ type, response: { error: { code: 'synthetic_failure' } } }),
            { headers: { 'content-type': 'text/event-stream' } });
        },
      });
      const text = await (await post({ ...payload, store: false })).text();
      assert.equal(calls, type === 'retry_429' ? 2 : 1);
      assert.equal(text.includes('PRIVATE_'), false);
      if (type === 'retry_429') assert.match(text, /"code":"copilot_http_429"/);
    });
  }
});

test('a transient body reset before committed output can recover without repeating partial frames', async t => {
  let calls = 0;
  const complete = sse({ type: 'response.completed', response: { id: 'recovered' } });
  const { post } = await fixture(t, {
    fetchImpl: async () => {
      if (++calls > 1) return new Response(complete, { headers: { 'content-type': 'text/event-stream' } });
      let reads = 0;
      return new Response(new ReadableStream({
        pull(c) {
          if (++reads === 1) c.enqueue(new TextEncoder().encode(reasoningPrefix('discarded')));
          else c.error(Object.assign(new Error('PRIVATE_TRANSPORT'), { code: 'ECONNRESET' }));
        },
      }), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  const text = await (await post({ ...payload, store: false })).text();
  assert.equal(text, complete);
  assert.equal(calls, 2);
});

test('early stream retry backoff respects the original deadline and client cancellation', async t => {
  await t.test('deadline', async t => {
    let calls = 0;
    const { post } = await fixture(t, {
      timeoutMs: 100,
      fetchImpl: async () => {
        calls++;
        return new Response(reasoningPrefix('discarded'), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const text = await (await post({ ...payload, store: false })).text();
    assert.match(text, /"code":"upstream_timeout"/);
    assert.equal(text.includes('discarded'), false);
    assert.equal(calls, 1);
  });
  await t.test('client cancellation', async t => {
    let calls = 0;
    let onRetry;
    let onFinished;
    const retry = new Promise(resolve => { onRetry = resolve; });
    const done = new Promise(resolve => { onFinished = resolve; });
    const { post } = await fixture(t, {
      log: entry => {
        if (entry.event === 'upstream_stream_retry') onRetry();
        if (entry.event === 'request') onFinished();
      },
      fetchImpl: async () => {
        calls++;
        return new Response(reasoningPrefix('discarded'), { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const r = await post({ ...payload, store: false });
    await retry;
    await r.body.cancel();
    await done;
    assert.equal(calls, 1);
  });
});

test('heartbeats keep idle streams alive but are never inserted into partially received events', async t => {
  let upstream;
  const { post } = await fixture(t, {
    heartbeatMs: 10,
    fetchImpl: async () => new Response(new ReadableStream({
      start(c) { upstream = c; },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const r = await post();
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  assert.equal(decoder.decode((await reader.read()).value), ': keepalive\n\n');
  upstream.enqueue(new TextEncoder().encode('data: {"type":"response.com'));
  await new Promise(resolve => setTimeout(resolve, 35));
  upstream.enqueue(new TextEncoder().encode('pleted"}\n\n'));
  assert.equal(decoder.decode((await reader.read()).value), 'data: {"type":"response.completed"}\n\n');
  assert.equal((await reader.read()).done, true);
});

test('an idle streaming deadline emits a timeout error and cancels the upstream read', async t => {
  let cancelled = false;
  const { post } = await fixture(t, {
    timeoutMs: 100,
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const r = await post();
  assert.match(await r.text(), /"code":"upstream_timeout"/);
  assert.equal(cancelled, true);
});

test('multiline data and CR-only SSE delimiters preserve the native terminal event', async t => {
  const frame = 'event: response.completed\rdata: {"type":\rdata: "response.completed"}\r\r';
  const { post } = await fixture(t, {
    fetchImpl: async () => new Response(frame, { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.equal(await (await post()).text(), frame);
});

test('a reset inside an event discards only the unfinished frame and keeps the SSE error well framed', async t => {
  let upstream;
  const initial = 'data: {"type":"response.created"}\n\n';
  const { post } = await fixture(t, {
    fetchImpl: async () => new Response(new ReadableStream({
      start(c) { upstream = c; c.enqueue(new TextEncoder().encode(initial)); },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  });
  const r = await post();
  const reader = r.body.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), initial);
  upstream.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"PRIVATE_UNFINISHED'));
  upstream.error(Object.assign(new Error('PRIVATE_TRANSPORT'), { code: 'ECONNRESET' }));
  const error = new TextDecoder().decode((await reader.read()).value);
  assert.ok(error.startsWith('event: response.failed\ndata: '));
  assert.equal(JSON.parse(error.split('\n')[1].slice(6)).response.error.code, 'upstream_stream_error');
  assert.equal(error.includes('PRIVATE_'), false);
  assert.equal((await reader.read()).done, true);
});

test('a null SSE body yields an explicit incomplete-stream error', async t => {
  const { post } = await fixture(t, {
    fetchImpl: async () => new Response(null, { headers: { 'content-type': 'text/event-stream' } }),
  });
  assert.match(await (await post()).text(), /"code":"upstream_stream_incomplete"/);
});

test('Copilot error envelopes become Codex-compatible failures without echoing provider details', async t => {
  for (const [event, expected] of [
    [{ type: 'error', code: 'request_timeout', message: 'PRIVATE_DETAIL' }, 'request_timeout'],
    [{ type: 'error', error: { code: 'server_error', message: 'PRIVATE_DETAIL' } }, 'server_error'],
    [{ error: { code: 'PRIVATE_CODE', message: 'PRIVATE_DETAIL' } }, 'unknown'],
  ]) {
    await t.test(expected, async t => {
      const logs = [];
      let cancelled = false;
      const { post } = await fixture(t, {
        log: entry => logs.push(entry),
        fetchImpl: async () => new Response(new ReadableStream({
          start(c) { c.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify(event)}\n\n`)); },
          cancel() { cancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream' } }),
      });
      const r = await post();
      const text = await r.text();
      const failure = JSON.parse(text.split('\n')[1].slice(6));
      assert.equal(failure.type, 'response.failed');
      assert.equal(failure.response.error.code, 'upstream_reported_error');
      assert.equal(cancelled, true);
      const diagnostic = logs.find(entry => entry.event === 'upstream_stream_error');
      assert.equal(diagnostic.provider_error_code, expected);
      assert.equal(diagnostic.last_event, 'error');
      assert.equal(JSON.stringify([text, logs]).includes('PRIVATE_'), false);
    });
  }
});

test('concurrency is bounded while an upstream request is pending', async t => {
  let release;
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  const { post } = await fixture(t, {
    maxConcurrent: 1,
    fetchImpl: () => { started(); return new Promise(resolve => { release = resolve; }); },
  });
  const first = post();
  await entered;
  const second = await post();
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'proxy_busy');
  release(new Response('{}'));
  assert.equal((await first).status, 200);
});

test('upstream deadline aborts the request and surfaces a timeout', async t => {
  const { post } = await fixture(t, {
    timeoutMs: 40,
    fetchImpl: (_, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('abort')))),
  });
  const r = await post();
  assert.equal(r.status, 504);
  assert.equal((await r.json()).error.code, 'upstream_timeout');
});

test('credential caching deduplicates reads, refreshes explicitly, and redacts helper errors', async () => {
  let count = 0;
  const source = createTokenSource(async () => { count++; return `synthetic-${count}`; });
  assert.deepEqual(await Promise.all([source(), source()]), ['synthetic-1', 'synthetic-1']);
  assert.equal(await source(), 'synthetic-1');
  assert.equal(await source({ refresh: true }), 'synthetic-2');
  assert.equal(count, 2);
  let fail = true;
  const recover = createTokenSource(async () => { if (fail) throw new Error('PRIVATE_CREDENTIAL'); return 'recovered'; });
  await assert.rejects(recover(), error => error.status === 503 && !error.message.includes('PRIVATE_CREDENTIAL'));
  fail = false;
  assert.equal(await recover(), 'recovered');
});

test('credential-helper timeout is not misreported as a missing login or logged with sensitive details', async () => {
  const logs = [];
  const source = githubTokenSource(process.execPath, {
    log: entry => logs.push(entry),
    executeImpl: async () => {
      throw Object.assign(new Error('PRIVATE_CREDENTIAL_DETAIL'), {
        killed: true, stderr: 'PRIVATE_CREDENTIAL_DETAIL', stdout: 'PRIVATE_TOKEN',
      });
    },
  });
  await assert.rejects(source(), error => error.status === 503 &&
    error.code === 'github_auth_timeout' && !error.message.includes('gh auth login'));
  assert.equal(logs[0].reason, 'timeout');
  assert.equal(JSON.stringify(logs).includes('PRIVATE_'), false);
});

test('credential refresh rereads only stored auth and clears inherited app tokens', async () => {
  const previous = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'PRIVATE_TRANSIENT_TOKEN';
  try {
    let reads = 0;
    const source = githubTokenSource(process.execPath, {
      executeImpl: async (_, args, options) => {
        assert.deepEqual(args, ['auth', 'token', '--hostname', 'github.com']);
        assert.equal(options.env.GH_TOKEN, undefined);
        assert.equal(options.env.COPILOT_PROXY_LOCAL_TOKEN, undefined);
        return { stdout: `stored-test-token-${++reads}\n` };
      },
    });
    assert.equal(await source(), 'stored-test-token-1');
    assert.equal(await source(), 'stored-test-token-1');
    assert.equal(await source({ refresh: true }), 'stored-test-token-2');
  } finally {
    if (previous === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous;
  }
});
