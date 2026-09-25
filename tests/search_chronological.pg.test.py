#!/usr/bin/env python3
"""Search results come out in CALENDAR order, against a REAL Postgres (reservations#67).

A search drops the day anchor (reservations#45): the name is looked up in the whole book. The
runtime's list engine orders by ONE column (`ORDER BY sub.<col> <dir>`), so ordering by `time`
mixed the days — «Carmen · 28/9 · 13:15» above «Marta · 25/9 · 20:30». The list query exposes
`starts_at` (date + time, ISO text, so text order IS chronological) and whitelists it for sorting;
the screen sorts the matches by it.

Contract:
  - `reservations.reservations.list` declares `starts_at` as a sortable column.
  - Every row carries `starts_at` = `<date> <time>`.
  - Ordered by `starts_at` asc, the matches of a search go by day first, then by hour inside the
    day; desc is the exact reverse.

Runs the SQL the way the runtime's list engine does (`SELECT * FROM (<sql>) sub WHERE <search>
ORDER BY sub.<col> <dir>`). Uses the `erplora-test-pg-5433` container (override:
ERPLORA_TEST_PG_CONTAINER); scratch DB dropped at the end. Missing Docker = SKIPPED.
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
QUERY = "reservations.reservations.list"
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
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db,
         "-v", "ON_ERROR_STOP=1", "-q", "-X", "-tA"],
        input=sql,
        capture_output=True,
        text=True,
    )
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout


PARAM = re.compile(r"(?<!:):([a-z_][a-z0-9_]*)")  # `::` is a cast, never a bind


def list_page(db, search: str, sort: str, direction: str) -> list[dict]:
    """The list engine's shape: the module SQL as `sub`, the search over the declared columns,
    ONE order column taken from the whitelist."""
    qdef = MANIFEST["queries"][QUERY]
    spec = qdef["list"]
    sql = (MODULE_DIR / qdef["sql"]).read_text().strip().rstrip(";")
    sql = PARAM.sub(lambda m: "'" + HUB + "'" if m.group(1) == "hub_id" else "''", sql)
    needle = "'%" + search.replace("'", "''") + "%'"
    where = " OR ".join(f"sub.{c}::text ILIKE {needle}" for c in spec["search"])
    out = psql(
        db,
        f"SELECT row_to_json(sub) FROM ({sql}) sub WHERE ({where}) ORDER BY sub.{sort} {direction};",
    )
    return [json.loads(l) for l in out.splitlines() if l.strip()]


def seed(db):
    res = [
        # id, guest, date, time, hub
        ("r-carmen-28", "Carmen García", "2026-09-28", "13:15:00", HUB),
        ("r-marta-25", "Marta García", "2026-09-25", "20:30:00", HUB),
        ("r-luis-26", "Luis García", "2026-09-26", "21:00:00", HUB),
        ("r-ana-25", "Ana García", "2026-09-25", "13:45:00", HUB),
        ("r-pepe-25", "Pepe Pérez", "2026-09-25", "12:00:00", HUB),  # does not match
        ("r-other-hub", "Eva García", "2026-09-24", "09:00:00", "hub-other"),  # other hub
    ]
    for rid, guest, d, t, hub in res:
        psql(
            db,
            f"INSERT INTO reservations_reservation (id, hub_id, guest_name, guest_phone, guest_email, "
            f"date, time, party_size, duration_minutes, status, notes, internal_notes, is_deleted, created_at) "
            f"VALUES ('{rid}', '{hub}', '{guest}', '', '', '{d}', '{t}', 2, 90, 'confirmed', '', '', 0, "
            f"'2026-09-01T00:00:00+00:00')",
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

    spec = MANIFEST["queries"][QUERY].get("list") or {}
    check("`starts_at` is whitelisted for sorting (else the engine falls back to default_sort)",
          True, "starts_at" in spec.get("sort", []))
    if "starts_at" not in spec.get("sort", []):
        print(f"\nFAILED — {len(failures)} assertion(s)")
        return 1

    db = f"reservations_search_order_{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True)
    try:
        for rel in [e if isinstance(e, str) else e["file"] for e in MANIFEST["migrations"]["postgres"]]:
            psql(db, (MODULE_DIR / rel).read_text())
        seed(db)

        print("\n== every row carries its start as date + time ==")
        rows = list_page(db, "García", "starts_at", "ASC")
        check("starts_at of Marta", "2026-09-25 20:30:00",
              next((r.get("starts_at") for r in rows if r["id"] == "r-marta-25"), None))

        print("\n== a search: day first, then the hour inside the day ==")
        check("asc = calendar order",
              ["r-ana-25", "r-marta-25", "r-luis-26", "r-carmen-28"],
              [r["id"] for r in rows])
        rows = list_page(db, "García", "starts_at", "DESC")
        check("desc = the exact reverse",
              ["r-carmen-28", "r-luis-26", "r-marta-25", "r-ana-25"],
              [r["id"] for r in rows])
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db])

    print()
    if failures:
        print(f"FAILED — {len(failures)} assertion(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(f"PASS — search matches come out in calendar order (reservations#67)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
