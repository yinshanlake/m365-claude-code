'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash, timingSafeEqual } = require('node:crypto');
const OpenAI = require('openai');
const { catalog, resolveModel } = require('./route.cjs');
const { problem, convertRequest, estimateInput, upstreamDiagnostics, assertResponseModel, responseMessage, streamMessage } = require('./protocol.cjs');
const { errorStatus, errorMetadata, canFallback, prepareStream } = require('./upstream.cjs');
const { createAccountThrottle } = require('./throttle.cjs');

function errorInfo(error) {
  const status = error.name === 'AbortError' ? 504 : errorStatus(error);
  const types = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error',
    404: 'not_found_error', 408: 'api_error', 413: 'request_too_large', 429: 'rate_limit_error' };
  const knownTypes = new Set([...Object.values(types), 'overloaded_error']);
  const metadata = errorMetadata(error);
  return { status, body: { type: 'error', error: {
    type: knownTypes.has(error.type) ? error.type : types[status] || 'api_error',
    message: String(error.error?.message || error.message || 'Upstream request failed.').slice(0, 2000),
    ...(metadata.error_code ? { code: metadata.error_code } : {}),
  } } };
}

function modelInfo(entry) {
  const unsupported = { supported: false };
  return {
    id: entry.id, type: 'model', display_name: entry.label, description: entry.description,
    created_at: '1970-01-01T00:00:00Z', max_input_tokens: null, max_tokens: null,
    capabilities: {
      batch: unsupported, citations: unsupported, code_execution: unsupported,
      pdf_input: unsupported, structured_outputs: { supported: true },
      image_input: { supported: true },
      thinking: { supported: false, types: { adaptive: unsupported, enabled: unsupported } },
      effort: { supported: false, low: unsupported, medium: unsupported, high: unsupported, xhigh: unsupported, max: unsupported },
      context_management: { supported: false, clear_thinking_20251015: unsupported,
        clear_tool_uses_20250919: unsupported, compact_20260112: unsupported },
    },
  };
}

