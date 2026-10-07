#!/usr/bin/env python3
"""Erasing a customer's personal data empties her copies in the reservation book — pm#637
(reservations layer, RESERVATIONS-F22), against the REAL kernel.

The gesture is the one a restaurant makes: **Clientes → Borrar datos personales**.
`customers.anonymize` rewrites the sheet and publishes `customer.anonymized`; the runtime's outbox
relay hands it to every module that listens, inside its own transaction, with `:hub_id` and `:now`
injected by the host. Before pm#637 `reservations` did not listen: the guest's name, phone, email,
her notes (an allergy, a wheelchair: health data), the internal notes and the reason she gave to
cancel stayed in the book and in the waitlist for as long as the hub lived.

The Postgres battery next door (`customer_erasure.pg.test.py`) pins every column, every arm of the
idempotence guard and the tenancy with two hubs. This one proves what only the runtime can: that the
event the REAL `customers` emits reaches this module's listener, and the book the restaurant opens
afterwards no longer names her.

Usage: tests/customer_erasure.hub.test.py   (exit 0 = green)
  Needs a live runtime with `tables`+`customers`+`reservations` installed: `erplora test <dir>
  --against-hub` starts one and hands its url over in ERPLORA_HUB_BASE_URL. Without one it FAILS
  (a battery that excuses itself proves nothing — module-toolkit#50).
"""

import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
import zoneinfo

BASE = (os.environ.get("ERPLORA_HUB_BASE_URL") or "").rstrip("/")
NEEDS = ("tables", "customers", "reservations")
BATTERY = "customer_erasure.hub"
# The relay delivers on its own tick, after the erasure committed: wait for it, never sleep blind.
RELAY_DEADLINE_SECONDS = 60
PERSONAL = (
    "guest_name",
    "guest_phone",
    "guest_email",
    "notes",
    "internal_notes",
    "cancellation_reason",
)
WAITLIST_PERSONAL = ("guest_name", "guest_phone", "guest_email", "notes")

failures: list[str] = []


def check(label: str, got, want) -> None:
    if got != want:
        failures.append(f"{label} — expected [{want!r}], got [{got!r}]")
        print(f"  FAIL: {label} — expected [{want!r}], got [{got!r}]")
    else:
        print(f"  ok: {label} = {got!r}")


