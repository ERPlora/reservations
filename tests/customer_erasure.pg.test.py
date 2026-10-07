#!/usr/bin/env python3
"""pm#637 (reservations layer, RESERVATIONS-F22) — erasing a customer empties her copies in the book.

`customers.anonymize` is the platform's GDPR erasure (art. 17). It publishes `customer.anonymized`
with `{customer_id, reason}` + the relay's `hub_id`. `reservations` copied the guest's name, phone and
email into each reservation and waitlist entry, plus free-text notes (allergies, a wheelchair: health
data), internal notes and the reason she gave to cancel. Unless this module listens, all of it
outlives the erasure.

WHAT IS PROVEN HERE, against a REAL Postgres, running the SQL the way the runtime does (`:name`
bound):

  1. The manifest listens to `customer.anonymized` with an internal, transactional command, one SQL
     file per table, no `schema` (the payload is the emitter's), no `emit`, no `expect_rows` (a
     customer who never booked is the ordinary case) and a permission the module declares.
  2. Every reservation and waitlist entry of that customer — live and soft-deleted, any status —
     loses every personal column; the row, its date, time, guests, status, table and sheet link stay.
     The actor and the server clock are stamped.
  3. Each arm of the idempotence guard is pinned by its own row: an entry erased before with ONE
     personal column left still gets that column emptied.
  4. A row with nothing personal left is not re-stamped, and a second delivery changes nothing.
  5. A degenerate event with a blank id touches nothing — not even a row whose link is blank.
  6. TENANCY — the same opaque id in the hub next door names someone else: untouched.
  7. Other customers and walk-ins without a sheet are untouched.

Uses `erplora-test-pg-5433` (override: ERPLORA_TEST_PG_CONTAINER); scratch DB dropped at the end.
Missing Docker = SKIPPED, never PASS.
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
EVENT = "customer.anonymized"
LISTENER = "reservations._on_customer_anonymized"
HUB = "hub-test"
OTHER_HUB = "hub-other"
ANA = "cust-ana"
CREATED = "2026-08-01T00:00:00+00:00"
NOW = "2026-10-07T10:00:00+00:00"
LATER = "2026-10-07T11:00:00+00:00"
ACTOR = "user-eraser"

RESERVATION_PERSONAL = (
    "guest_name",
    "guest_phone",
    "guest_email",
    "notes",
    "internal_notes",
    "cancellation_reason",
)
WAITLIST_PERSONAL = ("guest_name", "guest_phone", "guest_email", "notes")
RESERVATION_KEPT = (
    "customer_id",
    "date",
    "time",
    "party_size",
    "duration_minutes",
    "table_id",
    "status",
    "is_deleted",
)
WAITLIST_KEPT = (
    "customer_id",
    "date",
    "preferred_time",
    "party_size",
    "is_contacted",
    "is_converted",
    "is_deleted",
)
FULL_RESERVATION = {
    "guest_name": "Ana",
    "guest_phone": "+34600000001",
    "guest_email": "ana@example.com",
    "notes": "allergic to nuts",
    "internal_notes": "wheelchair",
    "cancellation_reason": "moving to Paris",
}
FULL_WAITLIST = {
    "guest_name": "Ana",
    "guest_phone": "+34600000001",
    "guest_email": "ana@example.com",
    "notes": "high chair",
}

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


def anonymize(db, hub=HUB, customer=ANA, now=NOW):
    """Deliver `customer.anonymized` the way the outbox relay does: the payload IS the emitter's params."""
    cmd = MANIFEST["commands"][LISTENER]
    params = {
        "customer_id": customer,
        "reason": "GDPR request",
        "hub_id": hub,
        "current_user_id": ACTOR,
        "now": now,
    }
    script = ["BEGIN;"]
    for rel in cmd["sql"]:
        script.append(
            PARAM.sub(
                lambda m: literal(params.get(m.group(1))),
                (MODULE_DIR / rel).read_text(),
            )
        )
    script.append("COMMIT;")
    psql(db, "\n".join(script))


