# Context reuse, token estimates, and quotas

The bridge can verify M365 conversation reuse. It cannot verify Anthropic prompt-cache hits because the M365 web protocol does not expose those counters or an equivalent cache-control API.

| Mechanism | What this integration can establish |
| --- | --- |
| M365 conversation context | The same conversation is reused and only new messages are submitted on later turns. |
| Provider prompt cache | Unreported by the pinned backend. No cache savings are invented. |
| Claude Code token display | Local estimates of the full context, used for compaction; not provider billing or TPM accounting. |
| Priority allowance | M365 reports remaining turns for some paid scenarios. Reusing context still spends a turn. |

Claude Code sends its history to the local gateway. The backend retains the M365 conversation and sends a delta to Microsoft:

~~~text
First request:   instructions + tools + initial messages -> new M365 conversation
Later request:  changed tool configuration + new messages -> same conversation
~~~

The gateway hashes the client's session metadata into the OpenAI request's user field. The backend uses that scope to keep independent sessions apart. Tool-less helper requests have a separate namespace.

The patch keeps a scoped conversation when ToolSearch adds tools. It sends the updated tool configuration without replaying old messages. Tool order alone does not trigger an update. Newly appended system messages remain in the delta.

Before reusing context, the backend verifies the previously submitted message prefix. A model change, rewritten or compacted history, an uncertain failed turn, or the backend's 30-minute idle eviction requires fresh context. Reuse is intentionally conservative: stale context is worse than a full resend. A process restart also clears the in-memory conversation pool.

## Run a real check

Start the services with the launcher, then run:

~~~powershell
pwsh -NoProfile -File .\scripts\Doctor.ps1 -CheckContext -Model claude-sonnet
~~~

This makes two inference requests. The second asks for a random code present only in the first turn. The check verifies recall, the same hashed conversation ID, and delta mode. It reports characters submitted to the backend's ModelSession.run method, not provider token counts. Reconnects inside that method are not separate handler attempts.

Non-streaming responses include a local **x-m365-context** diagnostic header. Both JSON and streaming requests record allowlisted diagnostics in private **.local/logs/routes-YYYY-MM-DD.jsonl** files: conversation reuse, retained message count, submitted characters, tool configuration updates, and handler attempts. No message text is included by the gateway trace.

If an external upstream lacks the patch, the check reports that context telemetry is unavailable. It does not turn an absent counter into a successful cache hit.

## Interpreting a limit

The paid Opus and Sonnet scenarios have priority-access allowances counted per turn in the pinned upstream's measurements. The proxy's internal retries also consume turns. With gateway fallback enabled, a model-specific priority-access exhaustion tries the other configured Claude routes before GPT. With strict routing, select another available route or wait for the reset. Account-wide throttling is reported without sweeping models. Context reuse does not reset an allowance.

An explicit **m365_throttled / PerUserThrottled** error affects the account across model routes and conversations. Successfully reusing conversation context does not remove that turn limit. The gateway starts a shared cooldown and rejects subsequent requests locally, including requests already queued behind the failed turn. Unknown 429 responses, model-specific quotas, and an explicitly conversation-scoped throttle do not activate this account-wide guard.

The guard honors an upstream **Retry-After** value when present. If Microsoft supplies no reset time, it uses **75 minutes** as a conservative local policy, matching the pinned backend's throttle hold default. This is not an official quota formula or a guarantee of service recovery. The local **accountThrottleCooldownMs** configuration can change that default; restart the owned gateway after configuration changes. A running cooldown persists in **.local/account-throttle.json**, so a gateway restart or repeated client request does not shorten or extend it. It expires without sending a probe; the next normal request tests availability.

Use **Doctor.ps1** to read the current cooldown and **Doctor.ps1 -Recent** to inspect error codes, scopes, and attempted routes. Live diagnostic checks are skipped during a cooldown. The gateway sends HTTP 429 with **Retry-After** and **x-should-retry: false** for requests rejected before streaming. Clients may have additional retry behavior; their retries stay local while the guard is active.

A cached or retained prefix still occupies context. The gateway therefore keeps estimating the full context for Claude Code's compaction decisions. Lowering that estimate to only the transmitted delta would hide context growth from the client. M365 does not expose enough information to certify a provider TPM limit, exact cache billing, or a guaranteed context window.
