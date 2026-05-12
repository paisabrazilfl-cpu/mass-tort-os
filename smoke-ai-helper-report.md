# AI Helper smoke trace

Three scenarios exercised the /api/automations/assist path end-to-end with the LLM stubbed. Same recursiveRetry + graphSchema validation the live route uses (routes/automations.ts:245-313). The CRM editor's askAssistant() → applyAssistResult() chain is documented step by step so you can see exactly what would render on screen when a real LLM provider is configured.

**Run live:** set ANTHROPIC_API_KEY (or OPENAI_API_KEY, etc.) on the API server, mount /api/automations/assist, and the same path executes against the real provider. The stub is the only difference.