function sequentialGate() {
  let busy = false;
  const waiting = [];
  function release() {
    const next = waiting.shift();
    if (next) {
      next.signal.removeEventListener('abort', next.abort);
      next.resolve(release);
    } else busy = false;
  }
  return signal => {
    signal.throwIfAborted();
    if (!busy) { busy = true; return Promise.resolve(release); }
    return new Promise((resolve, reject) => {
      const item = { signal, resolve, abort: () => {
        const index = waiting.indexOf(item);
        if (index !== -1) waiting.splice(index, 1);
        reject(signal.reason);
      } };
      signal.addEventListener('abort', item.abort, { once: true });
      waiting.push(item);
    });
  };
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 50 * 1024 * 1024) throw problem('Request exceeds the 50 MiB limit.', 413, 'request_too_large');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw problem('Request body must be a JSON object.'); }
}

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function createBridge(options) {
  if (!options.key) throw new Error('The local adapter credential is missing.');
  const timeoutMs = options.timeoutMs || 240000;
  const queueTimeoutMs = options.queueTimeoutMs || timeoutMs;
  const expectedKey = createHash('sha256').update(options.key).digest();
  const client = new OpenAI({
    baseURL: options.baseURL || 'http://127.0.0.1:4144/v1',
    apiKey: options.upstreamKey || 'not-needed', maxRetries: 0,
    timeout: timeoutMs,
  });
  const acquire = sequentialGate();
  const trace = options.trace || (() => {});
  const fallbacks = [...new Set((options.fallbackModels || []).map(resolveModel))];
  const throttle = createAccountThrottle({ cooldownMs: options.accountThrottleCooldownMs,
    initialState: options.throttleState, onChange: options.onThrottleStateChange, now: options.now });
  return http.createServer(async (request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
    if ((pathname === '/' || pathname === '/health') && ['GET', 'HEAD'].includes(request.method)) {
      sendJson(response, 200, { status: 'ok', adapter: 'm365-anthropic', protocol: 'anthropic-messages',
        fallback_enabled: fallbacks.length > 0, fallback_order: fallbacks, account_throttle: throttle.snapshot(),
        queue_timeout_ms: queueTimeoutMs, upstream_timeout_ms: timeoutMs });
      return;
    }
    const suppliedKey = request.headers.authorization?.replace(/^Bearer /i, '') || request.headers['x-api-key'] || '';
    const actualKey = createHash('sha256').update(String(suppliedKey)).digest();
    if (!timingSafeEqual(expectedKey, actualKey)) {
      sendJson(response, 401, { type: 'error', error: { type: 'authentication_error', message: 'Invalid local adapter credential.' } });
      return;
    }
    const requestId = randomUUID();
    const controller = new AbortController();
    let timeout = setTimeout(() => controller.abort(problem('Local gateway queue timed out before an upstream request could start.', 504, 'api_error')), queueTimeoutMs);
    const onAbort = () => controller.abort(problem('Client disconnected.', 499, 'api_error'));
    request.on('aborted', onAbort);
    response.on('close', () => { if (!response.writableEnded) onAbort(); });
    let release;
    let heartbeat;
    let route;
    let clientModel;
    let observedModel;
    let observedUsage;
    let queuedAt;
    let acquiredAt;
    const attemptedRoutes = [];
    const startedAt = Date.now();
    const timing = () => ({
      elapsed_ms: Date.now() - startedAt,
      queue_ms: queuedAt === undefined ? 0 : (acquiredAt ?? Date.now()) - queuedAt,
      upstream_ms: acquiredAt === undefined ? 0 : Date.now() - acquiredAt,
    });
    try {
      if (request.method === 'GET' && pathname === '/v1/models') {
        const data = catalog.models.map(modelInfo);
        sendJson(response, 200, { data, has_more: false, first_id: data[0].id, last_id: data.at(-1).id });
        return;
      }
      if (request.method === 'GET' && pathname.startsWith('/v1/models/')) {
        let id;
        try { id = resolveModel(decodeURIComponent(pathname.slice('/v1/models/'.length))); }
        catch { throw problem('Requested model is not available from this adapter.', 404, 'not_found_error'); }
        sendJson(response, 200, modelInfo(catalog.models.find(entry => entry.id === id)));
        return;
      }
      if (request.method !== 'POST' || !['/v1/messages', '/v1/messages/count_tokens'].includes(pathname)) {
        throw problem('Endpoint not supported by this local Anthropic adapter.', 404, 'not_found_error');
      }
      const body = await readJson(request);
      clientModel = typeof body.model === 'string' ? body.model.slice(0, 160) : undefined;
      const { request: upstream, unsupportedTools, outputFormat } = convertRequest(body, { countOnly: pathname.endsWith('/count_tokens') });
      route = upstream.model;
      const inputEstimate = estimateInput(upstream);
      if (pathname.endsWith('/count_tokens')) {
        sendJson(response, 200, { input_tokens: inputEstimate }, { 'x-m365-token-count': 'local-estimate' });
        return;
      }
      const session = typeof body.metadata?.user_id === 'string'
        ? createHash('sha256').update(body.metadata.user_id).digest('hex').slice(0, 20) : undefined;
      upstream.user = session || requestId;
      trace({ event: 'request', request_id: requestId, session, client_model: body.model, upstream_model: route,
        stream: upstream.stream, messages: upstream.messages.length,
        tools: upstream.tools?.map(tool => tool.function.name) ?? [],
        unsupported_server_tools: unsupportedTools, input_tokens_estimate: inputEstimate,
        structured_output: Boolean(outputFormat),
        legacy_model_header_ignored: Boolean(request.headers['x-m365-model']) });
      throttle.assertAvailable();
      const preferredRoute = route;
      const candidates = [preferredRoute, ...(request.headers['x-m365-fallback'] === 'off' ? [] : fallbacks.filter(model => model !== preferredRoute))];
      const headers = { 'request-id': requestId, 'x-m365-requested-model': preferredRoute, 'x-m365-usage': 'local-estimate' };
      if (candidates.length === 1) headers['x-m365-model'] = preferredRoute;
      if (upstream.stream) {
        response.writeHead(200, { ...headers, 'content-type': 'text/event-stream',
          'cache-control': 'no-cache', connection: 'keep-alive' });
        response.flushHeaders();
        heartbeat = setInterval(() => {
          if (!response.destroyed && !response.writableEnded) response.write('event: ping\ndata: {"type":"ping"}\n\n');
        }, 15000);
      }
      queuedAt = Date.now();
      release = await acquire(controller.signal);
      acquiredAt = Date.now();
      clearTimeout(timeout);
      // A request that waited behind another client still needs its full
      // execution budget. Otherwise a nearly expired queue wait starts a turn
      // only to cancel it and force a client retry with fresh M365 context.
      timeout = setTimeout(() => controller.abort(problem('M365 request timed out.', 504, 'api_error')), timeoutMs);
      throttle.assertAvailable();
      let result;
      for (let index = 0; index < candidates.length; index++) {
        controller.signal.throwIfAborted();
        route = candidates[index];
        attemptedRoutes.push(route);
        observedModel = undefined;
        observedUsage = undefined;
        try {
          const candidate = await client.chat.completions.create({ ...upstream, model: route }, { signal: controller.signal });
          if (upstream.stream) {
            result = await prepareStream(candidate, chunk => assertResponseModel(chunk.model, route));
          } else {
            assertResponseModel(candidate.model, route);
            result = candidate;
          }
          break;
        } catch (error) {
          if (controller.signal.aborted || !canFallback(error) || index === candidates.length - 1) throw error;
          trace({ event: 'fallback', request_id: requestId, from_model: route, to_model: candidates[index + 1],
            status: errorStatus(error), code: error.error?.code || error.code });
        }
      }
      if (!upstream.stream) {
        headers['x-m365-model'] = route;
        headers['x-m365-fallback-used'] = String(route !== preferredRoute);
      }
      let final;
      if (upstream.stream) {
        const emit = async event => {
          controller.signal.throwIfAborted();
          const payload = 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n';
          if (!response.write(payload)) {
            await new Promise((resolve, reject) => {
              const cleanup = () => { response.off('drain', drained); response.off('close', closed); };
              const drained = () => { cleanup(); resolve(); };
              const closed = () => { cleanup(); reject(problem('Client disconnected.', 499, 'api_error')); };
              response.once('drain', drained);
              response.once('close', closed);
            });
          }
        };
        final = await streamMessage(result, route, inputEstimate, emit, model => { observedModel = model; }, outputFormat,
          usage => { observedUsage = usage; });
        response.end();
      } else {
        observedModel = result.model;
        observedUsage = result.usage;
        const diagnostics = upstreamDiagnostics(observedUsage);
        headers['x-m365-provider-cache'] = diagnostics.provider_cache_reported ? 'reported' : 'unreported';
        if (diagnostics.context) headers['x-m365-context'] = JSON.stringify(diagnostics.context);
        final = responseMessage(result, route, inputEstimate, outputFormat);
        sendJson(response, 200, final, headers);
      }
      trace({ event: 'complete', request_id: requestId, upstream_model: route, response_model: observedModel,
        requested_model: preferredRoute, attempted_models: attemptedRoutes, fallback_used: route !== preferredRoute,
        stop_reason: final.stop_reason, usage: final.usage, ...upstreamDiagnostics(observedUsage), ...timing() });
    } catch (caught) {
      const error = controller.signal.aborted ? controller.signal.reason : caught;
      throttle.observe(error);
      const accountThrottle = throttle.snapshot();
      const { status, body } = errorInfo(error);
      trace({ event: status === 499 ? 'cancelled' : 'error', request_id: requestId,
        endpoint: pathname, client_model: clientModel, upstream_model: route, response_model: observedModel, status,
        ...(status === 400 ? { validation_message: body.error.message } : {}),
        attempted_models: attemptedRoutes, ...errorMetadata(error),
        ...(accountThrottle ? { account_throttle: accountThrottle, sent_upstream: attemptedRoutes.length > 0 } : {}),
        error_type: body.error.type, ...timing() });
      if (!response.destroyed && !response.writableEnded) {
        if (response.headersSent) response.end('event: error\ndata: ' + JSON.stringify(body) + '\n\n');
        else {
          const retryAfter = status === 429 && accountThrottle ? String(accountThrottle.retry_after_seconds) : error.headers?.get?.('retry-after');
          sendJson(response, status === 499 ? 408 : status, body, {
            'request-id': requestId, ...(retryAfter ? { 'retry-after': retryAfter } : {}),
            ...(status === 429 && accountThrottle ? { 'x-should-retry': 'false' } : {}),
          });
        }
      }
    } finally {
      clearTimeout(timeout);
      clearInterval(heartbeat);
      controller.abort();
      if (release) release();
      request.off('aborted', onAbort);
    }
  });
}

