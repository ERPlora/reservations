#!/usr/bin/env python3
"""`reservations.slots.count_for` — capacity per slot, against a REAL Postgres (reservations#4).

The anti-overbooking gate lives inline in `_create_gated` / `_waitlist_promote` (atomic COUNT
inside the INSERT). What was missing is the READ side: the availability screen had no way to show
how full a slot is without trying to create a reservation. This query is that read, and the
important property is that it counts EXACTLY what the gate counts — same "live" rule
(`is_deleted = 0 AND status NOT IN ('cancelled','no_show')`), same slot membership
(`time >= start_time AND time < end_time`), same day-of-week mapping (`erp_dow_mon0`).

Contract:
  - `{date}` → one row per ACTIVE slot of that weekday: `timeslot_id, start_time, end_time,
    max_reservations, reserved, available` (`available = max - reserved`, never below 0).
  - `{date, time}` → only the slot(s) containing that time.
  - cancelled / no_show / soft-deleted reservations do not count; other days do not count.
  - declared with `reservations.view_reservation`.

Runs the SQL the way the runtime does (`:name` bound, `erp_*` bridge functions rewritten as
`hub/crates/db/src/lib.rs` does). Uses the `erplora-test-pg-5433` container (override:
ERPLORA_TEST_PG_CONTAINER); scratch DB dropped at the end. Missing Docker = SKIPPED, never PASS.
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
QUERY = "reservations.slots.count_for"
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
    # 2026-08-20 is a Thursday → day_of_week 3 (0 = Monday). Two slots that day, one on Friday.
    rows = [
        ("s-lunch", 3, "13:00:00", "15:00:00", 3),
        ("s-dinner", 3, "20:00:00", "23:00:00", 2),
        ("s-friday", 4, "20:00:00", "23:00:00", 5),
    ]
    for sid, dow, st, en, mx in rows:
        psql(
            db,
            f"INSERT INTO reservations_timeslot (id, hub_id, day_of_week, start_time, end_time, "
            f"max_reservations, is_active, is_deleted, created_at) VALUES "
            f"('{sid}', '{HUB}', {dow}, '{st}', '{en}', {mx}, 1, 0, '2026-08-01T00:00:00+00:00')",
        )
    psql(
        db,
        f"INSERT INTO reservations_timeslot (id, hub_id, day_of_week, start_time, end_time, "
        f"max_reservations, is_active, is_deleted, created_at) VALUES "
        f"('s-off', '{HUB}', 3, '17:00:00', '19:00:00', 9, 0, 0, '2026-08-01T00:00:00+00:00')",
    )
    res = [
        ("r1", "2026-08-20", "13:30:00", "confirmed", 0),
        ("r2", "2026-08-20", "14:00:00", "pending", 0),
        ("r3", "2026-08-20", "14:30:00", "cancelled", 0),  # does not count
        ("r4", "2026-08-20", "13:15:00", "no_show", 0),  # does not count
        ("r5", "2026-08-20", "13:45:00", "seated", 1),  # soft-deleted: does not count
        ("r6", "2026-08-20", "21:00:00", "confirmed", 0),
        ("r7", "2026-08-20", "22:00:00", "confirmed", 0),  # dinner FULL (max 2)
        ("r8", "2026-08-21", "21:00:00", "confirmed", 0),  # other day
        ("r9", "2026-08-20", "21:30:00", "confirmed", 0),  # other hub
    ]
    for rid, d, t, st, deleted in res:
        hub = "hub-other" if rid == "r9" else HUB
        psql(
            db,
            f"INSERT INTO reservations_reservation (id, hub_id, guest_name, guest_phone, guest_email, "
            f"date, time, party_size, duration_minutes, status, notes, internal_notes, is_deleted, created_at) "
            f"VALUES ('{rid}', '{hub}', 'G', '', '', '{d}', '{t}', 2, 90, '{st}', '', '', {deleted}, "
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

    db = f"reservations_count_for_{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True
    )
    try:
        # A declared migration is a path OR the `{file, kind, since}` form
        # (`MigrationEntry`, hub#542), the only way to declare a `contract`. 004 uses it.
        for rel in [e if isinstance(e, str) else e["file"] for e in MANIFEST["migrations"]["postgres"]]:
            psql(db, (MODULE_DIR / rel).read_text())
        seed(db)

        print("\n== the day: one row per active slot, live reservations only ==")
        rows = {r["timeslot_id"]: r for r in run_query(db, {"date": "2026-08-20"})}
        check(
            "two active slots on Thursday (the inactive one is out)",
            ["s-dinner", "s-lunch"],
            sorted(rows),
        )
        lunch, dinner = rows.get("s-lunch", {}), rows.get("s-dinner", {})
        check("lunch counts confirmed + pending only", 2, lunch.get("reserved"))
        check("lunch has one seat left", 1, lunch.get("available"))
        check("lunch carries the window", "13:00:00", lunch.get("start_time"))
        check("lunch carries the max", 3, lunch.get("max_reservations"))
        check("dinner counts only this hub and this day", 2, dinner.get("reserved"))
        check("dinner is full", 0, dinner.get("available"))

        print("\n== the slot: `time` narrows to the slot that contains it ==")
        rows = run_query(db, {"date": "2026-08-20", "time": "21:30:00"})
        check("one slot contains 21:30", ["s-dinner"], [r["timeslot_id"] for r in rows])
        rows = run_query(db, {"date": "2026-08-20", "time": "23:00:00"})
        check(
            "end_time is exclusive, like the gate", [], [r["timeslot_id"] for r in rows]
        )

        print("\n== another day, another slot set ==")
        rows = run_query(db, {"date": "2026-08-21"})
        check("Friday has its own slot", ["s-friday"], [r["timeslot_id"] for r in rows])
        check(
            "Friday's slot counts Friday's reservation",
            1,
            rows[0]["reserved"] if rows else None,
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
    print(f"PASS — {QUERY} counts what the gate counts (reservations#4)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
