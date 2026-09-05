#!/usr/bin/env python3
"""The waitlist promotion stores the time NORMALIZED (reservations#34), against a REAL Postgres.

`reservations.waitlist.create` accepts `HH:MM` (its schema says so, and the API is free to send
it — only the UI form normalizes). The promotion copied `w.preferred_time` VERBATIM into
`reservations_reservation.time`, where every comparison is lexicographic and expects `HH:MM:SS`:
the row kept «21:00» while a plain create stored «21:00:00». Worse than cosmetics — a slot that
STARTS at 21:00:00 never matched (`'21:00' >= '21:00:00'` is false in text), so promoting into
it silently failed the gate.

The fix normalizes ONCE in `_waitlist_promote_insert.sql` (a derived table over the waitlist
row), so the inserted value, the blocked-date window and the slot membership all see the same
`HH:MM:SS` the create path stores.

Contract verified here, running the three statements of `reservations._waitlist_promote` the
way the runtime does (named binds lowered, `erp_*` bridges rewritten):
  - promoting an entry whose `preferred_time` is `21:00` creates the reservation with
    `time = '21:00:00'`;
  - the slot whose start is EXACTLY 21:00:00 matches (the edge that used to fall through);
  - the entry ends converted and linked (the assert's (ok) pair);
  - a full slot still aborts the promotion (normalization did not soften the gate).

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
CONTAINER = os.environ.get("ERPLORA_TEST_PG_CONTAINER", "erplora-test-pg-5433")
HUB = "hub-test"
NOW = "2026-08-18T12:00:00+00:00"

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
    sql = re.sub(
        r"erp_dow_mon0\(([^()]*)\)",
        r"((EXTRACT(ISODOW FROM (\1)::timestamptz)::int) - 1)",
        sql,
    )
    return sql


def bind(sql: str, params: dict) -> str:
    p = {"hub_id": HUB, "current_user_id": "u-test", "now": NOW, **params}
    return PARAM.sub(lambda m: literal(p.get(m.group(1))), bridge(sql))


def promote(db, entry_id: str, reservation_id: str):
    """Run the command's three statements; return the assert's ok (1 row = promoted)."""
    for f, extra in (
        ("commands/_waitlist_promote_insert.sql", {"reservation_id": reservation_id, "entry_id": entry_id}),
        ("commands/_waitlist_promote_link.sql", {"reservation_id": reservation_id, "entry_id": entry_id,
                                                 "is_contacted": None, "notes": None}),
    ):
        sql = (MODULE_DIR / f).read_text().strip().rstrip(";")
        psql(db, bind(sql, extra) + ";")
    assert_sql = (MODULE_DIR / "commands/_waitlist_promote_assert.sql").read_text()
    select = assert_sql.split("INSERT INTO reservations__gate (gate, ok)", 1)[1].strip().rstrip(";")
    out = psql(db, bind(select, {"reservation_id": reservation_id, "entry_id": entry_id}) + ";")
    return int(out.strip().split("|")[1])


def seed(db, slot_max: int):
    # 2026-08-20 is a Thursday → day_of_week 3. Slot STARTS exactly at 21:00:00: with the raw
    # '21:00' the lexicographic membership ('21:00' >= '21:00:00') is FALSE — the edge of #34.
    psql(
        db,
        f"INSERT INTO reservations_timeslot (id, hub_id, day_of_week, start_time, end_time, "
        f"max_reservations, is_active, is_deleted, created_at) VALUES "
        f"('s-nine', '{HUB}', 3, '21:00:00', '23:00:00', {slot_max}, 1, 0, '2026-08-01T00:00:00+00:00')",
    )
    # Waitlist entry with the API-legal HH:MM shape the UI never sends.
    psql(
        db,
        f"INSERT INTO reservations_waitlistentry (id, hub_id, guest_name, guest_phone, guest_email, "
        f"date, preferred_time, party_size, notes, is_contacted, is_converted, is_deleted, created_at) "
        f"VALUES ('w-ana', '{HUB}', 'Ana', '600', '', '2026-08-20', '21:00', 2, '', 0, 0, 0, "
        f"'2026-08-01T00:00:00+00:00')",
    )


def main() -> int:
    ready = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
        capture_output=True, text=True,
    )
    if ready.returncode != 0:
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    manifest = json.loads((MODULE_DIR / "module.json").read_text())
    db = f"reservations_waitlist_promote_{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True)
    try:
        # A declared migration is a path OR the `{file, kind, since}` form
        # (`MigrationEntry`, hub#542), the only way to declare a `contract`. 004 uses it.
        for rel in [e if isinstance(e, str) else e["file"] for e in manifest["migrations"]["postgres"]]:
            psql(db, (MODULE_DIR / rel).read_text())
        seed(db, slot_max=2)

        print("\n== promoting an entry with preferred_time '21:00' (reservations#34) ==")
        ok = promote(db, "w-ana", "r-promo")
        check("the promotion went through (slot starting at 21:00:00 matches)", 1, ok)
        row = psql(
            db,
            "SELECT time FROM reservations_reservation WHERE id = 'r-promo' AND hub_id = 'hub-test';",
        ).strip()
        check("the reservation stores HH:MM:SS, like a plain create does", "21:00:00", row)
        linked = psql(
            db,
            "SELECT is_converted || '|' || reservation_id FROM reservations_waitlistentry "
            "WHERE id = 'w-ana';",
        ).strip()
        check("the entry is converted and linked", "1|r-promo", linked)

        print("\n== the gate did not get softer ==")
        psql(
            db,
            f"INSERT INTO reservations_waitlistentry (id, hub_id, guest_name, guest_phone, guest_email, "
            f"date, preferred_time, party_size, notes, is_contacted, is_converted, is_deleted, created_at) "
            f"VALUES ('w-full', '{HUB}', 'Berto', '', '', '2026-08-20', '22:00:00', 2, '', 0, 0, 0, "
            f"'2026-08-01T00:00:00+00:00')",
        )
        # The slot holds 2 now (r-promo + this one)… make it hold its max BEFORE w-full:
        psql(
            db,
            f"INSERT INTO reservations_reservation (id, hub_id, guest_name, guest_phone, guest_email, "
            f"date, time, party_size, duration_minutes, status, notes, internal_notes, is_deleted, created_at) "
            f"VALUES ('r-fill', '{HUB}', 'G', '', '', '2026-08-20', '21:30:00', 2, 90, 'confirmed', '', '', 0, "
            f"'2026-08-01T00:00:00+00:00')",
        )
        ok = promote(db, "w-full", "r-promo2")
        check("a full slot still refuses the promotion", 0, ok)
        leftover = psql(db, "SELECT COUNT(*) FROM reservations_reservation WHERE id = 'r-promo2';").strip()
        check("and nothing leaked: no reservation row survived", "0", leftover)
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db])

    print()
    if failures:
        print(f"FAILED — {len(failures)} assertion(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — the promotion stores HH:MM:SS and the edge slot matches (reservations#34)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
