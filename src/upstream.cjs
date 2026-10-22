'use strict';

function errorStatus(error) {
  const statuses = { rate_limit_error: 429, overloaded_error: 529,
    invalid_request_error: 400, authentication_error: 401, permission_error: 403 };
  const detail = error.error?.error || error.error || error;
  return error.statusCode || error.status || statuses[detail.type] || 502;
}

function errorMetadata(error) {
  const detail = error.error?.error || error.error || error;
  const metadata = {};
  const codes = ['priority_access_exhausted', 'model_route_unavailable', 'model_not_found',
    'model_not_supported', 'm365_throttled', 'm365_throttle_hold', 'm365_turn_budget'];
  if (codes.includes(detail.code)) metadata.error_code = detail.code;
  if (['PerUserThrottled', 'PerTenantThrottled', 'PerConversationThrottled', 'day', 'week'].includes(detail.param)) {
    metadata.error_scope = detail.param;
  }
  const limit = /^M365 Copilot rate limited \((\d+)\/(\d+) messages used\)/.exec(detail.message || '');
  if (limit) metadata.upstream_rate_limit = { current: Number(limit[1]), max: Number(limit[2]) };
  const retryAfter = error.headers?.get?.('retry-after');
  if (typeof retryAfter === 'string' && /^\d+$/.test(retryAfter)) metadata.retry_after_seconds = Number(retryAfter);
  return metadata;
}

function streamError(error) {
  const statusCode = errorStatus(error);
  return Object.assign(new Error(error.message || 'Upstream stream failed.'), {
    statusCode, type: error.type || 'api_error', error, code: error.code,
    headers: Number.isFinite(error.retry_after)
      ? new Headers({ 'retry-after': String(error.retry_after) }) : undefined,
  });
}

function canFallback(error) {
  const status = errorStatus(error);
  const detail = error.error?.error || error.error || error;
  if ([400, 401, 403].includes(status)) return false;
  if (['priority_access_exhausted', 'model_route_unavailable', 'model_not_found', 'model_not_supported'].includes(detail.code)) return true;
  return [503, 529].includes(status) && detail.type === 'overloaded_error';
}

// A provider can accept HTTP streaming and then report an unavailable model.
// Wait for actual content before committing an Anthropic message to one route.
async function prepareStream(stream, observeChunk) {
  const iterator = stream[Symbol.asyncIterator]();
  let usageChunk;
  try {
    while (true) {
      const item = await iterator.next();
      if (item.done) throw Object.assign(new Error('Upstream ended before returning content.'), { statusCode: 502, type: 'api_error' });
      const chunk = item.value;
      if (chunk.error) throw streamError(chunk.error);
      observeChunk(chunk);
      if (chunk.usage) usageChunk = chunk;
      const choice = chunk.choices?.[0];
      if (choice?.delta?.content || choice?.delta?.tool_calls?.length || choice?.finish_reason) {
        return (async function* () {
          try {
            if (usageChunk && usageChunk !== chunk) yield usageChunk;
            yield chunk;
            while (true) {
              const next = await iterator.next();
              if (next.done) break;
              yield next.value;
            }
          } finally { await iterator.return?.(); }
        })();
      }
    }
  } catch (error) {
    await iterator.return?.();
    throw error;
  }
}

module.exports = { errorStatus, errorMetadata, streamError, canFallback, prepareStream };
