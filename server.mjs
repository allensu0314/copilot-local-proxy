import http from 'node:http';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';

const execute = promisify(execFile);
const upstream = 'https://api.githubcopilot.com';
const connectionErrors = new Set([
  'EAI_AGAIN', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT',
]);
const transientConnectErrors = new Set([
  ...connectionErrors, 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET',
]);
const failedConnections = new WeakSet();
channel('undici:client:connectError').subscribe(({ error }) => {
  // This event precedes dispatch of HTTP headers, unlike request:error.
  if (error && typeof error === 'object') failedConnections.add(error);
});
const transportErrors = new Set([
  ...connectionErrors, 'ENOTFOUND', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function transportFailure(error) {
  const codes = [];
  const seen = new Set();
  let connectFailure = false;
  function visit(value, depth = 0, beforeSend = false) {
    if (!value || typeof value !== 'object' || seen.has(value) || depth > 5) return false;
    seen.add(value);
    if (failedConnections.has(value)) {
      beforeSend = true;
      connectFailure = true;
    }
    if (typeof value.code === 'string') codes.push(value.code);
    const nested = [
      ...(value.cause === undefined ? [] : [value.cause]),
      ...(Array.isArray(value.errors) ? value.errors : []),
    ].map(nested => visit(nested, depth + 1, beforeSend));
    const knownConnection = (beforeSend ? transientConnectErrors : connectionErrors).has(value.code);
    return (value.code === undefined || knownConnection) &&
      (nested.length > 0 ? nested.every(Boolean) : knownConnection);
  }
  const retryable = visit(error);
  return {
    reason: codes.find(code => transportErrors.has(code)) || 'unknown',
    // Resets and response timeouts can happen after Copilot accepts the POST.
    retryable,
    phase: connectFailure ? 'connect' : 'unknown',
  };
}

class ProxyError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function createTokenSource(readToken, ttlMs = 300_000) {
  let cached;
  let expires = 0;
  let pending;
  return async ({ refresh = false } = {}) => {
    if (!refresh && cached && Date.now() < expires) return cached;
    if (!pending) {
      pending = Promise.resolve().then(readToken).then(token => {
        if (typeof token !== 'string' || !token.trim()) throw new Error('Empty credential');
        cached = token.trim();
        expires = Date.now() + ttlMs;
        return cached;
      }).catch(error => {
        cached = undefined;
        expires = 0;
        if (error instanceof ProxyError) throw error;
        throw new ProxyError(503, 'github_auth_unavailable',
          'Stored GitHub credential lookup failed. Check the redacted service log before changing your login.');
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
}

function resolveGh(configured) {
  if (existsSync(configured)) return configured;
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const candidates = readdirSync(local, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && entry.name.startsWith('copilot-desktop-gh-'))
      .map(entry => entry.name).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const candidate of candidates) {
      const path = join(local, candidate, 'gh.exe');
      if (existsSync(path)) return path;
    }
  }
  return 'gh.exe';
}

export function githubTokenSource(ghPath, { executeImpl = execute, log = () => {} } = {}) {
  return createTokenSource(async () => {
    const env = { ...process.env };
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'COPILOT_GITHUB_TOKEN', 'COPILOT_PROXY_LOCAL_TOKEN']) {
      delete env[key];
    }
    const started = Date.now();
    try {
      const { stdout } = await executeImpl(resolveGh(ghPath),
        ['auth', 'token', '--hostname', 'github.com'],
        { env, windowsHide: true, timeout: 15_000, maxBuffer: 16_384 });
      if (!stdout.trim()) throw new ProxyError(503, 'github_auth_empty', 'GitHub CLI returned no stored credential.');
      log({ event: 'credential_read', status: 'ok', duration_ms: Date.now() - started });
      return stdout;
    } catch (error) {
      if (error instanceof ProxyError) throw error;
      const reason = error.killed ? 'timeout' :
        ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code.toLowerCase() :
        /no oauth token|not logged|no token found/i.test(error.stderr || '') ? 'not_signed_in' : 'helper_failed';
      log({ event: 'credential_read', status: 'error', reason, duration_ms: Date.now() - started });
      throw new ProxyError(503, `github_auth_${reason}`, reason === 'timeout' ?
        'Stored GitHub credential lookup timed out. Check the CopilotProxy task and service log; sign-in may still be valid.' :
        reason === 'not_signed_in' ? 'No stored GitHub login was found. Sign in with gh auth login --hostname github.com.' :
        'The GitHub credential helper failed. Check the redacted service log before changing your login.');
    }
  });
}

function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => finish(new ProxyError(408, 'request_timeout', 'Request body timed out.')), 30_000);
    timer.unref();
    const onData = chunk => {
      size += chunk.length;
      if (size > maxBytes) {
        req.pause();
        finish(new ProxyError(413, 'request_too_large', `Request exceeds ${maxBytes} bytes.`));
      } else {
        chunks.push(chunk);
      }
    };
    const onEnd = () => finish(null, Buffer.concat(chunks));
    const onError = () => finish(new ProxyError(400, 'invalid_body', 'Request body was interrupted.'));
    function finish(error, body) {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      if (error) reject(error); else resolveBody(body);
    }
    req.on('data', onData).once('end', onEnd).once('error', onError).once('aborted', onError);
  });
}

