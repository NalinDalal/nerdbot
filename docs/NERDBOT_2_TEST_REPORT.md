# Nerdbot 2.0 Test Report

## Baseline (2026-04-10)

- Command: `.venv/bin/python -m pytest -q`
- Result: **43 passed, 1 warning**
- Warning: `StarletteDeprecationWarning` from `fastapi.testclient` httpx integration.
- Environment: Python 3.12.15 venv at repo `.venv`.

## Stage 0 checks

- [x] Backend pytest baseline
- [ ] Dashboard `tsc --noEmit`
- [ ] Dashboard `npm run build`
- [ ] Added autonomy policy unit tests
- [ ] Added runtime recovery/idempotency tests
- [ ] Added security regression tests
- [ ] Critical failure scenarios 1-12

## Added/updated tests

(To be updated as implementation proceeds.)

## Failures / regressions

None at baseline. Any new failures will be recorded here with root cause and fix.
