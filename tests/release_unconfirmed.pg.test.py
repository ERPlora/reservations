#!/usr/bin/env python3
"""Scheduled task `release_unconfirmed` — against a REAL Postgres (reservations#5).

A `pending` reservation is a promise nobody kept: the guest never confirmed and, once its time has
come and gone, never showed up either. Until something releases it, it keeps COUNTING against the
slot's `max_reservations` (the slot is a window — a stale 20:00 pending blocks a 22:30 booking in
the same 20:00–23:00 slot) and clutters the pending list. This is the same job
`tables.tables.expire_holds` does for holds: a sweep, idempotent, run every 15 minutes.

Rule (uses the setting that already means "grace after the time"): a `pending` reservation whose
start (`date` + `time`) is more than `settings.no_show_window_minutes` (default 15) in the past is
released → `cancelled`, `cancellation_reason = 'unconfirmed'`, `cancelled_at = :now`. Nothing else
is touched: pending inside the grace window, pending in the future, confirmed/seated/… of any age,
other hubs.

Runs the SQL the way the runtime does (`:name` bound, `erp_*` rewritten like
`hub/crates/db/src/lib.rs`). Uses `erplora-test-pg-5433` (override: ERPLORA_TEST_PG_CONTAINER);
scratch DB dropped at the end. Missing Docker = SKIPPED, never PASS.
"""

import json
import os
import pathlib
import re
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("ERPLORA_TEST_PG_CONTAINER", "erplora-test-pg-5433")
TASK = "release_unconfirmed"
HUB = "hub-test"
NOW = "2026-08-20T21:00:00+00:00"

failures: list[str] = []


def check(label, expected, actual):
    if expected != actual:
        failures.append(f"{label} — expected [{expected}], got [{actual}]")
        print(f"  FAIL: {label} — expected [{expected}], got [{actual}]")
    else:
        print(f"  ok: {label} = {expected}")


