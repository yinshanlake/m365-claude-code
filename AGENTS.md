# Repository instructions

- Read AGENT_README.md for installation and validation. README.md describes the supported behavior and limitations.
- Keep model selection, tool execution, MCP configuration, and permissions in the native client whenever possible. This repository owns protocol conversion and local process setup.
- Never commit .local/, .runtime/, node_modules/, credentials, login caches, session transcripts, or personal MCP configurations.
- Keep the gateway and managed upstream on loopback. Preserve explicit model routing, error propagation, cancellation, and per-client session isolation.
- Run npm test and npm run test:launcher after relevant code changes. Run npm run audit:public before publishing. Do not claim live tool support based only on a successful chat response.
