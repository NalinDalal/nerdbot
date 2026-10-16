# NerdBot Workspace

Persistent AI teammate workspace centered on three concepts:

- **Project**: repository, files, tools, shared knowledge
- **Teammate**: persistent identity, responsibilities, memory, permissions, available tools
- **Task**: owned unit of work with dependencies, execution history, and verifiable outcome

## Phase 1 status

One working project. One configured teammate. One task executed through one runtime adapter.
Unified authentication, permissions, and storage behavior for that slice.

## Development

```bash
# Backend
uv sync --group dev
uv run pytest          # run tests
uv run ruff check      # lint
uv run mypy            # typecheck

# Run the API server
uv run nerdbot run
```

## License provenance

Adopted patterns from Octop (MIT), Odysseus (AGPL concepts only), and AI Teammates
(reference-only). See `docs/provenance/PROVENANCE.md` and
`docs/provenance/THIRD_PARTY_NOTICES.md`.
