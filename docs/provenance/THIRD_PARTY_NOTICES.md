# Third-Party Notices

This product incorporates material from the following third-party sources. Each entry lists the source, license, and the notice required by that license.

## Octop (MIT License)

Source: `~/octop` (commit `ecec9f7017b42a5cbdd9fcfae7851effc387374c`)
License: MIT — see `~/octop/LICENSE`

Copyright (c) 2026 NerdBot

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

Adopted patterns (adapted, not copied verbatim unless noted):
- Persisted handoff chain in message metadata
- Tool guardrail rule semantics
- Cron tool-description grammar
- Citation-marker trick
- `thread_messages` display projection
- Login lockout parameters (5 tries / 900s)
- MCP config fingerprint caching + redaction

If any Octop file is copied verbatim, retain this MIT notice alongside the copied file.

## Odysseus (AGPL-3.0-or-later) — concepts only

Source: `~/odysseus` (commit `c3819e3cbf56c4f899eacc66b21115a77d9c570d`)
License: GNU AGPL v3 — see `~/odysseus/LICENSE`

**No implementation code from Odysseus has been copied, imported, or translated.** All Odysseus-inspired behavior (typed tool failures, untrusted-context framing, SSRF-guarded fetch, sealed approvals, fail-closed memory, compaction-at-85%) was re-implemented clean-room in TypeScript from behavioral description. No strings, constants, or data structures from `~/odysseus` appear in this repository.

See `docs/provenance/PROVENANCE.md` for the clean-room statement.

## AI Teammates (reference-only — no LICENSE present)

Source: `~/ai-teammates` (commit `6bea24c7a043dea100bed930f8bbc6da1e14e43a`)
License: None present in repository — default copyright applies.

**No code from AI Teammates has been imported.** Schema patterns (per-bot config, memory file, originator-anchored handoff, scrypt auth) were used as reference only and re-implemented natively.

## Bundled dependencies

Dependency licenses are inspected before reuse. Any dependency with a copyleft license (GPL, AGPL, LGPL) is flagged for legal review before inclusion. This notice is updated as dependencies are added.
