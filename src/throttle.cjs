'use strict';

const { errorStatus, errorMetadata } = require('./upstream.cjs');
const DEFAULT_COOLDOWN_MS = 75 * 60 * 1000;
const ACCOUNT_CODES = new Set(['m365_throttled', 'm365_throttle_hold', 'm365_turn_budget']);

function retryDelay(error, now) {
  const detail = error.error?.error || error.error || error;
  const value = error.headers?.get?.('retry-after') ?? detail.retry_after;
  if (value === undefined || value === null || value === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) && date > now ? date - now : undefined;
}

function createAccountThrottle(options = {}) {
  const now = options.now || Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  if (!Number.isFinite(cooldownMs) || cooldownMs <= 0) throw new Error('Invalid account throttle cooldown.');
  let state;
  const restored = options.initialState;
  if (restored && ACCOUNT_CODES.has(restored.code) && Date.parse(restored.retry_at) > now() &&
      ['local_policy', 'upstream_retry_after'].includes(restored.basis)) {
    state = { code: restored.code, retry_at: restored.retry_at, observed_at: restored.observed_at,
      basis: restored.basis, ...(['PerUserThrottled', 'PerTenantThrottled'].includes(restored.scope) ? { scope: restored.scope } : {}) };
  }

  function snapshot() {
    if (!state || Date.parse(state.retry_at) <= now()) return null;
    return { ...state, retry_after_seconds: Math.ceil((Date.parse(state.retry_at) - now()) / 1000) };
  }

  function observe(error) {
    if (error.localThrottleHold || errorStatus(error) !== 429) return false;
    const metadata = errorMetadata(error);
    if (!ACCOUNT_CODES.has(metadata.error_code) || metadata.error_scope === 'PerConversationThrottled') return false;
    const at = now();
    const delay = retryDelay(error, at);
    if (metadata.error_code === 'm365_turn_budget' && delay === undefined) return false;
    state = { code: metadata.error_code, observed_at: new Date(at).toISOString(),
      retry_at: new Date(at + (delay ?? cooldownMs)).toISOString(),
      basis: delay === undefined ? 'local_policy' : 'upstream_retry_after',
      ...(metadata.error_scope ? { scope: metadata.error_scope } : {}) };
    options.onChange?.({ ...state });
    return true;
  }

  function assertAvailable() {
    const active = snapshot();
    if (!active) return;
    const reason = active.code === 'm365_turn_budget' ? 'account turn budget' : 'account throttle';
    const policy = active.basis === 'local_policy'
      ? 'This is a local cooldown; Microsoft did not provide a reset time.'
      : 'This follows the upstream Retry-After value.';
    const message = `M365 ${reason}: this request was not sent upstream. ` +
      `Gateway retry time: ${active.retry_at}. ${policy} All model routes share this account.`;
    throw Object.assign(new Error(message), {
      statusCode: 429, type: 'rate_limit_error', localThrottleHold: true,
      error: { message, type: 'rate_limit_error', code: 'm365_throttle_hold', param: active.scope },
      headers: new Headers({ 'retry-after': String(active.retry_after_seconds), 'x-should-retry': 'false' }),
    });
  }

  return { snapshot, observe, assertAvailable };
}

module.exports = { createAccountThrottle, DEFAULT_COOLDOWN_MS };
