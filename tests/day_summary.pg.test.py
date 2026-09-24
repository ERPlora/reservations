#!/usr/bin/env python3
"""`reservations.day.summary` — the figures of one service day, against a REAL Postgres (reservations#45).

The manager opens Reservas to know how tonight looks: how many COVERS (guests, not bookings) are
committed. `slots.count_for` counts bookings per slot — the gate's unit — so it cannot answer that;
this query adds the party sizes of the day.

Contract:
  - `{date}` → exactly ONE row: `reservations` (live bookings) and `covers` (sum of their
    `party_size`), both integers — 0 and 0 on a day with nothing, never an empty result.
  - "live" is the gate's rule: not cancelled / no_show, not soft-deleted. Other days and other
    hubs do not count.
  - seated and completed DO count: those guests are part of the day's service.
  - declared with `reservations.view_reservation`, a plain query (not a paginated list).

Runs the SQL the way the runtime does (`:name` bound). Uses the `erplora-test-pg-5433` container
(override: ERPLORA_TEST_PG_CONTAINER); scratch DB dropped at the end. Missing Docker = SKIPPED.
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
QUERY = "reservations.day.summary"
HUB = "hub-test"

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
    """The two bridge functions this module uses, rewritten like the runtime does."""
    sql = re.sub(
        r"erp_dow_mon0\(([^()]*)\)",
        r"((EXTRACT(ISODOW FROM (\1)::timestamptz)::int) - 1)",
        sql,
    )
    return sql


def run_query(db, params: dict) -> list[dict]:
    qdef = MANIFEST["queries"].get(QUERY)
    if qdef is None:
        return None
    sql = (MODULE_DIR / qdef["sql"]).read_text().strip().rstrip(";")
    p = dict(params)
    p.setdefault("hub_id", HUB)
    sql = PARAM.sub(lambda m: literal(p.get(m.group(1))), bridge(sql))
    out = psql(db, f"SELECT row_to_json(r) FROM ({sql}) r;")
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def seed(db):
    res = [
        # id, date, time, party, status, deleted, hub
        ("r1", "2026-08-20", "13:30:00", 2, "confirmed", 0, HUB),
        ("r2", "2026-08-20", "14:00:00", 4, "pending", 0, HUB),
        ("r3", "2026-08-20", "21:00:00", 6, "seated", 0, HUB),
        ("r4", "2026-08-20", "13:00:00", 3, "completed", 0, HUB),
        ("r5", "2026-08-20", "14:30:00", 8, "cancelled", 0, HUB),  # does not count
        ("r6", "2026-08-20", "13:15:00", 5, "no_show", 0, HUB),  # does not count
        ("r7", "2026-08-20", "13:45:00", 7, "confirmed", 1, HUB),  # soft-deleted
        ("r8", "2026-08-21", "21:00:00", 9, "confirmed", 0, HUB),  # other day
        ("r9", "2026-08-20", "21:30:00", 10, "confirmed", 0, "hub-other"),  # other hub
    ]
    for rid, d, t, party, st, deleted, hub in res:
        psql(
            db,
            f"INSERT INTO reservations_reservation (id, hub_id, guest_name, guest_phone, guest_email, "
            f"date, time, party_size, duration_minutes, status, notes, internal_notes, is_deleted, created_at) "
            f"VALUES ('{rid}', '{hub}', 'G', '', '', '{d}', '{t}', {party}, 90, '{st}', '', '', {deleted}, "
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

    qdef = MANIFEST["queries"].get(QUERY)
    check(f"{QUERY} is declared", True, qdef is not None)
    if qdef is None:
        return 1
    check("permission", "reservations.view_reservation", qdef.get("permission"))
    check("it is a plain query, not a paginated list", None, qdef.get("list"))

    db = f"reservations_day_summary_{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True
    )
    try:
        for rel in [e if isinstance(e, str) else e["file"] for e in MANIFEST["migrations"]["postgres"]]:
            psql(db, (MODULE_DIR / rel).read_text())
        seed(db)

        print("\n== the day: live bookings of this hub, covers = sum of party sizes ==")
        rows = run_query(db, {"date": "2026-08-20"})
        check("exactly one row", 1, len(rows))
        day = rows[0] if rows else {}
        check("live bookings (confirmed, pending, seated, completed)", 4, day.get("reservations"))
        check("covers = 2 + 4 + 6 + 3", 15, day.get("covers"))

        print("\n== another day ==")
        rows = run_query(db, {"date": "2026-08-21"})
        check("the next day has its own figures", [{"reservations": 1, "covers": 9}], rows)

        print("\n== a day with nothing is zero, not an empty answer ==")
        rows = run_query(db, {"date": "2026-08-22"})
        check("zero bookings, zero covers", [{"reservations": 0, "covers": 0}], rows)
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
    print(f"PASS — {QUERY} answers the covers of the day (reservations#45)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