def psql(db, sql):
    r = subprocess.run(
        [
            "docker",
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-U",
            "postgres",
            "-d",
            db,
            "-v",
            "ON_ERROR_STOP=1",
            "-q",
            "-X",
            "-tA",
        ],
        input=sql,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout


def literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


PARAM = re.compile(r"(?<!:):([a-z_][a-z0-9_]*)")  # `::` is a cast, never a bind


def bridge(sql: str) -> str:
    """Bridge functions rewritten like the runtime does (`hub/crates/db/src/lib.rs`)."""
    sql = re.sub(
        r"erp_dow_mon0\(([^()]*)\)",
        r"((EXTRACT(ISODOW FROM (\1)::timestamptz)::int) - 1)",
        sql,
    )
    sql = re.sub(
        r"erp_datediff_days\(([^(),]*(?:\([^()]*\))?[^(),]*),([^()]*)\)",
        r"(EXTRACT(EPOCH FROM ((\1)::timestamptz - (\2)::timestamptz)) / 86400.0)",
        sql,
    )
    return sql


def run_command(db, name: str, payload: dict, now: str):
    cmd = MANIFEST["commands"].get(name)
    if cmd is None:
        raise RuntimeError(f"command `{name}` is not declared")
    params = dict(payload)
    params.setdefault("hub_id", HUB)
    params.setdefault("current_user_id", "")
    params.setdefault("now", now)
    script = ["BEGIN;"]
    for rel in cmd["sql"]:
        p = dict(params)
        p["new_id"] = str(uuid.uuid4())
        script.append(
            PARAM.sub(
                lambda m: literal(p.get(m.group(1))),
                bridge((MODULE_DIR / rel).read_text()),
            )
        )
    script.append("COMMIT;")
    psql(db, "\n".join(script))


def row(db, rid: str) -> dict:
    out = psql(
        db,
        f"SELECT row_to_json(r) FROM (SELECT status, cancellation_reason, cancelled_at, "
        f"updated_at FROM reservations_reservation WHERE id = '{rid}') r;",
    )
    return json.loads(out.strip()) if out.strip() else {}


def seed(db):
    psql(
        db,
        f"INSERT INTO reservations_settings (id, hub_id, no_show_window_minutes, is_deleted, created_at) "
        f"VALUES ('st', '{HUB}', 30, 0, '2026-08-01T00:00:00+00:00')",
    )
    # NOW = 2026-08-20 21:00. Grace on this hub = 30 min; on `hub-default` (no settings row) = 15.
    res = [
        ("p-stale", HUB, "2026-08-20", "20:00:00", "pending"),  # 60 min late → released
        ("p-edge", HUB, "2026-08-20", "20:29:00", "pending"),  # 31 min late → released
        (
            "p-grace",
            HUB,
            "2026-08-20",
            "20:45:00",
            "pending",
        ),  # 15 min late, inside 30 → kept
        ("p-future", HUB, "2026-08-20", "22:00:00", "pending"),  # not yet → kept
        ("p-tomorrow", HUB, "2026-08-21", "20:00:00", "pending"),  # kept
        ("c-stale", HUB, "2026-08-20", "19:00:00", "confirmed"),  # not pending → kept
        ("s-stale", HUB, "2026-08-20", "19:00:00", "seated"),  # kept
        (
            "p-other",
            "hub-other",
            "2026-08-20",
            "18:00:00",
            "pending",
        ),  # other hub → kept
        (
            "p-def-late",
            "hub-default",
            "2026-08-20",
            "20:40:00",
            "pending",
        ),  # 20 min late, default 15 → released
        (
            "p-def-grace",
            "hub-default",
            "2026-08-20",
            "20:50:00",
            "pending",
        ),  # 10 min late → kept
    ]
    for rid, hub, d, t, st in res:
        psql(
            db,
            f"INSERT INTO reservations_reservation (id, hub_id, guest_name, guest_phone, guest_email, "
            f"date, time, party_size, duration_minutes, status, notes, internal_notes, is_deleted, created_at) "
            f"VALUES ('{rid}', '{hub}', 'G', '', '', '{d}', '{t}', 2, 90, '{st}', '', '', 0, "
            f"'2026-08-01T00:00:00+00:00')",
        )


def main() -> int:
    ready = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
        capture_output=True,
        text=True,
    )
    if ready.returncode != 0:
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    print("== the task is declared and wired to a command ==")
    task = next(
        (t for t in MANIFEST.get("scheduled_tasks", []) if t.get("name") == TASK), None
    )
    check(f"scheduled task `{TASK}` declared", True, task is not None)
    if task is None:
        return 1
    command = task["command"]
    check("its command exists", True, command in MANIFEST["commands"])
    check(
        "sweeps every 15 minutes, like tables.expire_holds",
        "*/15 * * * *",
        task.get("cron"),
    )
    check(
        "collapses the backlog after a shutdown",
        "collapse",
        task.get("catch_up", "collapse"),
    )
    check(
        "the release is announced (declared event, hub#240)",
        True,
        any(
            e in MANIFEST["events"]["emits"]
            for e in MANIFEST["commands"][command].get("emit", [])
        ),
    )

    db = f"reservations_release_{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True
    )
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            psql(db, (MODULE_DIR / rel).read_text())
        seed(db)

        print("\n== the sweep (this hub, grace 30 min) ==")
        run_command(db, command, {}, NOW)
        for rid in ("p-stale", "p-edge"):
            r = row(db, rid)
            check(f"{rid} is released", "cancelled", r.get("status"))
            check(f"{rid} says why", "unconfirmed", r.get("cancellation_reason"))
            check(
                f"{rid} stamps cancelled_at with the server clock",
                NOW,
                r.get("cancelled_at"),
            )
        for rid in ("p-grace", "p-future", "p-tomorrow"):
            check(f"{rid} stays pending", "pending", row(db, rid).get("status"))
        check(
            "a confirmed reservation is not the sweep's business",
            "confirmed",
            row(db, "c-stale").get("status"),
        )
        check("a seated one neither", "seated", row(db, "s-stale").get("status"))
        check("other hubs untouched", "pending", row(db, "p-other").get("status"))

        print("\n== a hub with no settings row falls back to 15 minutes ==")
        run_command(db, command, {"hub_id": "hub-default"}, NOW)
        check(
            "20 min late is released", "cancelled", row(db, "p-def-late").get("status")
        )
        check("10 min late is kept", "pending", row(db, "p-def-grace").get("status"))

        print("\n== idempotent: a second pass changes nothing ==")
        before = row(db, "p-stale")
        run_command(db, command, {}, "2026-08-20T21:16:00+00:00")
        check(
            "already-released rows keep their first cancelled_at",
            before.get("cancelled_at"),
            row(db, "p-stale").get("cancelled_at"),
        )
        check(
            "p-grace is released once its 30 min are over",
            "cancelled",
            row(db, "p-grace").get("status"),
        )
    finally:
        subprocess.run(
            ["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db]
        )

    print()
    if failures:
        print(f"FAILED — {len(failures)} assertion(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        f"PASS — {TASK} frees the slots that pending reservations were hoarding (reservations#5)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
