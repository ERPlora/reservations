#!/usr/bin/env python3
"""customers#86 (reservations layer) — when two customer sheets are merged, the reservations follow the survivor.

`customers.merge` retires the absorbed sheet (soft delete) and publishes `customer.merged` with
`{surviving_id, absorbed_id, hub_id}` (customers#87). `reservations` stores the customer as an OPAQUE
id in two tables — `reservations_reservation` and `reservations_waitlistentry` — so unless this
module re-points them, the survivor's history misses every booking made under the duplicate sheet.

WHAT IS PROVEN HERE, against a REAL Postgres:

  1. The manifest listens to `customer.merged` with an internal, transactional command that emits
     nothing and has no `expect_rows` (merging a customer who never booked is the ordinary case).
  2. Reservations AND waitlist entries — live and soft-deleted, any status — move to the survivor;
     the guest snapshot (name, phone) is left as it was booked.
  3. It does not require the absorbed sheet to exist: no `customers` table in this database.
  4. Rows of other customers, and walk-ins without a customer, are untouched.
  5. IDEMPOTENCE — the outbox is at-least-once; a redelivery changes nothing (not even updated_at).
  6. A degenerate event (`surviving_id = absorbed_id`) is a no-op.
  7. TENANCY — rows of the hub next door carrying the absorbed id (or the survivor's) are NOT
     re-pointed: an opaque id has no cross-module foreign key, the same string may name someone else.

Runs the SQL the way the runtime does (`:name` bound). Uses `erplora-test-pg-5433` (override:
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
EVENT = "customer.merged"
LISTENER = "reservations._on_customer_merged"
HUB = "hub-test"
OTHER_HUB = "hub-other"
SURVIVOR = "cust-ana"
ABSORBED = "cust-ana-dup"
CREATED = "2026-08-01T00:00:00+00:00"
NOW = "2026-09-26T10:00:00+00:00"
LATER = "2026-09-26T11:00:00+00:00"

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


def literal(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


PARAM = re.compile(r"(?<!:):([a-z_][a-z0-9_]*)")  # `::` is a cast, never a bind


def merge(db, hub=HUB, surviving=SURVIVOR, absorbed=ABSORBED, now=NOW):
    """Deliver `customer.merged` the way the outbox relay does: the payload IS the emitter's params."""
    cmd = MANIFEST["commands"][LISTENER]
    params = {
        "surviving_id": surviving,
        "absorbed_id": absorbed,
        "hub_id": hub,
        "current_user_id": "user-merger",
        "now": now,
    }
    script = ["BEGIN;"]
    for rel in cmd["sql"]:
        script.append(
            PARAM.sub(lambda m: literal(params.get(m.group(1))), (MODULE_DIR / rel).read_text())
        )
    script.append("COMMIT;")
    psql(db, "\n".join(script))


def reservation(db, rid, hub, customer, status="confirmed", deleted=0, name="Ana"):
    psql(
        db,
        "INSERT INTO reservations_reservation (id, hub_id, customer_id, guest_name, guest_phone, "
        "guest_email, date, time, party_size, duration_minutes, status, notes, internal_notes, "
        f"is_deleted, created_at) VALUES ({literal(rid)}, {literal(hub)}, {literal(customer)}, "
        f"{literal(name)}, '600000000', '', '2026-10-01', '20:00:00', 2, 90, {literal(status)}, "
        f"'', '', {deleted}, '{CREATED}')",
    )


def waitlist(db, wid, hub, customer, deleted=0):
    psql(
        db,
        "INSERT INTO reservations_waitlistentry (id, hub_id, customer_id, guest_name, guest_phone, "
        "date, preferred_time, party_size, is_deleted, created_at) VALUES "
        f"({literal(wid)}, {literal(hub)}, {literal(customer)}, 'Ana', '600000000', '2026-10-01', "
        f"'21:00:00', 2, {deleted}, '{CREATED}')",
    )


def row(db, table, rid) -> dict:
    out = psql(
        db,
        f"SELECT row_to_json(r) FROM (SELECT customer_id, guest_name, guest_phone, updated_by, "
        f"updated_at FROM {table} WHERE id = '{rid}') r;",
    )
    return json.loads(out.strip()) if out.strip() else {}


def fingerprint(db, hub) -> str:
    """Every customer-bearing row of one hub, in a byte-stable order (COLLATE "C", not the locale)."""
    return psql(
        db,
        "SELECT COALESCE(string_agg(x, '|' ORDER BY x COLLATE \"C\"), '') FROM ("
        " SELECT 'r:' || id || ':' || COALESCE(customer_id, '-') || ':' || COALESCE(updated_at, '-') AS x"
        f"   FROM reservations_reservation WHERE hub_id = '{hub}'"
        " UNION ALL"
        " SELECT 'w:' || id || ':' || COALESCE(customer_id, '-') || ':' || COALESCE(updated_at, '-')"
        f"   FROM reservations_waitlistentry WHERE hub_id = '{hub}') t;",
    ).strip()