function json(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(status >= 400 ? { connection: 'close' } : {}),
  });
  res.end(JSON.stringify(value));
}

function initiator(body) {
  if (typeof body.input === 'string') return 'user';
  const last = body.input?.at(-1);
  return last?.role === 'user' ? 'user' : 'agent';
}

function upstreamError(status) {
  if (status === 401) return 'GitHub authentication was rejected. Renew the stored gh login, then retry.';
  if (status === 403) return 'Copilot denied this request. Check your license, model entitlement, and organization policy.';
  if (status === 429) return 'Copilot rate or usage limit reached. Honor Retry-After or check your allowance.';
  if (status === 400 || status === 422) return 'Copilot rejected the request. Check the model and native Responses request schema.';
  if (status === 404) return 'The requested model or native Copilot endpoint is unavailable.';
  return `Copilot returned HTTP ${status}.`;
}

const terminalEvents = new Set(['response.completed', 'response.failed', 'response.incomplete', 'error']);
const streamEvents = new Set([
  ...terminalEvents, 'response.created', 'response.in_progress',
  'response.output_item.added', 'response.output_item.done',
  'response.content_part.added', 'response.content_part.done',
  'response.output_text.delta', 'response.output_text.done',
  'response.function_call_arguments.delta', 'response.function_call_arguments.done',
  'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done',
]);
const providerErrorCodes = new Set([
  'timeout', 'request_timeout', 'upstream_timeout', 'server_error', 'internal_error',
  'internal_server_error', 'server_is_overloaded', 'rate_limit_exceeded',
  'context_length_exceeded', 'invalid_prompt', 'content_filter', 'insufficient_quota',
]);

