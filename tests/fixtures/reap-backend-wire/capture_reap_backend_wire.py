"""Capture pivota-backend's Reap route responses, byte for byte, for the gateway's wire test.

NOT a gateway test. It runs INSIDE a pivota-backend checkout, over the backend's REAL app (its
routes, its ErrorHandlerMiddleware, its SQLite self-heal), through the fixtures of the backend's own
route tests. Every JSON file next to this script was written by it; none is hand-made.

    cp tests/fixtures/reap-backend-wire/capture_reap_backend_wire.py <backend>/tests/_capture_reap_backend_wire.py
    cd <backend> && REAP_WIRE_OUT=<gateway>/tests/fixtures/reap-backend-wire \
        PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider -q tests/_capture_reap_backend_wire.py
    rm <backend>/tests/_capture_reap_backend_wire.py

Then record the backend commit in README.md beside the fixtures.
"""
import json
import os
from pathlib import Path

from db.database import database
from db import reap_agentic_ledger as ledger
from test_agent_commerce_reap_routes import (  # noqa: F401  (autouse fixtures)
    _db, _env, _no_network, client, _body, _seed_all, _error,
    BASE, CALLER, OTHER_USER_REF,
)
from test_reap_contact_resume import _paused, _age_purge

OUT = Path(os.environ["REAP_WIRE_OUT"])
_DAY = 86400


def _save(name, response):
    OUT.mkdir(parents=True, exist_ok=True)
    record = {"status": response.status_code, "body": response.json()}
    (OUT / f"{name}.json").write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return record


async def test_create_fresh_and_price_changed(client):
    await _seed_all()
    assert _save("create_202_fresh", await client.post(BASE + "/purchases", json=_body()))["status"] == 202
    moved = _save("create_409_price_changed",
                  await client.post(BASE + "/purchases", json=_body(expected_unit_price_minor=4251)))
    assert moved["status"] == 409 and moved["body"]["detail"]["error"] == "price_changed"


async def test_create_503_outcome_unknown(client, monkeypatch):
    import routes.agent_commerce_reap as routes
    await _seed_all()

    async def unavailable_view(**kwargs):
        raise RuntimeError("owner read unavailable")

    monkeypatch.setattr(routes, "_owner_view", unavailable_view)
    out = _save("create_503_outcome_unknown", await client.post(BASE + "/purchases", json=_body()))
    assert out["status"] == 503


async def test_paused_get_recover_resume(client):
    pid, body = await _paused(client)
    assert _save("get_200_contact_paused", await client.get(BASE + f"/purchases/{pid}"))["body"]["contact_reentry_required"] is True
    assert _save("recover_200_contact_paused", await client.post(BASE + "/purchases/recover", json=body))["status"] == 200
    assert _save("resume_200", await client.post(BASE + f"/purchases/{pid}/resume", json=body))["status"] == 200


async def test_paused_replay_with_a_dispatch_started(client):
    pid, body = await _paused(client)
    await database.execute("UPDATE reap_agentic_purchases SET checkout_dispatch_key='k-started' WHERE id=:id", {"id": pid})
    out = _save("create_202_replay_dispatch_started", await client.post(BASE + "/purchases", json=body))
    assert out["body"]["checkout_dispatch_state"] == "dispatch_started"
    out = _save("resume_409_checkout_dispatch_unresolved", await client.post(BASE + f"/purchases/{pid}/resume", json=body))
    assert out["body"]["detail"]["error"] == "checkout_dispatch_unresolved"


async def test_resume_raced(client):
    pid, body = await _paused(client)
    await database.execute("UPDATE reap_agentic_purchases SET claimed_by='poller' WHERE id=:id", {"id": pid})
    out = _save("resume_409_resume_raced", await client.post(BASE + f"/purchases/{pid}/resume", json=body))
    assert out["body"]["detail"]["error"] == "resume_raced"


async def test_resume_owner_miss(client):
    pid, body = await _paused(client)
    CALLER.agent_user_ref = OTHER_USER_REF
    out = _save("resume_404_purchase_not_found", await client.post(BASE + f"/purchases/{pid}/resume", json=body))
    assert out["body"]["detail"]["error"] == "purchase_not_found"


async def test_resume_while_create_paused(client, monkeypatch):
    pid, body = await _paused(client)
    monkeypatch.setenv("REAP_AGENTIC_CREATE_ENABLED", "0")
    out = _save("resume_404_not_available_on_this_rail", await client.post(BASE + f"/purchases/{pid}/resume", json=body))
    assert out["body"]["detail"]["error"] == "not_available_on_this_rail"


async def test_lapsed_views_and_resume(client):
    pid, body = await _paused(client)
    await _age_purge(pid, _DAY + 60)
    assert await ledger.lapse_contact_reentry(window_seconds=_DAY) == [pid]
    out = _save("get_200_lapsed_failed", await client.get(BASE + f"/purchases/{pid}"))
    assert out["body"]["state"] == "failed" and out["body"]["last_error_code"] == "contact_reentry_lapsed"
    out = _save("resume_409_terminal_purchase_not_resumable", await client.post(BASE + f"/purchases/{pid}/resume", json=body))
    assert out["body"]["detail"]["error"] == "terminal_purchase_not_resumable"


async def test_lapsed_needs_enrollment_expires(client):
    pid, _ = await _paused(client)
    await database.execute("UPDATE reap_agentic_purchases SET state='needs_enrollment' WHERE id=:id", {"id": pid})
    await _age_purge(pid, _DAY + 60)
    assert await ledger.lapse_contact_reentry(window_seconds=_DAY) == [pid]
    out = _save("get_200_lapsed_expired", await client.get(BASE + f"/purchases/{pid}"))
    assert out["body"]["state"] == "expired" and out["body"]["last_error_code"] == "contact_reentry_lapsed"