def insert(db, table, values: dict):
    cols = ", ".join(values)
    vals = ", ".join(literal(v) for v in values.values())
    psql(db, f"INSERT INTO {table} ({cols}) VALUES ({vals})")


def reservation(
    db, rid, hub=HUB, customer=ANA, status="confirmed", deleted=0, **personal
):
    data = {k: "" for k in RESERVATION_PERSONAL}
    data.update(personal)
    insert(
        db,
        "reservations_reservation",
        {
            "id": rid,
            "hub_id": hub,
            "customer_id": customer,
            **data,
            "date": "2026-10-14",
            "time": "20:00:00",
            "party_size": 4,
            "duration_minutes": 90,
            "table_id": "table-7",
            "status": status,
            "is_deleted": deleted,
            "created_at": CREATED,
        },
    )


def waitlist(db, wid, hub=HUB, customer=ANA, deleted=0, **personal):
    data = {k: "" for k in WAITLIST_PERSONAL}
    data.update(personal)
    insert(
        db,
        "reservations_waitlistentry",
        {
            "id": wid,
            "hub_id": hub,
            "customer_id": customer,
            **data,
            "date": "2026-10-14",
            "preferred_time": "21:00:00",
            "party_size": 3,
            "is_contacted": 1,
            "is_deleted": deleted,
            "created_at": CREATED,
        },
    )


def row(db, table, rid) -> dict:
    out = psql(
        db, f"SELECT row_to_json(r) FROM (SELECT * FROM {table} WHERE id = '{rid}') r;"
    )
    return json.loads(out.strip()) if out.strip() else {}


def fingerprint(db, hub) -> str:
    """Every row of one hub with its personal columns and stamp, in a byte-stable order."""
    return psql(
        db,
        "SELECT COALESCE(string_agg(x, '|' ORDER BY x COLLATE \"C\"), '') FROM ("
        " SELECT 'r:' || id || ':' || concat_ws('/', guest_name, guest_phone, guest_email, notes, internal_notes,"
        "        cancellation_reason, COALESCE(updated_by, '-'), COALESCE(updated_at, '-')) AS x"
        f"   FROM reservations_reservation WHERE hub_id = '{hub}'"
        " UNION ALL"
        " SELECT 'w:' || id || ':' || concat_ws('/', guest_name, guest_phone, guest_email, notes,"
        "        COALESCE(updated_by, '-'), COALESCE(updated_at, '-'))"
        f"   FROM reservations_waitlistentry WHERE hub_id = '{hub}') t;",
    ).strip()


PROBE_BINDS = {"hub_id": HUB, "reservation_id": "r-live", "entry_id": "w-live"}


def screen_queries(db):
    """Every query that projects the guest's name hands over `customer_id` too — with the REAL SQL.

    The screens paint «Cliente borrado» only for a blank name on a row that still carries its sheet
    link (`ui/lib/guest-label.ts`); a query that drops `customer_id` from its SELECT turns the erased
    customer into a walk-in's «—» (pm#637 caught it in Citas twice: `recurring_list.sql`, then the
    overlap notice). The unit tests cannot see it, they are handed rows by hand; this runs each such
    query the way the engine does (`:hub_id` bound) against her erased row.
    """
    print("\n== every query that shows the name also hands over the sheet link ==")
    probed = 0
    for name, q in MANIFEST["queries"].items():
        rel = q.get("sql") if isinstance(q, dict) else None
        if not rel:
            continue
        sql = (MODULE_DIR / rel).read_text()
        if not re.search(r"\bguest_name\b", sql):
            continue
        probed += 1
        body = (
            PARAM.sub(lambda m: literal(PROBE_BINDS.get(m.group(1))), sql)
            .strip()
            .rstrip(";")
        )
        out = psql(
            db,
            f"SELECT row_to_json(q) FROM ({body}) q WHERE q.id IN ('r-live', 'w-live') LIMIT 1;",
        ).strip()
        got = json.loads(out) if out else {}
        check(
            f"`{name}` ({rel}) returns her erased row (probe binds reach it)",
            True,
            bool(got),
        )
        check(
            f"`{name}` ({rel}) projects customer_id next to the blank name",
            {"customer_id": ANA, "guest_name": ""},
            {k: got.get(k) for k in ("customer_id", "guest_name")},
        )
    check(
        "at least the two list queries and the detail one were probed",
        True,
        probed >= 3,
    )


