'use strict';

const { randomUUID } = require('node:crypto');
const { get_encoding } = require('tiktoken');
const { resolveModel } = require('./route.cjs');
const { streamError } = require('./upstream.cjs');
const encoding = get_encoding('cl100k_base');
const Ajv = require('ajv');
const Ajv2020 = require('ajv/dist/2020');
const addFormats = require('ajv-formats');
const schemaValidators = [new Ajv({ strict: false, allErrors: true }), new Ajv2020({ strict: false, allErrors: true })];
schemaValidators.forEach(validator => addFormats(validator));

function problem(message, statusCode = 400, type = 'invalid_request_error') {
  return Object.assign(new Error(message), { statusCode, type });
}

function prepareOutputFormat(format) {
  if (!format) return undefined;
  if (format.type !== 'json_schema' || !format.schema || typeof format.schema !== 'object') {
    throw problem('output_config.format must contain a JSON schema.');
  }
  let validate;
  try {
    const compiler = schemaValidators[String(format.schema.$schema ?? '').includes('2020-12') ? 1 : 0];
    validate = compiler.compile(format.schema);
    compiler.removeSchema(format.schema);
  } catch { throw problem('output_config.format contains an unsupported or invalid JSON schema.'); }
  return { schema: format.schema, validate };
}

function structuredText(text, outputFormat) {
  if (!outputFormat) return text;
  const candidate = text.trim().replace(/^\x60{3}(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/i, '$1');
  let value;
  try { value = JSON.parse(candidate); }
  catch { throw problem('Upstream did not return valid JSON for the requested output schema.', 502, 'api_error'); }
  if (!outputFormat.validate(value)) {
    const detail = outputFormat.validate.errors?.slice(0, 3).map(error => error.instancePath + ' ' + error.message).join('; ');
    throw problem('Upstream JSON did not match the requested output schema: ' + detail, 502, 'api_error');
  }
  return JSON.stringify(value);
}

function textTokens(text) {
  return encoding.encode(String(text), 'all').length;
}

function contentParts(content) {
  if (content == null) return [];
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw problem('Message content must be text or an array of content blocks.');
  return content.flatMap(block => {
    if (!block || typeof block !== 'object') throw problem('Content blocks must be objects.');
    if (block.type === 'text') return [{ type: 'text', text: String(block.text ?? '') }];
    if (block.type === 'image') {
      const source = block.source;
      const url = source?.type === 'base64' && source.media_type && source.data
        ? 'data:' + source.media_type + ';base64,' + source.data
        : source?.type === 'url' ? source.url : null;
      if (!url) throw problem('Unsupported image source.');
      return [{ type: 'image_url', image_url: { url } }];
    }
    if (block.type === 'document') {
      if (block.source?.type === 'text') return [{ type: 'text', text: String(block.source.data) }];
      throw problem('This M365 route does not support native PDF/document blocks. Use extracted text or page images.');
    }
    // Reasoning signatures belong to their originating provider and model.
    if (block.type === 'thinking' || block.type === 'redacted_thinking') return [];
    return [{ type: 'text', text: JSON.stringify(block) }];
  });
}

function packed(parts) {
  return parts.every(part => part.type === 'text')
    ? parts.map(part => part.text).join('\n') : parts;
}

function toolResultParts(block) {
  return [
    ...(block.is_error ? [{ type: 'text', text: '[Tool reported an error]' }] : []),
    ...contentParts(block.content),
  ];
}

// Pair only within an assistant turn and its following user results. An orphan
// after cancellation/compaction stays context; it must not become a new action.
function pairedBlocks(messages) {
  // Newer native clients interleave system reminders in the message list.
  // They do not end a tool turn; keep the original block objects for pairing.
  messages = messages.filter(message => message.role !== 'system');
  const paired = new Set();
  const resultNames = new Map();
  for (let start = 0; start < messages.length;) {
    if (messages[start].role !== 'assistant') { start++; continue; }
    let boundary = start;
    while (boundary < messages.length && messages[boundary].role === 'assistant') boundary++;
    let end = boundary;
    while (end < messages.length && messages[end].role === 'user') end++;
    const calls = new Map();
    const results = new Map();
    for (let index = start; index < end; index++) {
      const blocks = Array.isArray(messages[index].content) ? messages[index].content : [];
      for (const block of blocks) {
        const isCall = index < boundary && block.type === 'tool_use';
        const isResult = index >= boundary && block.type === 'tool_result';
        if (!isCall && !isResult) continue;
        const id = isCall ? block.id : block.tool_use_id;
        if (typeof id !== 'string' || !id) continue;
        const groups = isCall ? calls : results;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(block);
      }
    }
    for (const [id, group] of calls) {
      if (group.length === 1 && results.get(id)?.length === 1) {
        paired.add(group[0]);
        paired.add(results.get(id)[0]);
        resultNames.set(results.get(id)[0], group[0].name);
      }
    }
    start = end;
  }
  return { blocks: paired, resultNames };
}

function convertRequest(body, { countOnly = false } = {}) {
  const model = resolveModel(body.model);
  if (!Array.isArray(body.messages) || (!countOnly && !body.messages.length)) throw problem('messages must be a nonempty array.');
  const invalidRoleIndex = body.messages.findIndex(message => !message || !['system', 'user', 'assistant'].includes(message.role));
  if (invalidRoleIndex !== -1) {
    throw problem('messages[' + invalidRoleIndex + '] must have a system, user, or assistant role.');
  }
  if (body.messages.some(message => Array.isArray(message.content) &&
      message.content.some(block => !block || typeof block !== 'object'))) {
    throw problem('Content blocks must be objects.');
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) ||
      body.tools.some(tool => !tool || typeof tool !== 'object'))) throw problem('tools must be an array of tool definitions.');
  const outputFormat = prepareOutputFormat(body.output_config?.format);
  const { blocks: paired, resultNames } = pairedBlocks(body.messages);
  const messages = [];
  if (body.system) messages.push({ role: 'system', content: packed(contentParts(body.system)) });
  if (outputFormat) {
    messages.push({ role: 'system', content: 'When returning your final answer, return only JSON matching this schema:\n' +
      JSON.stringify(outputFormat.schema) });
  }
  const referencedTools = new Set();
  const discoveredTools = new Map();
  function collectDiscoveredTools(block) {
    if (block.type !== 'tool_result' || resultNames.get(block) !== 'ToolSearch') return;
    const text = typeof block.content === 'string' ? block.content :
      (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
    // Claude Code's client-side search returns materialized schemas as text.
    // Only its paired result is authoritative; arbitrary tool text cannot add tools.
    for (const group of text.matchAll(/<functions>([\s\S]*?)<\/functions>/g)) {
      for (const match of group[1].matchAll(/<function>([\s\S]*?)<\/function>/g)) {
        let definition;
        try { definition = JSON.parse(match[1]); } catch { continue; }
        if (typeof definition.name !== 'string' || !definition.parameters ||
            typeof definition.parameters !== 'object') continue;
        referencedTools.add(definition.name);
        discoveredTools.set(definition.name, {
          type: 'function', function: {
            name: definition.name, description: definition.description ?? '', parameters: definition.parameters,
          },
        });
      }
    }
  }
  function collectReferences(value) {
    if (Array.isArray(value)) { value.forEach(collectReferences); return; }
    if (!value || typeof value !== 'object') return;
    if (value.type === 'tool_reference' && typeof value.tool_name === 'string') referencedTools.add(value.tool_name);
    if (value.content) collectReferences(value.content);
  }
  for (const message of body.messages) {
    collectReferences(message.content);
    if (typeof message.content === 'string') {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (!Array.isArray(message.content)) throw problem('Message content must be text or an array.');
    message.content.forEach(collectDiscoveredTools);
    const parts = [];
    const calls = [];
    for (const block of message.content) {
      if (message.role === 'assistant' && block.type === 'tool_use' && paired.has(block)) {
        calls.push({ id: block.id, type: 'function',
          function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } });
      } else if (message.role === 'user' && block.type === 'tool_result' && paired.has(block)) {
        messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content: packed(toolResultParts(block)) });
      } else if (block.type === 'tool_use') {
        parts.push({ type: 'text', text: '[Historical tool call ' + String(block.name) +
          ' has no unambiguous result. Execution status is unknown; verify before retrying.]' });
      } else if (block.type === 'tool_result') {
        parts.push({ type: 'text', text: '[Unpaired historical tool result; execution status is uncertain.]' },
          ...toolResultParts(block));
      } else parts.push(...contentParts([block]));
    }
    if (parts.length || calls.length) {
      messages.push({ role: message.role, content: packed(parts), ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  const unsupportedTools = [];
  const tools = [];
  for (const tool of body.tools ?? []) {
    if (!tool.input_schema || (tool.type && tool.type !== 'custom')) {
      unsupportedTools.push(tool.name || tool.type || 'unknown');
      continue;
    }
    if (tool.name === 'DeferredToolPlaceholder') continue;
    if (tool.defer_loading && !referencedTools.has(tool.name)) continue;
    tools.push({ type: 'function', function: {
      name: tool.name, description: tool.description ?? '', parameters: tool.input_schema,
    } });
  }
  for (const [name, definition] of discoveredTools) {
    if (!tools.some(tool => tool.function.name === name)) tools.push(definition);
  }
  let toolChoice;
  switch (body.tool_choice?.type) {
    case undefined: break;
    case 'auto': toolChoice = 'auto'; break;
    case 'none': toolChoice = 'none'; break;
    case 'any': toolChoice = 'required'; break;
    case 'tool':
      if (!tools.some(tool => tool.function.name === body.tool_choice.name)) {
        throw problem('Requested tool "' + body.tool_choice.name + '" is not available on this M365 route.');
      }
      toolChoice = { type: 'function', function: { name: body.tool_choice.name } };
      break;
    default: throw problem('Unsupported tool_choice.');
  }
  if (toolChoice === 'required' && !tools.length) throw problem('tool_choice requires an available client-side tool.');
  const request = {
    model, messages, stream: Boolean(body.stream),
    ...(Number.isFinite(body.max_tokens) ? { max_tokens: body.max_tokens } : {}),
    ...(Number.isFinite(body.temperature) ? { temperature: body.temperature } : {}),
    ...(tools.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    ...(body.stream ? { stream_options: { include_usage: true } } : {}),
  };
  return { request, unsupportedTools, outputFormat };
}

function estimateInput(request) {
  let images = 0;
  const text = JSON.stringify({ messages: request.messages, tools: request.tools }, (key, value) => {
    if (key === 'image_url') { images++; return '[Image input]'; }
    return value;
  });
  // M365 does not expose a tokenizer or reliable usage. This local estimate
  // powers compaction only; it is not provider accounting or a context guarantee.
  return Math.max(1, textTokens(text) + images * 1600);
}

function usageOf(usage, inputEstimate, outputText) {
  const valid = value => Number.isFinite(value) && value >= 0 ? value : 0;
  const prompt = valid(usage?.prompt_tokens) || inputEstimate;
  const cacheRead = Math.min(prompt, valid(usage?.prompt_tokens_details?.cached_tokens));
  const cacheWrite = Math.min(prompt - cacheRead, valid(usage?.prompt_tokens_details?.cache_creation_input_tokens));
  return {
    input_tokens: prompt - cacheRead - cacheWrite,
    output_tokens: valid(usage?.completion_tokens) || textTokens(outputText),
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
  };
}

function upstreamDiagnostics(usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const diagnostics = { provider_cache_reported: Number.isFinite(cached) && cached >= 0 };
  if (diagnostics.provider_cache_reported) diagnostics.provider_cache_read_tokens = cached;
  const source = usage?.x_m365_context;
  if (source && ['full', 'delta'].includes(source.initial_mode) &&
      typeof source.conversation_reused === 'boolean' &&
      /^[a-f0-9]{20}$/.test(source.conversation_hash ?? '') &&
      ['reused_messages', 'submitted_characters', 'handler_attempts'].every(key =>
        Number.isSafeInteger(source[key]) && source[key] >= 0) &&
      typeof source.tool_configuration_updated === 'boolean' &&
      source.provider_prompt_cache === 'unreported') {
    diagnostics.context = Object.fromEntries([
      'initial_mode', 'conversation_reused', 'conversation_hash', 'reused_messages',
      'submitted_characters', 'handler_attempts', 'tool_configuration_updated', 'provider_prompt_cache',
    ].map(key => [key, source[key]]));
  }
  const quota = {};
  for (const name of ['conversation_remaining', 'opus_daily_remaining', 'opus_weekly_remaining',
    'sonnet55_daily_remaining', 'sonnet55_weekly_remaining']) {
    const value = usage?.['x_m365_' + name];
    if (Number.isFinite(value) && value >= 0) quota[name] = value;
  }
  if (Object.keys(quota).length) diagnostics.quota = quota;
  return diagnostics;
}

function parseTool(call) {
  if (!call.id || !call.name) throw problem('Upstream returned a tool call without an ID or name.', 502, 'api_error');
  let input;
  try { input = JSON.parse(call.arguments || '{}'); }
  catch { throw problem('Upstream returned invalid JSON arguments for tool "' + call.name + '".', 502, 'api_error'); }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw problem('Tool arguments must be a JSON object.', 502, 'api_error');
  }
  return { type: 'tool_use', id: call.id, name: call.name, input };
}

function assertResponseModel(actual, expected) {
  if (!actual) return;
  let resolved;
  try { resolved = resolveModel(actual); } catch {}
  if (resolved !== expected) throw problem('Upstream returned model "' + String(actual).slice(0, 160) +
    '" for requested route "' + expected + '". Response rejected; no fallback was used.', 502, 'api_error');
}

function stopReason(reason) {
  const reasons = { stop: 'end_turn', length: 'max_tokens', tool_calls: 'tool_use', content_filter: 'refusal' };
  if (!Object.hasOwn(reasons, reason)) throw problem('Upstream ended without a valid finish reason.', 502, 'api_error');
  return reasons[reason];
}

function responseMessage(completion, model, inputEstimate, outputFormat) {
  assertResponseModel(completion.model, model);
  const choice = completion.choices?.[0];
  if (!choice?.message) throw problem('Upstream returned no assistant message.', 502, 'api_error');
  const content = [];
  const finalText = !choice.message.tool_calls?.length && choice.finish_reason === 'stop'
    ? structuredText(choice.message.content ?? '', outputFormat) : choice.message.content;
  if (finalText) content.push({ type: 'text', text: finalText });
  for (const call of choice.message.tool_calls ?? []) {
    content.push(parseTool({ id: call.id, name: call.function?.name, arguments: call.function?.arguments }));
  }
  const reason = stopReason(choice.finish_reason);
  if (!content.length && reason !== 'refusal') throw problem('Upstream returned neither text nor tool calls.', 502, 'api_error');
  return {
    id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant',
    model, content, stop_reason: reason, stop_sequence: null,
    usage: usageOf(completion.usage, inputEstimate, JSON.stringify(content)),
  };
}

async function streamMessage(stream, model, inputEstimate, emit, observeModel = () => {}, outputFormat, observeUsage = () => {}) {
  await emit({ type: 'message_start', message: {
    id: 'msg_' + randomUUID().replaceAll('-', ''), type: 'message', role: 'assistant',
    model, content: [], stop_reason: null, stop_sequence: null,
    usage: usageOf(undefined, inputEstimate, ''),
  } });
  let text = '';
  let textStarted = false;
  let finish;
  let usage;
  const calls = new Map();
  for await (const chunk of stream) {
    if (chunk.error) throw streamError(chunk.error);
    assertResponseModel(chunk.model, model);
    if (chunk.model) observeModel(chunk.model);
    if (chunk.usage) { usage = chunk.usage; observeUsage(usage); }
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (finish && (choice.delta?.content || choice.delta?.tool_calls?.length)) {
      throw problem('Upstream emitted content after completing the message.', 502, 'api_error');
    }
    if (choice.delta?.content) {
      if (!outputFormat && !textStarted) {
        await emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        textStarted = true;
      }
      text += choice.delta.content;
      if (!outputFormat) await emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: choice.delta.content } });
    }
    for (const delta of choice.delta?.tool_calls ?? []) {
      const index = delta.index ?? 0;
      const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
      if (delta.id && delta.id !== call.id) call.id += delta.id;
      if (delta.function?.name && delta.function.name !== call.name) call.name += delta.function.name;
      if (delta.function?.arguments) call.arguments += delta.function.arguments;
      calls.set(index, call);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const reason = stopReason(finish);
  const parsedCalls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => parseTool(call));
  if (outputFormat && !parsedCalls.length && reason === 'end_turn') text = structuredText(text, outputFormat);
  if (outputFormat && text) {
    await emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    await emit({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
    textStarted = true;
  }
  if (!text && !parsedCalls.length && reason !== 'refusal') {
    throw problem('Upstream returned neither text nor tool calls.', 502, 'api_error');
  }
  if (textStarted) await emit({ type: 'content_block_stop', index: 0 });
  let index = textStarted ? 1 : 0;
  // Buffer tool arguments until valid JSON is complete. Interleaved OpenAI
  // deltas must never target an Anthropic block that has already been closed.
  for (const call of parsedCalls) {
    await emit({ type: 'content_block_start', index, content_block: { ...call, input: {} } });
    await emit({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } });
    await emit({ type: 'content_block_stop', index });
    index++;
  }
  const finalUsage = usageOf(usage, inputEstimate, text + JSON.stringify(parsedCalls));
  await emit({ type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: finalUsage });
  await emit({ type: 'message_stop' });
  return { stop_reason: reason, usage: finalUsage };
}

module.exports = { problem, convertRequest, estimateInput, usageOf, upstreamDiagnostics, assertResponseModel, responseMessage, streamMessage };
