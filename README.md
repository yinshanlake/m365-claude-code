# M365 Claude Code

Run the **real Claude Code CLI** against Microsoft 365 Copilot through a local Anthropic-compatible gateway. Use the terminal UI, files, shell tools, MCP integrations, and native permission prompts with the model routes available to your M365 account.

**Giving this to an agent? Start with [AGENT_README.md](AGENT_README.md).**

~~~text
Claude Code: terminal UI, tools, MCP, permissions
    |
    | Anthropic Messages API
    v
This gateway                         127.0.0.1:4145
    |
    | OpenAI Chat Completions API
    v
cramt/m365-copilot-proxy              127.0.0.1:4144
    |
    | Microsoft 365 Copilot / SignalR
    v
The model route available to your account
~~~

The gateway translates protocols; Claude Code executes the tools. The M365 backend reconstructs tool calls from chat text, so agent behavior remains model-dependent. This is an experimental integration, with [documented compatibility limits](docs/compatibility.md).

## Quick start: Windows

Prerequisites: **Node.js 24+**, **PowerShell 7.4+**, **Git with Git Bash**, **Chrome**, **Claude Code 2.1.280+**, and a **work or school account with access to M365 Copilot**. Install Claude Code through its [official setup instructions](https://code.claude.com/docs/en/setup).

~~~powershell
git clone https://github.com/yinshanlake/m365-claude-code.git
cd m365-claude-code
pwsh -NoProfile -File .\scripts\Setup.ps1
.\m365-claude.cmd
~~~

Complete Microsoft sign-in in Chrome when prompted. Your normal SSO and MFA flow stays in the browser. This setup does not request an account password or MFA seed.

Setup installs the gateway dependencies, checks out the pinned upstream proxy, applies the session-isolation and context-reuse patch, and builds it. It creates a private local gateway credential and a separate Claude profile. It does not install a Windows startup task or change your normal Claude configuration.

If your environment requires an approved npm mirror, pass its HTTPS URL with **-Registry**. If executables are not discoverable, provide **-ClaudePath** or **-ChromePath**.

## Everyday use

~~~powershell
.\m365-claude.cmd
.\m365-claude.cmd -Directory C:\work\my-project
.\m365-claude.cmd -Model claude-opus-4.8
.\m365-claude.cmd --continue
.\m365-claude.cmd -NoMcp
~~~

Inside the session, use **/model** to choose a preferred route. Enter saves the choice for future sessions; **s** chooses it for one session. Unknown routes return an error. The launcher does not pin every request to a fixed model header.

The default preference is Opus. For a model-specific allowance exhaustion, unavailable model route, or explicit overload, the gateway tries the other configured routes in this order: **Opus, Opus 4.8, Sonnet 5.5, Sonnet 5, Sonnet, GPT 5.5 Think Deeper, GPT 6.1 Sol**. It skips the route already attempted. Authentication errors, malformed requests, account-wide throttling, and failures after output starts do not trigger this sequence.

An explicit account throttle starts a shared cooldown: queued requests and retries from other sessions or models are rejected locally. The gateway honors an upstream **Retry-After** value; otherwise it uses a conservative **75-minute local policy**, matching the pinned backend's hold default. This is not a Microsoft reset guarantee. The cooldown survives gateway restarts. **Doctor.ps1** shows the local retry time, and **Doctor.ps1 -Recent** includes failed requests and their error codes. See [context reuse and quotas](docs/context-reuse.md).

The native model picker shows your preference. The response's model field and private route logs identify what actually answered; **Doctor.ps1 -Recent** displays recent routes. Set **fallbackEnabled: false** in .local/config.json for strict routing, and restart the owned services after changing that setting. An explicitly supplied native **--fallback-model** option disables gateway fallback for that client and retains Claude Code's own behavior.

Native flags such as **--print**, **--verbose**, **--debug**, **--resume**, and **--continue** pass through. PowerShell's advanced parameter binding is deliberately avoided so it cannot consume native Claude flags. User-supplied **--settings** content is preserved in a private launch settings file, with only the connector environment taking precedence. This prevents project settings, including a home-directory .claude/settings.json, from redirecting M365 requests to another gateway.

The launcher uses the concise prompt in [prompts/agent.md](prompts/agent.md), and keeps Claude Code responsible for tools and permissions. All built-in tools are enabled by default; **-BuiltInTools Read,Edit,Write,Bash** selects a smaller task-specific subset.

## Models

| Route | Purpose |
| --- | --- |
| claude-sonnet | Included Sonnet route |
| claude-sonnet-5 | Sonnet 5 route; entitlement-dependent |
| claude-sonnet-5.5 | Paid Sonnet scenario; priority allowance may apply |
| claude-opus | Default preference; paid Opus scenario with a priority allowance |
| claude-opus-4.8 | Included Opus scenario; requires an eligible account |
| gpt-5.5-think-deeper | GPT fallback after the configured Claude routes |
| gpt-6.1-sol | Additional proxy-advertised reasoning route |

These are **upstream route aliases**, not independently verified model versions. Account entitlements still apply. The pinned backend does not advertise Fable; a Claude Code menu label cannot make it available.

The Opus 4.8 picker entry uses the client alias **m365-opus-included** so this Claude Code version keeps it separate from the other Opus entry. It maps explicitly to the upstream **claude-opus-4.8** route.

The small-helper alias is assigned to the included Sonnet route because this backend does not advertise Haiku. Model definitions and fallback order live in [src/models.json](src/models.json); the picker's compatibility hints do not prove Microsoft's context capacity or model identity.

This is a direct connection to the local M365 gateway and does not require Agent Maestro. It is still a protocol bridge. An official Anthropic connection requires separate Anthropic credentials and does not supply GPT models; changing a provider label cannot convert M365 access into an official Anthropic API account.

## Optional MCP

No personal or organization-specific MCP servers are shipped. The private configuration starts empty at **.local/mcp.json**.

For a fresh setup with browser tools (stop the owned services before rerunning setup):

~~~powershell
pwsh -NoProfile -File .\scripts\Setup.ps1 -McpConfig .\examples\mcp.playwright.json
.\m365-claude.cmd
~~~

**-McpConfig** replaces the private MCP file with the file you select. Merge with your existing configuration first if you already added servers. Keys and private service endpoints belong in local configuration, not commits.

The optional Playwright example uses Chrome and a normal browser session. It does not import someone else's authenticated browser profile.

## Verify and manage

~~~powershell
.\m365-claude.cmd auth status --json
pwsh -NoProfile -File .\scripts\Doctor.ps1
pwsh -NoProfile -File .\scripts\Doctor.ps1 -Live -Model claude-sonnet
pwsh -NoProfile -File .\scripts\Doctor.ps1 -CheckContext -Model claude-sonnet
pwsh -NoProfile -File .\scripts\Doctor.ps1 -Recent
pwsh -NoProfile -File .\scripts\Manage.ps1 -Action Status
pwsh -NoProfile -File .\scripts\Manage.ps1 -Action Stop
~~~

Doctor checks the gateway and compares its catalog with the real upstream model list. **-Live** makes one small inference request. **-CheckContext** makes two requests and verifies that the second reuses M365 context and recalls the first turn. Provider prompt-cache counters remain unreported; see [context reuse and quotas](docs/context-reuse.md). A successful chat alone does not verify agent tool behavior; the agent guide includes a real file-and-command check.

The manager stops only processes whose PID, executable path, and start time match its records. Occupied ports are never taken over. Use **-GatewayPort** and **-UpstreamPort** during setup to choose other ports.

Already running an M365 proxy? Reuse it:

~~~powershell
pwsh -NoProfile -File .\scripts\Setup.ps1 -UpstreamBaseUrl http://127.0.0.1:4144/v1
~~~

If that upstream requires an API key, place it in **.local/upstream-key.txt**. External backend processes are not managed by this repository. Their model catalog must match the routes you configure.

## Tool calls and context reuse

These are separate capabilities; passing a protocol test does not prove an agent task will succeed end to end.

| Capability | What this repository does | How to verify / limitation |
| --- | --- | --- |
| Tool-call protocol | Converts Anthropic tool calls and results, retaining IDs and parallel results; handles streamed arguments, images, and deferred tool schemas. Claude Code—not this gateway—executes tools and applies its native permissions. | `npm test` exercises local HTTP and Anthropic SDK exchanges with fixture responses. The M365 backend reconstructs tool calls from generated text, so tool selection and execution remain model-dependent. Use the real file-and-command check in [AGENT_README.md](AGENT_README.md) for an end-to-end check. |
| M365 conversation reuse | Keeps per-client conversations separate and, when the submitted history still matches, reuses M365 context by sending only the new-message delta. | `pwsh -NoProfile -File .\scripts\Doctor.ps1 -CheckContext -Model claude-sonnet` makes two live inference requests and checks recall of a random first-turn value, the same conversation, and delta mode. These requests consume M365 turns. Reuse is conservative; model changes, rewritten history, uncertain failures, idle eviction, or process restarts require fresh context. |
| Provider prompt cache | Does not claim or estimate provider cache hits. | The pinned upstream does not expose Anthropic prompt-cache counters or cache-control behavior. Unknown counters remain unreported; local token estimates are for client context management, not billing. See [context reuse and quotas](docs/context-reuse.md). |

For protocol and live-test boundaries, including documented mixed tool behavior, see [compatibility details](docs/compatibility.md).

Native Anthropic server tools, signed thinking, exact effort control, precise billing/cache accounting, and a guaranteed 1M context window are not supplied.

## Known issues

M365 account throttling can interrupt long agent sessions even when conversation reuse works. A confirmed gateway bug that consumed the execution timeout while requests waited in the queue has been fixed. See [Known issues](docs/known-issues.md) for the evidence, remaining cache/retry diagnostic gaps, and the limits of the current mitigations.

## Development

~~~powershell
npm ci
npm test
npm run test:launcher
npm run audit:public
~~~

The Node protocol tests run without Microsoft credentials or network inference. The launcher checks require PowerShell. CI runs the protocol suite on Windows and Linux; the automated installer is Windows-first.

Private state and logs live in **.local/**. The downloaded backend lives in **.runtime/**. Both are ignored by Git; see [SECURITY.md](SECURITY.md). **M365_CLAUDE_DATA_DIR** can select a different private state directory.

Built with [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy), informed by [Agent Maestro](https://github.com/Joouis/agent-maestro). See [NOTICE.md](NOTICE.md) and [LICENSE](LICENSE).