def manifest_half():
    print("== the manifest declares the ear ==")
    listen = MANIFEST["events"].get("listen", {})
    check(
        f"`{EVENT}` is listened to", LISTENER, (listen.get(EVENT) or {}).get("command")
    )
    cmd = MANIFEST["commands"].get(LISTENER)
    check(f"`{LISTENER}` exists", True, cmd is not None)
    if cmd is None:
        return False
    check(
        "it is internal (leading `_`)", True, LISTENER.rsplit(".", 1)[1].startswith("_")
    )
    check("it is transactional", True, cmd.get("transaction"))
    check("it carries one SQL file per table", 2, len(cmd.get("sql") or []))
    check(
        "it has no schema (the payload belongs to the emitter)", None, cmd.get("schema")
    )
    check("it emits nothing", None, cmd.get("emit"))
    check(
        "it has no expect_rows (a customer without bookings is normal)",
        None,
        cmd.get("expect_rows"),
    )
    declared = {
        p if isinstance(p, str) else p.get("codename")
        for p in MANIFEST.get("permissions", [])
    }
    check(
        "its permission is declared by the module",
        True,
        cmd.get("permission") in declared,
    )
    return True


def main() -> int:
    wired = manifest_half()
    ready = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
        capture_output=True,
        text=True,
    )
    if ready.returncode != 0:
        print(
            f"SKIPPED: no Postgres in container {CONTAINER} (the SQL half was not verified)"
        )
        return 1 if failures else 0
    if not wired:
        print(f"\nFAILED — {len(failures)} assertion(s)")
        return 1

    db = f"reservations_erase_{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True
    )
    try:
        for rel in [
            e if isinstance(e, str) else e["file"]
            for e in MANIFEST["migrations"]["postgres"]
        ]:
            psql(db, (MODULE_DIR / rel).read_text())

        # Her book in this hub: a live one and a cancelled-then-deleted one with everything filled.
        reservation(db, "r-live", **FULL_RESERVATION)
        reservation(db, "r-gone", status="cancelled", deleted=1, **FULL_RESERVATION)
        # One row per arm of the guard: erased before, ONE personal column left.
        for col in RESERVATION_PERSONAL:
            reservation(
                db, f"r-only-{col}", status="completed", deleted=1, **{col: "left over"}
            )
        reservation(
            db, "r-already", status="completed"
        )  # nothing personal left: not re-stamped
        waitlist(db, "w-live", **FULL_WAITLIST)
        waitlist(db, "w-gone", deleted=1, **FULL_WAITLIST)
        for col in WAITLIST_PERSONAL:
            waitlist(db, f"w-only-{col}", deleted=1, **{col: "left over"})
        waitlist(db, "w-already")
        # Others in this hub: another customer, walk-ins without a sheet, and a link left blank.
        reservation(db, "r-luis", customer="cust-luis", **FULL_RESERVATION)
        reservation(db, "r-walkin", customer=None, **FULL_RESERVATION)
        reservation(db, "r-blank-link", customer="", **FULL_RESERVATION)
        waitlist(db, "w-luis", customer="cust-luis", **FULL_WAITLIST)
        waitlist(db, "w-walkin", customer=None, **FULL_WAITLIST)
        waitlist(db, "w-blank-link", customer="", **FULL_WAITLIST)
        # The hub next door: the SAME opaque id names someone else there, in both tables.
        reservation(db, "n-ana", hub=OTHER_HUB, **FULL_RESERVATION)
        waitlist(db, "nw-ana", hub=OTHER_HUB, **FULL_WAITLIST)
        neighbour_before = fingerprint(db, OTHER_HUB)
        kept_before = {
            rid: {
                k: row(db, "reservations_reservation", rid).get(k)
                for k in RESERVATION_KEPT
            }
            for rid in ("r-live", "r-gone")
        }
        kept_before.update(
            {
                wid: {
                    k: row(db, "reservations_waitlistentry", wid).get(k)
                    for k in WAITLIST_KEPT
                }
                for wid in ("w-live", "w-gone")
            }
        )

        print("\n== a degenerate event (blank id) touches nothing ==")
        here_before = fingerprint(db, HUB)
        anonymize(db, customer="")
        check(
            "the blank-id event is a no-op (the blank-link rows keep their data)",
            here_before,
            fingerprint(db, HUB),
        )

        print("\n== the book forgets her ==")
        anonymize(db)
        for rid in ("r-live", "r-gone", *(f"r-only-{c}" for c in RESERVATION_PERSONAL)):
            r = row(db, "reservations_reservation", rid)
            check(
                f"{rid}: every personal column is empty",
                {k: "" for k in RESERVATION_PERSONAL},
                {k: r.get(k) for k in RESERVATION_PERSONAL},
            )
            check(
                f"{rid}: stamped with the server clock and the actor",
                (NOW, ACTOR),
                (r.get("updated_at"), r.get("updated_by")),
            )
        for wid in ("w-live", "w-gone", *(f"w-only-{c}" for c in WAITLIST_PERSONAL)):
            w = row(db, "reservations_waitlistentry", wid)
            check(
                f"{wid}: every personal column is empty",
                {k: "" for k in WAITLIST_PERSONAL},
                {k: w.get(k) for k in WAITLIST_PERSONAL},
            )
            check(
                f"{wid}: stamped with the server clock and the actor",
                (NOW, ACTOR),
                (w.get("updated_at"), w.get("updated_by")),
            )
        for rid in ("r-live", "r-gone"):
            check(
                f"{rid}: the booking itself stays (link, date, time, guests, table, status)",
                kept_before[rid],
                {
                    k: row(db, "reservations_reservation", rid).get(k)
                    for k in RESERVATION_KEPT
                },
            )
        for wid in ("w-live", "w-gone"):
            check(
                f"{wid}: the entry itself stays (link, date, time, guests, flags)",
                kept_before[wid],
                {
                    k: row(db, "reservations_waitlistentry", wid).get(k)
                    for k in WAITLIST_KEPT
                },
            )
        check(
            "a reservation with nothing personal left is not re-stamped",
            None,
            row(db, "reservations_reservation", "r-already").get("updated_at"),
        )
        check(
            "a waitlist entry with nothing personal left is not re-stamped",
            None,
            row(db, "reservations_waitlistentry", "w-already").get("updated_at"),
        )
        for table, rid, cols in (
            ("reservations_reservation", "r-luis", RESERVATION_PERSONAL),
            ("reservations_reservation", "r-walkin", RESERVATION_PERSONAL),
            ("reservations_reservation", "r-blank-link", RESERVATION_PERSONAL),
            ("reservations_waitlistentry", "w-luis", WAITLIST_PERSONAL),
            ("reservations_waitlistentry", "w-walkin", WAITLIST_PERSONAL),
            ("reservations_waitlistentry", "w-blank-link", WAITLIST_PERSONAL),
        ):
            r = row(db, table, rid)
            full = (
                FULL_RESERVATION
                if table == "reservations_reservation"
                else FULL_WAITLIST
            )
            check(
                f"{rid} is untouched",
                ({k: full[k] for k in cols}, None),
                ({k: r.get(k) for k in cols}, r.get("updated_at")),
            )

        screen_queries(db)

        print("\n== tenancy: the hub next door is not touched ==")
        check(
            "hub B rows on the same id keep everything",
            neighbour_before,
            fingerprint(db, OTHER_HUB),
        )

        print("\n== idempotent: a redelivery changes nothing ==")
        after_first = fingerprint(db, HUB)
        anonymize(db, now=LATER)
        check(
            "a second delivery empties nothing more and stamps nothing",
            after_first,
            fingerprint(db, HUB),
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
        "PASS — an erased customer leaves no name, contact, note or reason in the reservations or the waitlist (pm#637)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
