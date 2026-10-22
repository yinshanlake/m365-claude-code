# Attribution

The managed backend is [cramt/m365-copilot-proxy](https://github.com/cramt/m365-copilot-proxy), licensed under MIT. Setup downloads the revision pinned in upstream.json. The included session-isolation patch is applied to that checkout. Its license is reproduced in licenses/m365-copilot-proxy.txt.

The Anthropic compatibility design was informed by [Agent Maestro](https://github.com/Joouis/agent-maestro), particularly its Anthropic routes, content conversion, model catalog, and tool-result pairing. The reviewed revision was 99dca70b5574cb648ac808ad4be09c55bd1aae14. Its MIT license is reproduced in licenses/agent-maestro.txt.

The gateway uses the OpenAI SDK, tiktoken, Ajv, and ajv-formats. The Anthropic SDK is a test dependency. Their versions and licenses are defined by package.json and their respective packages.

Claude Code must be installed separately from its official distribution. This repository does not distribute Claude Code or Microsoft credentials and is an independent community integration.
