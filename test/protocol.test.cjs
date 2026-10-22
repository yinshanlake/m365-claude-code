'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const route = require('../src/route.cjs');
const { convertRequest, estimateInput, responseMessage, streamMessage } = require('../src/protocol.cjs');
const { createBridge } = require('../src/server.cjs');
const Anthropic = require('@anthropic-ai/sdk');

const base = { model: 'claude-sonnet', max_tokens: 128, messages: [{ role: 'user', content: 'Check this local fixture.' }] };
const tool = name => ({ name, input_schema: { type: 'object', properties: { value: { type: 'string' } } } });
const call = (id, name = 'Read') => ({ type: 'tool_use', id, name, input: { value: 'fixture' } });
const result = (id, content = 'done', extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });
const completion = (model, content = 'OK', finish_reason = 'stop') => ({
  id: 'chat_fixture', object: 'chat.completion', model,
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
});
const chunk = (delta, finish_reason = null, extra = {}) => ({
  model: 'claude-sonnet', choices: [{ index: 0, delta, finish_reason }], ...extra,
});
async function* values(items) { yield* items; }
async function fixture(t, handler, options = {}) {
  const seen = [];
  const traces = [];
  const upstream = http.createServer(async (req, res) => {
    const data = [];
    for await (const piece of req) data.push(piece);
    const body = JSON.parse(Buffer.concat(data).toString());
    seen.push({ body, headers: req.headers });
    await handler(body, res, req);
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const bridge = createBridge({ key: 'local-test-only', baseURL: 'http://127.0.0.1:' + upstream.address().port + '/v1',
    trace: value => traces.push(value), ...options });
  bridge.listen(0, '127.0.0.1');
  await once(bridge, 'listening');
  t.after(async () => {
    bridge.closeAllConnections();
    upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => bridge.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const url = 'http://127.0.0.1:' + bridge.address().port;
  const headers = { authorization: 'Bearer local-test-only', 'content-type': 'application/json' };
  const post = (body, more = {}) => fetch(url + '/v1/messages', { method: 'POST', headers, body: JSON.stringify(body), ...more });
  return { url, headers, post, seen, traces };
}
function json(res, data, status = 200, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(data));
}
function sse(res, items) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const item of items) res.write('data: ' + JSON.stringify(item) + '\n\n');
  res.end('data: [DONE]\n\n');
}

test('request model overrides a stale launch header, with explicit aliases only', async () => {
  for (const entry of route.catalog.models) {
    for (const name of [entry.id, ...entry.aliases, 'm365,' + entry.id]) {
      assert.equal(await route({ body: { model: name }, headers: { 'x-m365-model': 'gpt-5.5-think-deeper' } }), 'm365,' + entry.id);
    }
  }
  for (const model of [undefined, '', 'claude-fable-5-1', 'claude-haiku-4-5', 'another,claude-sonnet', 'claude-sonnet-999']) {
    assert.throws(() => route.resolveModel(model), error => error.statusCode === 400 && /No fallback/.test(error.message));
  }
});

test('parallel tool results retain IDs, readable text, errors, and actual image parts', () => {
  const body = { ...base, tools: [tool('Read'), tool('Bash')], messages: [
    base.messages[0], { role: 'assistant', content: [call('read'), call('shell', 'Bash')] },
    { role: 'user', content: [
      result('shell', [{ type: 'text', text: 'permission denied' }], { is_error: true }),
      result('read', [{ type: 'text', text: 'Screenshot' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }]),
    ] },
  ] };
  const { request } = convertRequest(body);
  assert.deepEqual(request.messages[1].tool_calls.map(item => item.id), ['read', 'shell']);
  assert.equal(request.messages[2].tool_call_id, 'shell');
  assert.match(request.messages[2].content, /Tool reported an error.*\npermission denied/);
  assert.equal(request.messages[3].tool_call_id, 'read');
  assert.equal(request.messages[3].content[1].type, 'image_url');
  assert.match(request.messages[3].content[1].image_url.url, /^data:image\/png;base64,/);
  assert.ok(estimateInput(request) > 1600);
});

test('interleaved native system messages retain order and do not break tool pairing', () => {
  const body = { ...base, system: 'Global instructions.', messages: [
    base.messages[0],
    { role: 'system', content: 'First reminder.' },
    { role: 'assistant', content: [call('read'), call('shell', 'Bash')] },
    { role: 'system', content: [{ type: 'text', text: 'Keep tool permissions.', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: [result('shell', 'shell result'), result('read', 'read result')] },
    { role: 'system', content: 'Latest reminder.' },
    { role: 'user', content: 'Continue.' },
  ] };
  const original = structuredClone(body);
  const { request } = convertRequest(body);
  assert.deepEqual(request.messages.map(message => message.role),
    ['system', 'user', 'system', 'assistant', 'system', 'tool', 'tool', 'system', 'user']);
  assert.deepEqual(request.messages.filter(message => message.role === 'system').map(message => message.content),
    ['Global instructions.', 'First reminder.', 'Keep tool permissions.', 'Latest reminder.']);
  assert.deepEqual(request.messages[3].tool_calls.map(item => item.id), ['read', 'shell']);
  assert.deepEqual(request.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id),
    ['shell', 'read']);
  assert.deepEqual(body, original);
  assert.ok(estimateInput(convertRequest(body, { countOnly: true }).request) > 0);
});

test('HTTP accepts native system messages and rejects unknown roles without inference', async t => {
  const f = await fixture(t, (body, res) => json(res, completion(body.model)));
  const res = await f.post({ ...base, model: 'claude-sonnet-5', messages: [
    ...base.messages, { role: 'system', content: 'Preserve the selected permissions.' },
  ] });
  assert.equal(res.status, 200);
  assert.equal(f.seen[0].body.messages[1].role, 'system');
  const invalid = await f.post({ ...base, messages: [{ role: 'unknown', content: 'private fixture text' }] });
  assert.equal(invalid.status, 400);
  const error = (await invalid.json()).error.message;
  assert.match(error, /messages\[0\]/);
  assert.equal(error.includes('private fixture text'), false);
  assert.equal(f.seen.length, 1);
});

test('tool discovery exposes referenced deferred tools and omits the placeholder', () => {
  const body = { ...base, tools: [tool('ToolSearch'), { ...tool('mcp__browser__tabs'), defer_loading: true },
    { ...tool('mcp__other'), defer_loading: true }, { ...tool('DeferredToolPlaceholder'), defer_loading: true }],
  messages: [base.messages[0], { role: 'assistant', content: [call('search', 'ToolSearch')] },
    { role: 'user', content: [result('search', [{ type: 'tool_reference', tool_name: 'mcp__browser__tabs' }])] }] };
  assert.deepEqual(convertRequest(body).request.tools.map(item => item.function.name), ['ToolSearch', 'mcp__browser__tabs']);
  assert.deepEqual(convertRequest({ ...body, messages: base.messages }).request.tools.map(item => item.function.name), ['ToolSearch']);
});

test('client-side ToolSearch text materializes schemas only from the paired search result', () => {
  const definition = { name: 'mcp__playwright__browser_tabs', description: 'List tabs.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list'] } }, required: ['action'] } };
  const text = '<functions>\n<function>' + JSON.stringify(definition) + '</function>\n</functions>';
  const body = { ...base, tools: [tool('ToolSearch')], messages: [base.messages[0],
    { role: 'assistant', content: [call('search', 'ToolSearch')] },
    { role: 'user', content: [result('search', text)] }] };
  const { request } = convertRequest(body);
  assert.deepEqual(request.tools.map(item => item.function.name), ['ToolSearch', definition.name]);
  assert.deepEqual(request.tools[1].function.parameters, definition.parameters);
  const untrusted = structuredClone(body);
  untrusted.messages[1].content[0].name = 'Read';
  assert.deepEqual(convertRequest(untrusted).request.tools.map(item => item.function.name), ['ToolSearch']);
  const reusedId = { ...body, messages: [
    ...body.messages,
    { role: 'assistant', content: [call('search', 'Read')] },
    { role: 'user', content: [result('search', text.replaceAll('mcp__playwright__browser_tabs', 'untrusted_tool'))] },
  ] };
  assert.equal(convertRequest(reusedId).request.tools.some(item => item.function.name === 'untrusted_tool'), false);
});