async function* responseEvents(body, { signal, heartbeatMs, state }) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pendingRead;
  let buffer = '';
  let scan = 0;
  let lineStart = 0;
  let ended = false;
  function inspect(frame) {
    const lines = frame.split(/\r\n|\r|\n/);
    const data = lines
      .filter(line => line === 'data' || line.startsWith('data:'))
      .map(line => line === 'data' ? '' : line.slice(5).replace(/^ /, '')).join('\n');
    let event;
    try { event = JSON.parse(data); } catch { return false; }
    state.last_event = streamEvents.has(event?.type) ? event.type : 'unknown';
    const errorEvent = event?.type === 'error' ||
      (!event?.type && (event?.error || lines.some(line => /^event: ?error$/.test(line))));
    if (errorEvent) {
      state.last_event = 'error';
      const code = event?.error?.code ?? event?.code;
      state.provider_error_code = providerErrorCodes.has(code) ? code : 'unknown';
      throw new ProxyError(502, 'upstream_reported_error',
        'Copilot reported a stream failure. Partial output was not replayed.');
    }
    state.terminal_event = terminalEvents.has(event?.type) ? event.type : undefined;
    return true;
  }
  try {
    while (true) {
      if (!ended) {
        pendingRead ??= reader.read();
        const heartbeat = new AbortController();
        let next;
        try {
          next = await Promise.race([
            pendingRead,
            delay(heartbeatMs, null, { signal: AbortSignal.any([signal, heartbeat.signal]) }),
          ]);
        } finally { heartbeat.abort(); }
        signal.throwIfAborted();
        if (next === null) {
          // Comments are only safe between events, never inside partial JSON.
          if (!buffer) yield ': keepalive\n\n';
          continue;
        }
        pendingRead = undefined;
        ended = next.done;
        buffer += ended ? decoder.decode() : decoder.decode(next.value, { stream: true });
      }
      while (scan < buffer.length) {
        const char = buffer[scan];
        if (char !== '\r' && char !== '\n') { scan++; continue; }
        if (char === '\r' && scan === buffer.length - 1 && !ended) break;
        const end = scan + (char === '\r' && buffer[scan + 1] === '\n' ? 2 : 1);
        const blank = scan === lineStart;
        scan = end;
        lineStart = end;
        if (!blank) continue;
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end);
        scan = 0;
        lineStart = 0;
        if (Buffer.byteLength(frame) > 16 * 1024 * 1024) {
          throw new ProxyError(502, 'upstream_event_too_large', 'Copilot returned an oversized stream event.');
        }
        inspect(frame);
        yield frame;
        if (state.terminal_event) return;
      }
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        throw new ProxyError(502, 'upstream_event_too_large', 'Copilot returned an oversized stream event.');
      }
      if (!ended) continue;
      // Some upstreams close after complete JSON without the SSE blank line.
      // Dispatch that genuine event; never synthesize response.completed.
      if (buffer && inspect(buffer)) {
        state.repaired_final_delimiter = true;
        yield buffer + (buffer.endsWith('\n') ? '\n' : '\n\n');
        if (state.terminal_event) return;
      }
      throw new ProxyError(502, 'upstream_stream_incomplete',
        'Copilot ended the stream before a terminal response event. Partial output was not replayed.');
    }
  } finally {
    // Cancellation must also release a pending read during an idle heartbeat.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createProxy({
  localToken, getProviderToken, fetchImpl = fetch, log = () => {},
  maxBodyBytes = 16 * 1024 * 1024, maxConcurrent = 4, timeoutMs = 600_000,
  heartbeatMs = 15_000,
}) {
  if (typeof localToken !== 'string' || localToken.length < 32) throw new Error('A strong local bearer key is required.');
  const expected = Buffer.from(`Bearer ${localToken}`);
  let active = 0;
  const server = http.createServer({ maxHeaderSize: 16_384 }, (req, res) => {
    const controller = new AbortController();
    const started = Date.now();
    const requestId = randomUUID();
    res.setHeader('x-request-id', requestId);
    let counted = false;
    let abortReason;
    let streaming = false;
    const streamState = { last_event: 'none' };
    const timer = setTimeout(() => {
      abortReason = 'deadline';
      controller.abort();
    }, timeoutMs);
    timer.unref();
    const clientClosed = () => {
      if (!controller.signal.aborted) {
        abortReason = 'client_disconnected';
        controller.abort();
      }
    };
    req.once('aborted', clientClosed);
    res.once('close', () => { if (!res.writableFinished) clientClosed(); });

    async function handle() {
      const port = server.address().port;
      if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
        throw new ProxyError(403, 'invalid_host', 'Only literal loopback hosts are accepted.');
      }
      if (req.headers.origin !== undefined) throw new ProxyError(403, 'browser_origin_denied', 'Browser-origin requests are not allowed.');
      if (req.method === 'GET' && req.url === '/health') {
        json(res, 200, { status: 'ok', service: 'copilot-proxy' });
        return;
      }
      const received = Buffer.from(req.headers.authorization || '');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new ProxyError(401, 'unauthorized', 'A valid local proxy bearer key is required.');
      }
      const isModels = req.method === 'GET' && req.url === '/v1/models';
      const isResponses = req.method === 'POST' && ['/v1/responses', '/v1/responses/compact'].includes(req.url);
      if (!isModels && !isResponses) throw new ProxyError(404, 'not_found', 'This proxy exposes only /health, /v1/models, and native /v1/responses endpoints.');
      if (active >= maxConcurrent) {
        res.setHeader('retry-after', '2');
        throw new ProxyError(429, 'proxy_busy', 'The local proxy is at its concurrency limit. Retry later.');
      }
      active++;
      counted = true;
      let raw;
      let body;
      if (isResponses) {
        if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          throw new ProxyError(415, 'invalid_content_type', 'Use application/json.');
        }
        raw = await readBody(req, maxBodyBytes);
        try { body = JSON.parse(raw); } catch {
          throw new ProxyError(400, 'invalid_json', 'The request must be valid JSON.');
        }
        if (!body || Array.isArray(body) || typeof body !== 'object' ||
            typeof body.model !== 'string' || !body.model.trim() ||
            (body.input !== undefined && typeof body.input !== 'string' && !Array.isArray(body.input))) {
          throw new ProxyError(400, 'invalid_request', 'Provide a model and a string or array input.');
        }
      }
      let token = await getProviderToken();
      const sendOnce = () => fetchImpl(`${upstream}${req.url.slice(3)}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: isModels || !body.stream ? 'application/json' : 'text/event-stream',
          'content-type': 'application/json',
          'user-agent': 'copilot-local-proxy/1.0',
          'copilot-integration-id': 'copilot-developer-cli',
          'x-request-id': requestId,
          ...(isResponses ? { 'x-initiator': initiator(body) } : {}),
        },
        body: raw,
        redirect: 'error',
        signal: controller.signal,
      });
      const send = async () => {
        for (let attempt = 1; ; attempt++) {
          controller.signal.throwIfAborted();
          try {
            return await sendOnce();
          } catch (error) {
            if (controller.signal.aborted) throw error;
            const { reason, retryable, phase } = transportFailure(error);
            const retrying = retryable && attempt < 3;
            log({
              event: 'upstream_connection_error', request_id: requestId,
              attempt, reason, phase, retrying, duration_ms: Date.now() - started,
            });
            if (!retrying) throw error;
            await delay(250 * 2 ** (attempt - 1), undefined, { signal: controller.signal });
          }
        }
      };
      if (controller.signal.aborted) throw new Error('Request aborted');
      let result = await send();
      if (result.status === 401) {
        await result.body?.cancel();
        const fresh = await getProviderToken({ refresh: true });
        if (fresh !== token) {
          token = fresh;
          result = await send();
        }
      }
      if (!result.ok) {
        await result.body?.cancel();
        const retryAfter = result.headers.get('retry-after');
        if (retryAfter && /^\d{1,8}$/.test(retryAfter)) res.setHeader('retry-after', retryAfter);
        throw new ProxyError(result.status, `copilot_http_${result.status}`, upstreamError(result.status));
      }
      res.writeHead(result.status, {
        'content-type': result.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      streaming = isResponses && body.stream === true &&
        result.headers.get('content-type')?.split(';')[0].trim().toLowerCase() === 'text/event-stream';
      if (streaming) {
        res.flushHeaders();
        if (!result.body) {
          throw new ProxyError(502, 'upstream_stream_incomplete', 'Copilot returned an empty stream.');
        }
        // Keep the response writable on upstream failure so Codex receives an
        // explicit SSE error instead of an unexplained socket close.
        for await (const chunk of responseEvents(result.body, {
          signal: controller.signal, heartbeatMs, state: streamState,
        })) {
          if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
        }
        res.end();
        await finished(res, { cleanup: true });
      }
      else if (result.body) await pipeline(Readable.fromWeb(result.body), res, { signal: controller.signal });
      else res.end();
    }

    handle().catch(async error => {
      if (streaming) {
        const reason = abortReason || (error instanceof ProxyError ? error.code : transportFailure(error).reason);
        log({
          event: 'upstream_stream_error', request_id: requestId,
          reason, ...streamState, duration_ms: Date.now() - started,
        });
        if (!res.destroyed && !res.writableEnded) {
          const code = abortReason === 'deadline' ? 'upstream_timeout' :
            error instanceof ProxyError ? error.code : 'upstream_stream_error';
          const failure = {
            type: 'response.failed',
            response: {
              object: 'response', status: 'failed',
              error: {
                type: 'server_error', code,
                message: `Copilot stream interrupted (${code}); partial output was not replayed. Request ID: ${requestId}`,
              },
            },
          };
          await new Promise(resolveEnd => {
            const done = () => {
              res.off('finish', done);
              res.off('close', done);
              resolveEnd();
            };
            res.once('finish', done).once('close', done);
            res.end(`event: response.failed\ndata: ${JSON.stringify(failure)}\n\n`);
          });
        }
        return;
      }
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const known = error instanceof ProxyError;
      const status = known ? error.status : controller.signal.aborted ? 504 : 502;
      json(res, status, { error: {
        type: 'proxy_error',
        code: known ? error.code : status === 504 ? 'upstream_timeout' : 'upstream_unavailable',
        message: known ? error.message : status === 504 ? 'Copilot request timed out.' :
          'The connection to Copilot failed. Check the network and the redacted service log using x-request-id; this does not indicate a rejected GitHub login.',
      } });
    }).finally(() => {
      clearTimeout(timer);
      if (counted) active--;
      if (req.url !== '/health') log({
        event: 'request', request_id: requestId, status: res.statusCode,
        completed: res.writableFinished, duration_ms: Date.now() - started,
        ...(streaming ? { ...streamState, ...(abortReason ? { abort_reason: abortReason } : {}) } : {}),
      });
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const log = entry => console.log(JSON.stringify({ time: new Date().toISOString(), ...entry }));
  try {
    const config = JSON.parse(readFileSync(process.env.COPILOT_PROXY_CONFIG, 'utf8'));
    const localToken = process.env.COPILOT_PROXY_LOCAL_TOKEN;
    delete process.env.COPILOT_PROXY_LOCAL_TOKEN;
    if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) throw new Error('Invalid port');
    const server = createProxy({ localToken, getProviderToken: githubTokenSource(config.ghPath, { log }), log });
    server.on('error', error => {
      log({ event: 'server_error', code: error.code || 'startup_error' });
      process.exitCode = 1;
    });
    server.listen(config.port, '127.0.0.1', () => log({ event: 'listening', port: config.port }));
    for (const signal of ['SIGINT', 'SIGTERM']) {
      process.on(signal, () => {
        server.close();
        setTimeout(() => { server.closeAllConnections(); }, 2_000).unref();
      });
    }
  } catch {
    log({ event: 'startup_error', message: 'Missing or invalid installation configuration/local key. Run install.ps1.' });
    process.exitCode = 1;
  }
}
