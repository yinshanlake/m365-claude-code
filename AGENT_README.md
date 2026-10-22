# Agent setup guide

When a user asks you to set this up, complete the installation and verify the actual client flow. Use English for repository changes. Keep generated state private.

## 1. Check the machine

Use Windows, Node.js 24+, PowerShell 7.4+, Git with Git Bash, Chrome, and Claude Code 2.1.280+. Check executable versions instead of assuming they exist. The user needs an eligible work or school M365 account.

If prerequisites are missing, follow their official installers within the user's authorized scope. Claude Code is a separate product; do not copy its executable into this repository.

## 2. Install

From the checkout:

~~~powershell
pwsh -NoProfile -File .\scripts\Setup.ps1
~~~

Setup downloads the exact revision in upstream.json, applies patches/session-isolation.patch, installs locked dependencies, and builds the backend. It creates .local/ with a private gateway key, a dedicated Claude profile, and an empty MCP configuration.

Use **-ClaudePath**, **-ChromePath**, or **-Registry** if the environment requires explicit paths or an approved HTTPS package registry. Use **-GatewayPort** and **-UpstreamPort** if the defaults are occupied. Do not stop an unrelated process to free a port.

To reuse an existing backend instead of downloading one, provide **-UpstreamBaseUrl**. Stop the owned services before rerunning setup; it preserves the generated key and saved model selection. Do not reset the cached upstream checkout over unknown local changes.

## 3. Start and authenticate

~~~powershell
.\m365-claude.cmd
~~~

Let the user complete Microsoft SSO/MFA in Chrome when required. Do not ask them to paste passwords, MFA seeds, cookies, or token caches into chat.

The client authenticates to the loopback gateway through ANTHROPIC_AUTH_TOKEN. It does not need a separate Claude account login for this gateway. The dedicated profile initializes local-gateway onboarding; workspace trust and tool approvals remain native.

The launcher pins connection variables through a private --settings file, so a project cannot silently reroute it to Agent Maestro or another provider. Keep native permissions and unrelated project settings intact. Opus is the default preference; eligible model failures try every other configured Claude route before GPT. Official Anthropic access is a separate account/API configuration.

## 4. Verify before declaring success

~~~powershell
.\m365-claude.cmd auth status --json
pwsh -NoProfile -File .\scripts\Doctor.ps1
pwsh -NoProfile -File .\scripts\Doctor.ps1 -Live -Model claude-sonnet
pwsh -NoProfile -File .\scripts\Doctor.ps1 -CheckContext -Model claude-sonnet
pwsh -NoProfile -File .\scripts\Doctor.ps1 -Recent
~~~

The context check makes two inference requests; use it to verify real conversation reuse, not provider prompt-cache billing. Also exercise an interactive session: open **/model**, select a configured route, and make a request. Inspect the actual response model and private route metadata, including fallback attempts. The picker displays the preferred route. Do not use the model's self-description as proof.

For an agent check, create a scratch directory under .local/, with a random nonce and numbers in an input file. Ask Claude Code to read the file, write the nonce and sum to a result file, and run a local verification script. Check the actual file and command output. A prose claim that a task is done is not sufficient.

If the backend refuses, repeats work, or chooses an unrelated tool, report that limitation. Do not silently substitute another model or claim full compatibility. Smaller toolsets can be tested using **-BuiltInTools**; label those results accordingly.

## 5. Hand off

Give the user the exact launcher path, the selected route, authentication status, and the result of the real tool check. Add only the MCP servers they request to .local/mcp.json; an optional public browser example is under examples/.

Never commit .local/, .runtime/, login caches, credentials, transcripts, or personal MCP settings. Before contributing code, run **npm test**, **npm run test:launcher**, and **npm run audit:public**.

The model is supplied through Microsoft 365 Copilot. Claude Code still owns the terminal UI, tool execution, MCP client, and permissions; the bridge supplies protocol compatibility.
