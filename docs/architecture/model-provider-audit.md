# Model Provider Audit

## Existing implementation

- Provider kinds: local, mock, openai-compatible.
- Encrypted API keys at rest (Fernet).
- Per-teammate provider_id.
- Capability-ish handling: tool loop, retries, timeouts, rate limits.
- Streaming? Need inspect; likely chat streaming separate.
- Groq-specific tool call rejection handling.

## Missing

- Explicit capability metadata.
- Ollama native API.
- Per-teammate model/generation settings beyond provider config.
- Provider health checks endpoint.
- Routing/fallback layer.
- Context limit validation.

## Recommendation

Add provider capability metadata, health checks, routing layer, optional Ollama adapter, per-teammate settings via config/migration. Preserve existing adapters.
