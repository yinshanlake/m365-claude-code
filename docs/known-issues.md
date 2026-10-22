# Known issues

## Account throttling during agent sessions

**Status: open upstream limitation, with confirmed gateway amplification fixed.**

Microsoft 365 can reject turns with `PerUserThrottled`. The pinned backend exposes that result as HTTP 429 / `m365_throttled`. It is an account-level rejection, so switching models within the same M365 account does not provide a separate allowance. The gateway's `m365_throttle_hold` is the subsequent local cooldown, not another Microsoft quota.

The rejection's origin does not establish what exhausted the account. Proxy retries, long agent loops, other clients, and traffic outside this gateway can all affect usage. The available incident records do not prove the exact trigger or attribute the entire incident to one cause.

### Investigation on October 22, 2026

The following evidence was checked locally. No prompts, credentials, transcripts, personal paths, or account identifiers are included here.

| Layer | Evidence | Conclusion |
| --- | --- | --- |
| Gateway scheduling | One request waited about 227 seconds for the serialized upstream slot. The old 240-second timer included that wait, leaving about 13 seconds for M365 before a 504. A subsequent request sent about 199,000 characters of full context. | Confirmed avoidable timeout, retry, and context replay. Queue and execution budgets are now independent. |
| Conversation reuse | In the 30 minutes before the first consecutive 429, 45 requests completed and 39 reported delta-mode reuse. Reconstructed requests from the main session showed stable retained prefixes. | No evidence of systematic full-history resending on every successful turn. Provider prompt-cache billing remains unreported. |
| Native tool history | 42 delivered tool calls had matching results; no identical-input repeats were found. Two tools returned errors. | No evidence of a missing-result or identical-call replay loop in that sample. This does not prove every model decision was efficient or correct. |
| Backend retries | The 45 successful requests reported 46 handler attempts. Failed requests and internal `ModelSession` reconnects were not fully counted by that telemetry. | One extra handler attempt is visible; total upstream request amplification cannot be reconstructed from these logs. |
| M365 service | An explicit `PerUserThrottled` result was captured. Earlier generic 429 records did not retain the subtype. | Account throttling is confirmed; its exact onset, threshold, and reset time are not. |

Fresh context was also observed around native compaction, new/helper sessions, idle eviction, and timeouts. One fresh-context transition after a queued cancellation remains unattributed. That cancelled request had not reached the upstream slot, so the cancellation alone does not explain a backend reset. Existing logs do not expose the reset reason, and a small reconstruction discrepancy remains in that secondary session. This is a remaining diagnostic gap, not proof of a cache defect.

### What the gateway now does

Queue wait and upstream execution each have their own bounded budget. `queueTimeoutMs` defaults to `timeoutMs`, which defaults to 240 seconds. A request admitted from the queue receives the full execution budget; a request whose queue wait expires starts no upstream turn. All model fallback attempts share one execution budget. Route metadata reports `queue_ms` and `upstream_ms` separately. Streaming keepalives continue while waiting. Non-streaming HTTP callers should allow for both budgets in their own timeout.

An explicit account throttle starts a shared, persisted cooldown. Subsequent requests, including already queued requests and requests from other model routes, stay local. The gateway honors an upstream `Retry-After`; without one, it uses a conservative 75-minute local hold. Native Claude Code was verified against a local fixture to display the cooldown and stop retrying after one request. This does not establish when Microsoft will restore service.

### What remains outside the fix

The pinned backend [estimates an account budget](https://github.com/cramt/m365-copilot-proxy/blob/65905e881d6597040966aff9b087aa9a908b358a/packages/core/src/turn-budget.ts#L8-L49) of roughly 100 turns with a refill of 1.6 turns per minute. Its [F58 and later experiments](https://github.com/cramt/m365-copilot-proxy/blob/65905e881d6597040966aff9b087aa9a908b358a/docs/hypotheses.md#L3910) are community measurements, not Microsoft-published limits. They cannot certify this account's exact allowance. The current launch configuration does not enable that backend's optional pre-request pacing; gateway serialization alone is not a per-minute rate limiter.

The backend reconstructs tool calls from text, may retry selected empty or non-actionable replies, and normally returns only one tool call per turn. These behaviors can increase the turns needed for an agent task. The incident records do not show whether discarded parallel calls or those retries caused the initial throttle. Enabling unrestricted tool batching without validation would not be a justified fix.

Use `scripts/Doctor.ps1` to inspect the local cooldown and `scripts/Doctor.ps1 -Recent` to inspect route failures. Do not assume that cache reuse, a new conversation, reauthentication, or a model change clears an account throttle. Future attribution needs metadata for actual upstream turns, failed/cancelled attempts, and explicit context-reset reasons; do not publish raw debug logs to obtain it.
