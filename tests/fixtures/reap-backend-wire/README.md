# Reap backend wire fixtures

Real HTTP response bodies from pivota-backend's `/agent/v2/commerce/reap` routes, captured by
`capture_reap_backend_wire.py` (in this directory) running over the backend's own app: its routes, its
`ErrorHandlerMiddleware` and its SQLite self-heal, through the fixtures of the backend's route tests.
None is hand-written. `tests/reap_backend_wire.node.test.cjs` runs every file here through the gateway.

- Backend commit: `0f57dfafc` (pivota-backend #2525, the commit live in prod since 2026-10-07 09:21Z).
- Captured: 2026-10-07.
- Buyer data: the backend test fixture's (`ada@example.test`). No file carries it: the owner views are redacted.

Not covered: the capture runs on SQLite, so timestamps carry no microseconds (prod Postgres views do), and no
fixture carries `hosted_url`, `approval_deadline`, quoted totals or an order (those need a provider; the lane tests
cover them from the contract's examples).

Each file is `{"status": <http status>, "body": <response JSON>}`. Ids, request ids and timestamps vary per
capture; the test reads them from the file and never pins them.

To re-capture after a backend contract change (from a pivota-backend checkout with its test environment):

```bash
cp <gateway>/tests/fixtures/reap-backend-wire/capture_reap_backend_wire.py tests/_capture_reap_backend_wire.py
REAP_WIRE_OUT=<gateway>/tests/fixtures/reap-backend-wire PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider -q tests/_capture_reap_backend_wire.py
rm tests/_capture_reap_backend_wire.py
```

Then update the commit above. A new file needs a test: the wire test fails on any fixture it does not read.