test('cancelled and ambiguous history is context and cannot replay an unpaired call', () => {
  const { request } = convertRequest({ ...base, messages: [
    base.messages[0], { role: 'assistant', content: [call('duplicate'), call('duplicate')] },
    { role: 'user', content: [result('duplicate'), result('orphan')] },
  ] });
  assert.equal(request.messages.some(message => message.tool_calls || message.role === 'tool'), false);
  assert.match(JSON.stringify(request.messages), /Execution status is unknown/);
  assert.match(JSON.stringify(request.messages), /Unpaired historical tool result/);
});

test('tool IDs reused in different turns pair independently', () => {
  const pair = [{ role: 'assistant', content: [call('reuse')] }, { role: 'user', content: [result('reuse')] }];
  const { request } = convertRequest({ ...base, messages: [base.messages[0], ...pair, ...structuredClone(pair)] });
  assert.equal(request.messages.filter(message => message.role === 'tool').length, 2);
});

test('tool choice is translated, while forced unsupported server tools fail clearly', () => {
  const body = { ...base, tools: [tool('Read'), { type: 'web_search_20250305', name: 'web_search' }] };
  assert.equal(convertRequest({ ...body, tool_choice: { type: 'any' } }).request.tool_choice, 'required');
  assert.deepEqual(convertRequest(body).unsupportedTools, ['web_search']);
  assert.throws(() => convertRequest({ ...body, tool_choice: { type: 'tool', name: 'web_search' } }), /not available/);
  assert.throws(() => convertRequest({ ...base, output_config: { format: { type: 'json_schema' } } }), /JSON schema/);
});