def manifest_half():
    print("== the manifest declares the ear ==")
    listen = MANIFEST["events"].get("listen", {})
    check(f"`{EVENT}` is listened to", LISTENER, (listen.get(EVENT) or {}).get("command"))
    cmd = MANIFEST["commands"].get(LISTENER)
    check(f"`{LISTENER}` exists", True, cmd is not None)
    if cmd is None:
        return False
    check("it is internal (leading `_`)", True, LISTENER.rsplit(".", 1)[1].startswith("_"))
    check("it is transactional", True, cmd.get("transaction"))
    check("it carries SQL", True, bool(cmd.get("sql")))
    check("it emits nothing", None, cmd.get("emit"))
    check("it has no expect_rows (a customer without bookings is normal)", None, cmd.get("expect_rows"))
    declared = {p if isinstance(p, str) else p.get("codename") for p in MANIFEST.get("permissions", [])}
    check("its permission is declared by the module", True, cmd.get("permission") in declared)
    return True


def main() -> int:
    wired = manifest_half()
    ready = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"], capture_output=True, text=True
    )
    if ready.returncode != 0:
        print(f"SKIPPED: no Postgres in container {CONTAINER} (the SQL half was not verified)")
        return 1 if failures else 0
    if not wired:
        print(f"\nFAILED — {len(failures)} assertion(s)")
        return 1

    db = f"reservations_merge_{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True)
    try:
        for rel in [e if isinstance(e, str) else e["file"] for e in MANIFEST["migrations"]["postgres"]]:
            psql(db, (MODULE_DIR / rel).read_text())

        # This hub: the survivor booked once; the duplicate sheet booked under another spelling.
        reservation(db, "r-surv", HUB, SURVIVOR)
        reservation(db, "r-abs-live", HUB, ABSORBED, name="ana garcia")
        reservation(db, "r-abs-done", HUB, ABSORBED, status="completed")
        reservation(db, "r-abs-deleted", HUB, ABSORBED, status="cancelled", deleted=1)
        waitlist(db, "w-abs", HUB, ABSORBED)
        waitlist(db, "w-abs-deleted", HUB, ABSORBED, deleted=1)
        reservation(db, "r-someone", HUB, "cust-luis")
        reservation(db, "r-walkin", HUB, None)
        waitlist(db, "w-walkin", HUB, None)
        # The hub next door: the SAME opaque ids name other people there, in both tables.
        reservation(db, "n-abs", OTHER_HUB, ABSORBED)
        reservation(db, "n-surv", OTHER_HUB, SURVIVOR)
        waitlist(db, "nw-abs", OTHER_HUB, ABSORBED)
        neighbour_before = fingerprint(db, OTHER_HUB)
        check("no `customers` table here: the listener cannot depend on the absorbed sheet",
              "", psql(db, "SELECT to_regclass('customers_customer');").strip())

        print("\n== the bookings follow the survivor ==")
        merge(db)
        for table, rid in (
            ("reservations_reservation", "r-abs-live"),
            ("reservations_reservation", "r-abs-done"),
            ("reservations_reservation", "r-abs-deleted"),
            ("reservations_waitlistentry", "w-abs"),
            ("reservations_waitlistentry", "w-abs-deleted"),
        ):
            r = row(db, table, rid)
            check(f"{rid} now belongs to the survivor", SURVIVOR, r.get("customer_id"))
            check(f"{rid} stamps updated_at with the server clock", NOW, r.get("updated_at"))
            check(f"{rid} stamps who merged", "user-merger", r.get("updated_by"))
        live = row(db, "reservations_reservation", "r-abs-live")
        check("the guest snapshot is kept as it was booked", ("ana garcia", "600000000"),
              (live.get("guest_name"), live.get("guest_phone")))
        check("the survivor's own booking is untouched", None,
              row(db, "reservations_reservation", "r-surv").get("updated_at"))
        check("another customer's booking is untouched", ("cust-luis", None),
              tuple(row(db, "reservations_reservation", "r-someone").get(k) for k in ("customer_id", "updated_at")))
        check("a walk-in without customer stays without one", (None, None),
              tuple(row(db, "reservations_reservation", "r-walkin").get(k) for k in ("customer_id", "updated_at")))
        check("a walk-in waitlist entry stays without one", (None, None),
              tuple(row(db, "reservations_waitlistentry", "w-walkin").get(k) for k in ("customer_id", "updated_at")))
        check("nothing is left on the absorbed id in this hub", "0", psql(
            db,
            f"SELECT (SELECT count(*) FROM reservations_reservation WHERE hub_id = '{HUB}' AND customer_id = '{ABSORBED}')"
            f" + (SELECT count(*) FROM reservations_waitlistentry WHERE hub_id = '{HUB}' AND customer_id = '{ABSORBED}');",
        ).strip())

        print("\n== tenancy: the hub next door is not touched ==")
        check("hub B rows pointing at the absorbed id are NOT re-pointed", neighbour_before,
              fingerprint(db, OTHER_HUB))

        print("\n== idempotent: a redelivery changes nothing ==")
        after_first = fingerprint(db, HUB)
        merge(db, now=LATER)
        check("a second delivery moves nothing and stamps nothing", after_first, fingerprint(db, HUB))

        print("\n== a degenerate event (surviving = absorbed) is a no-op ==")
        merge(db, surviving=SURVIVOR, absorbed=SURVIVOR, now=LATER)
        check("the survivor's rows are not re-stamped", after_first, fingerprint(db, HUB))
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db])

    print()
    if failures:
        print(f"FAILED — {len(failures)} assertion(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — a merged customer keeps every reservation and waitlist entry (customers#86)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
