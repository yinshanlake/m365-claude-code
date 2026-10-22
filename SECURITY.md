# Local state and public source

The gateway binds to 127.0.0.1 and requires a randomly generated local credential. The Windows setup restricts .local/ to the current user and SYSTEM. Keys, configuration, process records, logs, and the dedicated Claude profile remain there.

The upstream clone and build live in .runtime/. Microsoft authentication uses the upstream project's normal per-user MSAL cache outside this repository. Sign in through the browser; account passwords and MFA seeds are not required by this setup.

Neither directory belongs in a commit or a shared archive. Do not attach login caches, raw session transcripts, or private MCP configuration to issues. Use redacted reproductions.

The adapter logs model and tool metadata, without recording prompts or credentials. Those logs can still describe local activity and should remain private.

Private per-launch settings under .local/launch-settings/ include the gateway credential. They remain available for native background sessions. They preserve explicit user settings while pinning the connector environment, so project settings cannot silently select a different inference gateway.

The included agent prompt treats retrieved instructions as untrusted. Tool execution and permission decisions remain in Claude Code. The managed backend sets M365_FORCE_AGENT=0 and does not automatically provision Copilot Studio bots.