test('upstream response model mismatch and malformed tool arguments never become success', () => {
  assert.throws(() => responseMessage(completion('gpt-5.5-think-deeper'), 'claude-sonnet', 40), /Response rejected/);
  const response = completion('claude-sonnet', null, 'tool_calls');
  response.choices[0].message.tool_calls = [{ id: 'bad', function: { name: 'Bash', arguments: '{broken' } }];
  assert.throws(() => responseMessage(response, 'claude-sonnet', 40), /invalid JSON/);
});

test('structured output is locally validated before JSON is delivered', async () => {
  const format = { type: 'json_schema', schema: {
    type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'], additionalProperties: false,
  } };
  const { request, outputFormat } = convertRequest({ ...base, output_config: { format } });
  assert.match(request.messages[0].content, /return only JSON/);
  const response = responseMessage(completion('claude-sonnet', '{"answer":42}'), 'claude-sonnet', 20, outputFormat);
  assert.equal(JSON.parse(response.content[0].text).answer, 42);
  assert.throws(() => responseMessage(completion('claude-sonnet', '{"answer":"wrong"}'), 'claude-sonnet', 20, outputFormat), /did not match/);
  assert.throws(() => responseMessage(completion('claude-sonnet', 'I cannot answer.'), 'claude-sonnet', 20, outputFormat), /valid JSON/);
  const events = [];
  await streamMessage(values([chunk({ content: '{"answer":' }), chunk({ content: '42}' }), chunk({}, 'stop')]),
    'claude-sonnet', 20, event => events.push(event), undefined, outputFormat);
  assert.equal(events.filter(event => event.type === 'content_block_delta').length, 1);
  assert.equal(events.at(-1).type, 'message_stop');
});

test('fragmented parallel calls produce valid, sequential Anthropic blocks and tool_use stop', async () => {
  const events = [];
  await streamMessage(values([
    chunk({ content: 'Checking.' }),
    chunk({ tool_calls: [{ index: 0, id: 'call_one', function: { name: 'Re', arguments: '{"value":' } },
      { index: 1, id: 'call_two', function: { name: 'Bash', arguments: '{"value":"sec' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: 'ad', arguments: '"first"}' } },
      { index: 1, function: { arguments: 'ond"}' } }] }),
    chunk({}, 'tool_calls', { usage: { prompt_tokens: 100, completion_tokens: 12, prompt_tokens_details: { cached_tokens: 20 } } }),
  ]), 'claude-sonnet', 50, event => events.push(event));
  let open = null;
  const inputs = [];
  for (const event of events) {
    if (event.type === 'content_block_start') { assert.equal(open, null); open = event.index; }
    if (event.type === 'content_block_delta') {
      assert.equal(event.index, open);
      if (event.delta.type === 'input_json_delta') inputs.push(JSON.parse(event.delta.partial_json));
    }
    if (event.type === 'content_block_stop') { assert.equal(event.index, open); open = null; }
  }
  assert.equal(open, null);
  assert.deepEqual(inputs, [{ value: 'first' }, { value: 'second' }]);
  assert.equal(events.at(-2).delta.stop_reason, 'tool_use');
  assert.equal(events.at(-2).usage.input_tokens, 80);
  assert.equal(events.at(-1).type, 'message_stop');
});

test('truncation remains max_tokens; premature EOF has no fabricated normal stop', async () => {
  const events = [];
  await streamMessage(values([chunk({ content: 'Partial' }), chunk({}, 'length')]), 'claude-sonnet', 10, event => events.push(event));
  assert.equal(events.at(-2).delta.stop_reason, 'max_tokens');
  const broken = [];
  await assert.rejects(streamMessage(values([chunk({ content: 'Partial' })]), 'claude-sonnet', 10, event => broken.push(event)), /finish reason/);
  assert.equal(broken.some(event => event.type === 'message_stop'), false);
});