if (require.main === module) {
  try {
    const dataDir = path.resolve(process.env.M365_CLAUDE_DATA_DIR || path.join(__dirname, '../.local'));
    const configPath = path.join(dataDir, 'config.json');
    const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const readSecret = name => {
      const file = path.join(dataDir, name);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : undefined;
    };
    const port = Number(process.env.M365_CLAUDE_PORT || config.gatewayPort || 4145);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid gateway port.');
    const logDir = path.join(dataDir, 'logs');
    const traceFile = path.join(logDir, 'routes-' + new Date().toISOString().slice(0, 10) + '.jsonl');
    fs.mkdirSync(logDir, { recursive: true });
    const throttleFile = path.join(dataDir, 'account-throttle.json');
    let throttleState;
    try { if (fs.existsSync(throttleFile)) throttleState = JSON.parse(fs.readFileSync(throttleFile, 'utf8')); }
    catch { process.stderr.write('Could not read local account throttle state.\n'); }
    const server = createBridge({
      key: process.env.M365_CLAUDE_KEY || readSecret('gateway-key.txt'),
      baseURL: process.env.M365_OPENAI_BASE_URL || config.upstreamBaseUrl || 'http://127.0.0.1:4144/v1',
      upstreamKey: process.env.M365_UPSTREAM_API_KEY || readSecret('upstream-key.txt'),
      timeoutMs: config.timeoutMs || 240000,
      queueTimeoutMs: config.queueTimeoutMs,
      fallbackModels: config.fallbackEnabled === false ? [] : catalog.fallbackOrder,
      accountThrottleCooldownMs: config.accountThrottleCooldownMs,
      throttleState,
      onThrottleStateChange: state => {
        try {
          fs.writeFileSync(throttleFile + '.tmp', JSON.stringify(state) + '\n');
          fs.renameSync(throttleFile + '.tmp', throttleFile);
        } catch { process.stderr.write('Could not save local account throttle state.\n'); }
      },
      trace: event => {
        try { fs.appendFileSync(traceFile, JSON.stringify({ time: new Date().toISOString(), ...event }) + '\n'); }
        catch { process.stderr.write('Could not write local route metadata.\n'); }
      },
    });
    server.listen(port, '127.0.0.1', () => {
      process.stdout.write('M365 Anthropic gateway listening on http://127.0.0.1:' + port + '\n');
    });
    server.on('error', error => {
      process.stderr.write('Gateway could not listen on loopback port ' + port + ': ' + error.code + '\n');
      process.exitCode = 1;
    });
    process.on('SIGINT', () => server.close());
    process.on('SIGTERM', () => server.close());
  } catch {
    process.stderr.write('Gateway startup failed. Check .local/config.json and run scripts/Setup.ps1 to initialize the private credential.\n');
    process.exitCode = 1;
  }
}

module.exports = { createBridge };
