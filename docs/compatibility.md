# Compatibility and design

## Responsibilities

Claude Code provides the native terminal client, tool execution, MCP client, session UI, and permission handling. The launcher changes the API endpoint and initializes a separate local profile.

This gateway implements the Anthropic Messages contract over an OpenAI-compatible M365 backend. The pinned cramt proxy implements Microsoft authentication and the private SignalR protocol. Its tool calls are reconstructed from model text; the gateway does not execute tools itself.

Agent Maestro was the design reference for model resolution, request lifecycle, tool-history pairing, images, streaming events, and usage conversion. Its VS Code Language Model API can deliver native tool-call objects. The M365 web protocol has a different capability boundary.

## Protocol behavior

The model in each request determines the preferred route. Known aliases are explicit; invalid models fail. With fallback enabled, a model-specific quota or availability failure tries every remaining configured Claude route before GPT. The response identifies the actual model, and the trace records the complete attempt sequence. The gateway still rejects an upstream response that misidentifies the route attempted.

Fallback happens before any text or tool arguments are delivered. Early SSE quota errors are handled before message_start; heartbeats keep the connection open. Once output starts, a failure is reported without switching models. Authentication failures, malformed requests, account-wide throttles, and unknown empty replies never trigger a model sweep. Explicit native --fallback-model arguments take precedence by disabling gateway fallback for that client.

Explicit account throttles are shared across clients and model routes. The gateway checks cooldown state before opening a stream and again after a queued request acquires the upstream slot. Subsequent requests receive HTTP 429 with Retry-After and x-should-retry: false without reaching M365. An error after SSE headers were sent remains an SSE error; the next request is rejected before streaming. Microsoft may omit its reset time, so the fallback hold is labeled as a local policy. See the quota guide for its limits.

Tool calls and results retain their IDs. Parallel results, error markers, and images are preserved. Interleaved system messages from newer native clients retain their position and do not break tool pairing. Incomplete or ambiguous history stays historical context. Claude Code's client-side ToolSearch can return definitions as functions blocks in text; only a paired ToolSearch result can materialize those schemas.

OpenAI stream fragments become ordered Anthropic content blocks. Tool arguments are buffered until valid JSON is available. Truncation, HTTP failures, in-stream errors, cancellation, and timeouts are propagated instead of being presented as successful completion.

JSON-schema output is requested and validated locally. Nonconforming output fails; this is not a claim of native constrained decoding. Token counts are local estimates, without invented cache savings.

The upstream patch namespaces conversation fingerprints by an opaque client session identifier. It prevents separate client sessions with identical opening messages from sharing M365 state, preserves a scoped conversation when tools are discovered, and verifies the retained message prefix. New system messages and tool configuration changes are included in deltas. Requests are serialized to fit the backend's behavior. See [context reuse and quotas](context-reuse.md) for diagnostics and limits.

## Validation

The extracted protocol suite contains 38 tests, including real local HTTP exchanges with the Anthropic SDK. It covers routing, interleaved system messages, model mismatch, parallel tool calls, deferred schemas, JSON output, errors, cancellation, timeouts, queued requests, context/cache telemetry, ordered fallback, shared account cooldowns, restored cooldown state, expiry, and privacy-preserving error metadata. Launcher checks cover native argument forwarding, connection-setting precedence, retained user permissions, and PowerShell syntax.

A native Claude Code fixture with an active cooldown made one gateway request and exited with a clear HTTP 429 cooldown message in about one second. It made zero requests to the fixture upstream. This verifies the client's handling of the local hold response without consuming M365 turns or assuming that Microsoft has lifted an account throttle.

A native Claude Code 2.1.280 fixture reproduced a project setting overriding the launch environment. The private launch-settings overlay prevented that override. A second native fixture forced every Claude route to fail with a model-specific quota error: the client made no requests to the competing project endpoint, the gateway attempted all five Claude routes before GPT, and the native assistant record identified the actual GPT route. These checks used local fixture servers and consumed no M365 quota.

A live native-client routing check on October 22, 2026 launched from a directory with competing project settings. The request reached the direct M365 gateway, received priority_access_exhausted for claude-opus, and completed through claude-opus-4.8 with the expected reply. The gateway trace and native assistant record agreed on the actual route. This was a chat-only routing check, not a tool reliability or provider cache test.

The upstream patch was built and tested against the pinned revision; 81 related tests passed. The full upstream suite on Windows had 421 passing tests, six skipped tests, and two failures in unchanged tests that assume POSIX absolute paths (log.test.ts and turn-budget.test.mjs). CI also runs the full upstream suite on Linux.

During Windows validation with Claude Code 2.1.280, native model switching changed the forwarded routes, unsupported Fable selection returned an error, background JSON requests worked, and a real file/shell check produced a verified result. MCP startup also connected to the configured servers.

A copied native session that previously failed after switching to Sonnet 5 passed a local protocol check with 42 system messages preserved. No external inference was used for that reproduction. A separate two-turn live Sonnet check retained the same M365 conversation, recalled a random first-turn code, and submitted 180 then 71 characters. This establishes context reuse for that check, not provider prompt-cache billing or broad task reliability.

Live behavior was mixed: one Sonnet run refused the full tool description, and GPT/Opus runs sometimes repeated work or chose an unrelated tool. A focused MCP task also failed to call its requested tool in one run. Connection success and a successful chat response are not full-agent reliability guarantees.

No personal transcripts, credentials, or organization-specific MCP settings are included as evidence.

## Boundaries

The upstream model list contains route aliases and does not independently certify a particular model version. Entitlements and priority allowances still apply. The pinned backend does not advertise Fable.

Native Anthropic server tools, native PDF document input, signed thinking, precise effort control, billing/cache accounting, and a guaranteed 1M context window are outside this adapter's contract. Use extracted text or images for documents and client-side MCP for browser operations.

M365_FORCE_AGENT=0 remains the managed-backend default, so this setup does not automatically create or publish a Copilot Studio bot.