test('HTTP auth, model discovery, token counting, and unknown-model rejection need no inference', async t => {
  const f = await fixture(t, (_body, res) => json(res, {}));
  assert.equal((await fetch(f.url + '/v1/models')).status, 401);
  const models = await (await fetch(f.url + '/v1/models', { headers: f.headers })).json();
  assert.equal(models.data.length, 7);
  assert.equal(models.data.some(model => /fable/i.test(model.id)), false);
  assert.equal((await fetch(f.url + '/v1/models/claude-fable-5-1', { headers: f.headers })).status, 404);
  const counted = await fetch(f.url + '/v1/messages/count_tokens', { method: 'POST', headers: f.headers, body: JSON.stringify(base) });
  assert.ok((await counted.json()).input_tokens > 0);
  assert.equal(counted.headers.get('x-m365-token-count'), 'local-estimate');
  const toolsOnly = await fetch(f.url + '/v1/messages/count_tokens', { method: 'POST', headers: f.headers,
    body: JSON.stringify({ ...base, messages: [], tools: [tool('Read')] }) });
  assert.equal(toolsOnly.status, 200);
  assert.ok((await toolsOnly.json()).input_tokens > 0);
  const unsupported = await f.post({ ...base, model: 'claude-fable-5-1' });
  assert.equal(unsupported.status, 400);
  assert.match((await unsupported.json()).error.message, /No fallback/);
  assert.equal(f.seen.length, 0);
});

test('the Anthropic SDK consumes real HTTP text and parallel tool SSE responses', async t => {
  const f = await fixture(t, (body, res) => sse(res, [
    { ...chunk({ content: 'Done.' }), model: body.model },
    { ...chunk({ tool_calls: [
      { index: 0, id: 'one', function: { name: 'Read', arguments: '{"value":"a"}' } },
      { index: 1, id: 'two', function: { name: 'Read', arguments: '{"value":"b"}' } },
    ] }), model: body.model },
    { ...chunk({}, 'tool_calls'), model: body.model },
  ]));
  const client = new Anthropic({ apiKey: 'local-test-only', baseURL: f.url, maxRetries: 0 });
  const answer = await client.messages.stream({ ...base, tools: [tool('Read')] }).finalMessage();
  assert.equal(answer.stop_reason, 'tool_use');
  assert.deepEqual(answer.content.filter(block => block.type === 'tool_use').map(block => [block.id, block.input.value]), [['one', 'a'], ['two', 'b']]);
  assert.ok(answer.usage.input_tokens > 0);
  assert.equal(f.seen[0].headers.authorization, 'Bearer not-needed');
});

test('same HTTP client switches routes despite a stale model header', async t => {
  const f = await fixture(t, (body, res) => json(res, completion(body.model)));
  for (const model of ['gpt-5.5-think-deeper', 'claude-sonnet-4-6', 'claude-opus-4-8']) {
    const res = await f.post({ ...base, model }, { headers: { ...f.headers, 'x-m365-model': 'gpt-5.5-think-deeper' } });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).model, route.resolveModel(model));
  }
  assert.deepEqual(f.seen.map(entry => entry.body.model), ['gpt-5.5-think-deeper', 'claude-sonnet', 'claude-opus-4.8']);
});

test('cache accounting stays unreported unless the provider supplies real counters', () => {
  const unknown = responseMessage({ ...completion(base.model), usage: { prompt_tokens: 0, completion_tokens: 0 } }, base.model, 4096);
  assert.equal(unknown.usage.input_tokens, 4096);
  assert.equal(unknown.usage.cache_read_input_tokens, 0);
  const reported = responseMessage({ ...completion(base.model), usage: {
    prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 800 },
  } }, base.model, 4096);
  assert.equal(reported.usage.input_tokens, 200);
  assert.equal(reported.usage.cache_read_input_tokens, 800);
});

