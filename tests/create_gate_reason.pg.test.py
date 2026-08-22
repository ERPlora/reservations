#!/usr/bin/env python3
"""The gate's abort row says WHY (reservations#31), against a REAL Postgres.

Until this fix, every rejection of `reservations.reservations.create` surfaced as the SAME raw
`CHECK constraint failed: reservations__gate` — a full slot, a day without service and an
oversized party were indistinguishable. Two halves fix it:

  1. the WASM handler pre-checks from its pre-loaded reads and refuses with a translated domain
     code (tested in `handler/src/lib.rs`);
  2. the abort row itself carries a `reason` (migration 003), written by
     `commands/_create_gated_assert.sql` evaluating the gate's own conditions INSIDE the
     transaction — so the rejection the race guard sees is diagnosable too.

This file tests half 2 end to end: it runs `_create_gated_insert.sql` + the assert of
`_create_gated_assert.sql` the way the runtime does (named binds lowered to literals, `erp_*`
bridges rewritten like `hub/crates/db/src/lib.rs`), and asserts the (ok, reason) pair for each
scenario — including the OK path (reason stays empty) and the migration's reversibility
(`DROP COLUMN reason`).

Uses the `erplora-test-pg-5433` container (override: ERPLORA_TEST_PG_CONTAINER); scratch DB
dropped at the end. Missing Docker = SKIPPED, never PASS.
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
HUB = "hub-test"
NOW = "2026-08-18T12:00:00+00:00"  # fixed clock: the window cases must not depend on the real one

failures: list[str] = []


def check(label, expected, actual):
    if expected != actual:
        failures.append(f"{label} — expected [{expected}], got [{actual}]")
        print(f"  FAIL: {label} — expected [{expected}], got [{actual}]")
    else:
        print(f"  ok: {label} = {expected}")


def psql(db, sql):
    r = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db,
         "-v", "ON_ERROR_STOP=1", "-q", "-X", "-tA"],
        input=sql, capture_output=True, text=True,
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
    """The bridge functions these statements use, rewritten like the runtime does."""
    sql = re.sub(
        r"erp_dow_mon0\(([^()]*)\)",
        r"((EXTRACT(ISODOW FROM (\1)::timestamptz)::int) - 1)",
        sql,
    )
    sql = re.sub(
        r"erp_datediff_days\(([^()]*)\s*,\s*([^()]*)\)",
        r"(EXTRACT(EPOCH FROM ((\1)::timestamptz - (\2)::timestamptz)) / 86400.0)",
        sql,
    )
    return sql


def bind(sql: str, params: dict) -> str:
    p = {"hub_id": HUB, "current_user_id": "u-test", "now": NOW, **params}
    return PARAM.sub(lambda m: literal(p.get(m.group(1))), bridge(sql))


def gated(db, params: dict):
    """Run the command's two statements and return the assert's (ok, reason) pair.

    The INSERT is the real `_create_gated_insert.sql`; the assert runs as the SELECT it wraps
    (its INSERT…SELECT form aborts on CHECK, which is the point — here we need to READ the pair).
    """
    insert_sql = (MODULE_DIR / "commands/_create_gated_insert.sql").read_text().strip().rstrip(";")
    psql(db, bind(insert_sql, params) + ";")
    assert_sql = (MODULE_DIR / "commands/_create_gated_assert.sql").read_text()
    select = assert_sql.split("INSERT INTO reservations__gate (gate, ok, reason)", 1)[1]
    select = select.strip().rstrip(";")
    out = psql(db, bind(select, params) + ";")
    parts = out.strip().split("|")
    return int(parts[1]), parts[2]


def seed(db):
    # 2026-08-20 is a Thursday → day_of_week 3 (0 = Monday). Dinner slot with room for 2.
    # 2026-08-18 (Tuesday → 1) has a lunch slot, used by the too-soon case.
    rows = [
        ("s-dinner", 3, "20:00:00", "23:00:00", 2),
        ("s-lunch-tue", 1, "12:00:00", "14:00:00", 2),
    ]
    for sid, dow, st, en, mx in rows:
        psql(
            db,
            f"INSERT INTO reservations_timeslot (id, hub_id, day_of_week, start_time, end_time, "
            f"max_reservations, is_active, is_deleted, created_at) VALUES "
            f"('{sid}', '{HUB}', {dow}, '{st}', '{en}', {mx}, 1, 0, '2026-08-01T00:00:00+00:00')",
        )
    # One live reservation already in the dinner slot of 2026-08-20 → room for exactly one more.
    psql(
        db,
        f"INSERT INTO reservations_reservation (id, hub_id, guest_name, guest_phone, guest_email, "
        f"date, time, party_size, duration_minutes, status, notes, internal_notes, is_deleted, created_at) "
        f"VALUES ('r-live', '{HUB}', 'G', '', '', '2026-08-20', '21:00:00', 2, 90, 'confirmed', '', '', 0, "
        f"'2026-08-01T00:00:00+00:00')",
    )
    # A full-day block on 2026-08-27 (also a Thursday).
    psql(
        db,
        f"INSERT INTO reservations_blockeddate (id, hub_id, date, reason, is_full_day, is_deleted, created_at) "
        f"VALUES ('b-holiday', '{HUB}', '2026-08-27', 'staff party', 1, 0, '2026-08-01T00:00:00+00:00')",
    )


def params(**over):
    base = {
        "reservation_id": "r-new",
        "customer_id": None,
        "guest_name": "Ana",
        "guest_phone": "",
        "guest_email": "",
        "date": "2026-08-20",
        "time": "21:00:00",
        "party_size": 4,
        "duration_minutes": None,
        "table_id": None,
        "notes": "",
        "internal_notes": "",
    }
    base.update(over)
    return base


def main() -> int:
    ready = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
        capture_output=True, text=True,
    )
    if ready.returncode != 0:
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    migrations = MANIFEST["migrations"]["postgres"]
    check(
        "migration 003 is declared (append-only: 001+002 untouched)",
        ["migrations/postgres/001_init.sql", "migrations/postgres/002_gate.sql", "migrations/postgres/003_gate_reason.sql"],
        migrations,
    )

    db = f"reservations_gate_reason_{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True)
    try:
        for rel in migrations:
            psql(db, (MODULE_DIR / rel).read_text())
        seed(db)

        print("\n== the abort row names its reason (reservations#31) ==")
        ok, reason = gated(db, params())
        check("healthy create: gate ok, empty reason", (1, ""), (ok, reason))

        ok, reason = gated(db, params(party_size=40, reservation_id="r-party"))
        check("oversized party", (0, "party_size_exceeded"), (ok, reason))

        ok, reason = gated(db, params(date="2026-08-27", reservation_id="r-blocked"))
        check("blocked date", (0, "date_blocked"), (ok, reason))

        ok, reason = gated(db, params(date="2026-08-18", time="12:30:00", reservation_id="r-soon"))
        check(
            "inside the advance window is refused too (handler cannot name it; the row can)",
            (0, "outside_advance_window"),
            (ok, reason),
        )

        ok, reason = gated(db, params(date="2026-08-22", reservation_id="r-noslot"))
        check("saturday, no slot that day", (0, "no_service_day"), (ok, reason))

        ok, reason = gated(db, params(time="18:00:00", reservation_id="r-gap"))
        check("thursday, but 18:00 is between the slots", (0, "no_service_day"), (ok, reason))

        ok, reason = gated(db, params(party_size=2, reservation_id="r-full"))
        check(
            "dinner slot already holds its 2 (r-live + the first healthy create)",
            (0, "no_capacity"),
            (ok, reason),
        )

        print("\n== the reason column is an expansion, reversible ==")
        cols = psql(db, "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name = 'reservations__gate' ORDER BY ordinal_position;").split()
        check("gate columns after 003", ["gate", "ok", "reason"], cols)
        psql(db, "ALTER TABLE reservations__gate DROP COLUMN reason;")
        cols = psql(db, "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name = 'reservations__gate' ORDER BY ordinal_position;").split()
        check("reverted", ["gate", "ok"], cols)

        print("\n== inserts that predate the column still parse (the other asserts) ==")
        psql(db, "ALTER TABLE reservations__gate ADD COLUMN reason TEXT NOT NULL DEFAULT '';")
        psql(db, "INSERT INTO reservations__gate (gate, ok) VALUES ('status_transition_valid', 1);")
        check(
            "column-less insert gets the default",
            "",
            psql(db, "SELECT reason FROM reservations__gate "
                     "WHERE gate = 'status_transition_valid';").strip(),
        )
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db])

    print()
    if failures:
        print(f"FAILED — {len(failures)} assertion(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — the gate names its reason (reservations#31)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