class Hub:
    """One battery's view of the live runtime: the tenant it seeds under and the two doors."""

    def __init__(self):
        if not BASE:
            print(
                f"{BATTERY}: no runtime at the other end (ERPLORA_HUB_BASE_URL is empty)."
            )
            print(
                "Run it with `erplora test <dir> --against-hub`; without a hub this is a FAILURE."
            )
            sys.exit(1)
        # Dev auth trusts `X-User-Id`; a fresh one per run keeps runs apart on a shared hub.
        self.user = f"u-{uuid.uuid4().hex[:8]}"
        with urllib.request.urlopen(f"{BASE}/api/hub/context", timeout=60) as res:
            context = json.loads(res.read().decode())
        # Seeds land under the RUNTIME's own hub id, not the `local` of ERPLORA_HUB_ID (hub#594).
        self.hub_id = context.get("hub_id")
        self.timezone = context.get("timezone")
        if not self.hub_id or not self.timezone:
            print(
                f"{BATTERY}: GET /api/hub/context did not say the hub_id and timezone: {context}"
            )
            sys.exit(1)
        status, body = self._request("GET", "/api/modules")
        installed = (
            {m["id"] for m in (body or {}).get("data", [])} if status == 200 else set()
        )
        missing = [m for m in NEEDS if m not in installed]
        if missing:
            print(
                f"{BATTERY}: the runtime at {BASE} lacks {missing} (installed: {sorted(installed)})."
            )
            sys.exit(1)

    def _request(self, method: str, path: str, body=None):
        req = urllib.request.Request(
            f"{BASE}{path}",
            data=None if body is None else json.dumps(body).encode(),
            headers={
                "content-type": "application/json",
                "x-hub-id": self.hub_id or "",
                "x-user-id": self.user,
            },
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.status, json.loads(res.read().decode() or "null")
        except urllib.error.HTTPError as err:
            raw = err.read().decode()
            try:
                return err.code, json.loads(raw or "null")
            except json.JSONDecodeError:
                return err.code, {"raw": raw}

    def query(self, name: str, params: dict) -> list:
        status, body = self._request(
            "POST", "/api/query", {"name": name, "params": params}
        )
        if status != 200 or not (body or {}).get("ok"):
            raise AssertionError(f"query {name} answered {status}: {body}")
        data = body["data"]
        return data["rows"] if isinstance(data, dict) and "rows" in data else data

    def run(self, name: str, payload: dict) -> dict:
        status, body = self._request(
            "POST", "/api/command", {"name": name, "payload": payload}
        )
        if status != 200 or not (body or {}).get("ok"):
            raise AssertionError(f"command {name} answered {status}: {body}")
        return body["data"]

    def new_id(self, name: str, payload: dict) -> str:
        ids = self.run(name, payload).get("new_ids") or []
        if not ids:
            raise AssertionError(f"command {name} minted no id")
        return ids[0]


def reservation(hub: Hub, reservation_id: str) -> dict:
    rows = hub.query(
        "reservations.reservations.get", {"reservation_id": reservation_id}
    )
    return rows[0] if rows else {}


def waitlist_entry(hub: Hub, entry_id: str, customer_id: str) -> dict:
    rows = hub.query(
        "reservations.waitlist.list", {"f_customer_id": customer_id, "limit": 500}
    )
    return next((r for r in rows if r.get("id") == entry_id), {})


def main() -> int:
    hub = Hub()
    mark = uuid.uuid4().hex[:6]
    name = f"Ana Erase {mark}"
    phone = f"+3460{int(mark, 16) % 10_000_000:07d}"
    email = f"ana-{mark}@example.com"
    customer_id = hub.new_id(
        "customers.create", {"name": name, "phone": phone, "email": email}
    )
    someone_id = hub.new_id(
        "customers.create", {"name": f"Luis {mark}", "phone": "+34611111111"}
    )

    # A week ahead in the BUSINESS's calendar: inside the default 1 h – 30 days window, and an open
    # service every day of the week so the weekday convention does not matter here.
    day = (
        datetime.datetime.now(zoneinfo.ZoneInfo(hub.timezone)).date()
        + datetime.timedelta(days=7)
    ).isoformat()
    for dow in range(7):
        hub.run(
            "reservations.timeslots.create",
            {
                "day_of_week": dow,
                "start_time": "12:00",
                "end_time": "23:00",
                "max_reservations": 50,
            },
        )

    print(
        "§0 she books twice, writes notes, cancels one with a reason and joins the waitlist"
    )
    booking = {
        "customer_id": customer_id,
        "guest_name": name,
        "guest_phone": phone,
        "guest_email": email,
        "date": day,
        "party_size": 4,
    }
    kept = hub.new_id(
        "reservations.reservations.create",
        {
            **booking,
            "time": "20:00",
            "notes": "allergic to nuts",
            "internal_notes": "wheelchair, table by the door",
        },
    )
    cancelled = hub.new_id(
        "reservations.reservations.create", {**booking, "time": "21:00"}
    )
    hub.run(
        "reservations.reservations.set_status",
        {
            "reservation_id": cancelled,
            "status": "cancelled",
            "cancellation_reason": f"moving to Paris {mark}",
        },
    )
    waiting = hub.new_id(
        "reservations.waitlist.create",
        {
            "customer_id": customer_id,
            "guest_name": name,
            "guest_phone": phone,
            "guest_email": email,
            "date": day,
            "preferred_time": "22:00",
            "party_size": 4,
            "notes": "high chair",
        },
    )
    # Someone else's booking on the same evening: the erasure must not reach it.
    other = hub.new_id(
        "reservations.reservations.create",
        {
            "customer_id": someone_id,
            "guest_name": f"Luis {mark}",
            "guest_phone": "+34611111111",
            "date": day,
            "time": "20:00",
            "party_size": 2,
            "notes": "birthday",
        },
    )

    before = reservation(hub, kept)
    check(
        "§0 control armed: the reservation holds her name, phone, email and notes",
        tuple(
            before.get(k)
            for k in (
                "guest_name",
                "guest_phone",
                "guest_email",
                "notes",
                "internal_notes",
            )
        ),
        (name, phone, email, "allergic to nuts", "wheelchair, table by the door"),
    )
    check(
        "§0 control armed: the cancelled one holds her reason",
        reservation(hub, cancelled).get("cancellation_reason"),
        f"moving to Paris {mark}",
    )
    check(
        "§0 control armed: the waitlist holds her name and notes",
        tuple(waitlist_entry(hub, waiting, customer_id).get(k) for k in ("guest_name", "notes")),
        (name, "high chair"),
    )

    print("§1 Clientes → Borrar datos personales")
    hub.run(
        "customers.anonymize", {"customer_id": customer_id, "reason": "GDPR request"}
    )
    deadline = time.monotonic() + RELAY_DEADLINE_SECONDS
    while reservation(hub, kept).get("guest_phone") and time.monotonic() < deadline:
        time.sleep(1)

    print("§2 the book no longer names her")
    for label, reservation_id in (
        ("the kept reservation", kept),
        ("the cancelled one", cancelled),
    ):
        row = reservation(hub, reservation_id)
        check(
            f"§2 {label}: name, phone, email, notes and reason are empty",
            {k: row.get(k) for k in PERSONAL},
            {k: "" for k in PERSONAL},
        )
    erased = reservation(hub, kept)
    kept_fields = (
        "customer_id",
        "date",
        "time",
        "party_size",
        "duration_minutes",
        "status",
    )
    check(
        "§2 the restaurant keeps the booking: same sheet link, date, time, guests and status",
        {k: erased.get(k) for k in kept_fields},
        {k: before.get(k) for k in kept_fields},
    )
    entry = waitlist_entry(hub, waiting, customer_id)
    check(
        "§2 the waitlist entry: name, phone, email and notes are empty",
        {k: entry.get(k) for k in WAITLIST_PERSONAL},
        {k: "" for k in WAITLIST_PERSONAL},
    )
    check(
        "§2 the waitlist entry keeps its day, time, guests and sheet link",
        tuple(entry.get(k) for k in ("customer_id", "date", "party_size")),
        (customer_id, day, 4),
    )
    # What the «Reservas» table reads: it paints «Deleted customer» only for a row that still links
    # a sheet and has no name, so the list must hand over the link, not just the blank name.
    listed = [
        {k: r.get(k) for k in ("customer_id", "guest_name")}
        for r in hub.query(
            "reservations.reservations.list", {"f_customer_id": customer_id, "limit": 500}
        )
        if r.get("id") == kept
    ]
    check(
        "§2 the reservations list hands over the link and the blank name",
        listed,
        [{"customer_id": customer_id, "guest_name": ""}],
    )

    print("§3 someone else's booking is untouched")
    row = reservation(hub, other)
    check(
        "§3 the other customer keeps her name, phone and notes",
        (row.get("guest_name"), row.get("guest_phone"), row.get("notes")),
        (f"Luis {mark}", "+34611111111", "birthday"),
    )

    print()
    if failures:
        print(f"✗ {BATTERY}: {len(failures)} failure(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        f"✓ {BATTERY}: erasing a customer from Clientes empties her name, contact, notes and reason "
        "in the reservations and the waitlist, keeps the booking, and leaves everyone else alone"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