test('context telemetry survives JSON and SSE without copying arbitrary upstream fields', async t => {
  const context = { initial_mode: 'delta', conversation_reused: true, conversation_hash: 'a'.repeat(20),
    reused_messages: 10, submitted_characters: 120, handler_attempts: 1,
    tool_configuration_updated: false, provider_prompt_cache: 'unreported' };
  const usage = { prompt_tokens: 0, completion_tokens: 0,
    x_m365_context: { ...context, private_text: 'must-never-be-copied' }, x_m365_opus_daily_remaining: 3 };
  const f = await fixture(t, (body, res) => {
    if (body.stream) sse(res, [chunk({ content: 'OK' }), chunk({}, 'stop', { usage })]);
    else json(res, { ...completion(body.model), usage });
  });
  const response = await f.post(base);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-m365-provider-cache'), 'unreported');
  assert.deepEqual(JSON.parse(response.headers.get('x-m365-context')), context);
  const client = new Anthropic({ apiKey: 'local-test-only', baseURL: f.url, maxRetries: 0 });
  const streamed = await client.messages.stream(base).finalMessage();
  assert.equal(streamed.usage.cache_read_input_tokens, 0);
  const traces = f.traces.filter(event => event.event === 'complete');
  assert.equal(traces.length, 2);
  for (const trace of traces) {
    assert.deepEqual(trace.context, context);
    assert.equal(trace.provider_cache_reported, false);
    assert.equal(trace.quota.opus_daily_remaining, 3);
    assert.equal(JSON.stringify(trace).includes('must-never-be-copied'), false);
  }
});

test('stable client metadata keeps its upstream session key as tools change', async t => {
  const f = await fixture(t, (body, res) => json(res, completion(body.model)));
  for (const [userId, tools] of [['client-a', [tool('ToolSearch')]],
    ['client-a', [tool('ToolSearch'), tool('Read')]], ['client-b', [tool('ToolSearch')]]]) {
    assert.equal((await f.post({ ...base, metadata: { user_id: userId }, tools })).status, 200);
  }
  assert.equal(f.seen[0].body.user, f.seen[1].body.user);
  assert.notEqual(f.seen[0].body.user, f.seen[2].body.user);
  assert.equal(JSON.stringify(f.traces).includes('client-a'), false);
});

test('HTTP rate limits are surfaced once without retry or default-model substitution', async t => {
  const f = await fixture(t, (_body, res) => json(res, { error: { message: 'Fixture allowance exhausted.' } }, 429, { 'retry-after': '5' }));
  const res = await f.post(base);
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '5');
  assert.equal((await res.json()).error.type, 'rate_limit_error');
  assert.equal(f.seen.length, 1);
});

test('an upstream in-stream failure produces a proper Anthropic error, without message_stop', async t => {
  const f = await fixture(t, (_body, res) => sse(res, [chunk({}), { error: { type: 'upstream_error', message: 'Fixture failure.' } }]));
  const res = await f.post({ ...base, stream: true });
  const text = await res.text();
  const error = text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(event => event.type === 'error');
  assert.ok(error.error.message.includes('Fixture failure'));
  assert.equal(error.error.type, 'api_error');
  assert.equal(text.includes('event: message_stop'), false);
  assert.equal(f.seen.length, 1);
});

test('client cancellation closes the upstream stream and releases the request slot', async t => {
  let upstreamClosed;
  const closed = new Promise(resolve => { upstreamClosed = resolve; });
  let count = 0;
  const f = await fixture(t, (body, res) => {
    if (++count > 1) { json(res, completion(body.model)); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify(chunk({ content: 'Started' })) + '\n\n');
    res.on('close', upstreamClosed);
  });
  const controller = new AbortController();
  const res = await f.post({ ...base, stream: true }, { signal: controller.signal });
  const reader = res.body.getReader();
  await reader.read();
  controller.abort();
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error('Upstream was not cancelled.')), 1500).unref())]);
  assert.equal((await f.post(base)).status, 200);
});

test('request timeout returns an error and cancels the upstream', async t => {
  const f = await fixture(t, () => {}, { timeoutMs: 120 });
  const res = await f.post(base);
  assert.equal(res.status, 504);
  assert.match((await res.json()).error.message, /timed out/);
});

test('concurrent client requests are serialized and cancelling a queued request skips it', async t => {
  let finishFirst;
  const firstStarted = new Promise(resolve => { finishFirst = resolve; });
  let firstResponse;
  const f = await fixture(t, (body, res) => {
    if (!firstResponse) { firstResponse = res; finishFirst(); }
    else json(res, completion(body.model));
  });
  const first = f.post(base);
  await firstStarted;
  const cancel = new AbortController();
  const second = f.post({ ...base, model: 'gpt-6.1-sol' }, { signal: cancel.signal });
  const third = f.post({ ...base, model: 'claude-opus' });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.equal(f.seen.length, 1);
  const cancelled = assert.rejects(second, error => error.name === 'AbortError');
  cancel.abort();
  await cancelled;
  await new Promise(resolve => setTimeout(resolve, 25));
  json(firstResponse, completion('claude-sonnet'));
  assert.equal((await first).status, 200);
  assert.equal((await third).status, 200);
  assert.deepEqual(f.seen.map(entry => entry.body.model), ['claude-sonnet', 'claude-opus']);
});
