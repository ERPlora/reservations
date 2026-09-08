#!/usr/bin/env python3
"""reservations#53 — one narrow door for «confirm automatically», and the wide one kept honest.

WHAT THIS IS. The mirror of appointments#149 for the restaurant, with its premise corrected by
the triage of 08/09/2026 against `origin/main@b8c4621`.

In Citas the wide door really did clobber: its form schema declares a `default` on every
property, the runtime materialises the ones the caller omitted (ADR-0073,
`crates/runtime/src/registry.rs::apply_defaults`) and the SQL writes them all — 12 of 12 settings
reset by a foreign write that only meant to flip one switch.

HERE IT DOES NOT, AND THAT IS THE POINT. `commands/settings_upsert.sql` writes
`COALESCE(:bind, reservations_settings.col)` and `schemas/settings_upsert.json` declares the
thirteen properties as `["<type>", "null"]` with NO `default`, so an omitted key arrives NULL and
the COALESCE preserves what was saved. Measured, both directions:

    A) as published            → nothing wiped
    B) same run with ONE `default` added to `time_slot_duration`
                               → time_slot_duration: 45 -> 30

So the wide door is not broken; it is **one `default` away from breaking, with nobody watching**.
That fragility is what layer 4 pins.

WHY A NARROW COMMAND ANYWAY. `whatsapp_inbox#126` needs a door to declare as `commandOptional`
(ADR-0127) from its «Reservar mesa» card. Handing it `settings.upsert` hands the WhatsApp screen
the right to rewrite the restaurant's ENTIRE configuration in order to flip one switch, and it
breaks the symmetry with `appointments.settings.set_auto_confirm_online`, which the same screen
already calls for the salon. One switch, one door, in both modules.

WHAT IS CHECKED, five layers:

  1. THE CONTRACT (no container). The command exists, takes exactly one boolean under
     `additionalProperties: false`, is gated by the same permission as `settings.upsert`, runs in
     a transaction, emits the settings event the module declares, and its `expect_rows` code is
     translated in `en` + `es` (this module ships no `errors` catalog — `update_rejected` is
     raised without one — so the locales ARE the contract; #51 is what an untranslated code looks
     like from the dining room). Plus the static half of the guard: the SQL may assign the flag,
     the audit columns and the singleton's identity, nothing else.

  2. THE ROW IS NOT CLOBBERED (real Postgres). A restaurant whose thirteen settings all differ
     from their factory value flips the switch through the narrow door: the flag moves, the audit
     moves, every other column is byte-identical. With a control that proves the comparison can
     SEE a change at all, so a green here is not a green for nothing.

  3. THE HUB THAT NEVER SAVED SETTINGS. The narrow door on an empty table creates the singleton
     with the value asked for and with exactly what `settings.upsert` writes from an empty form.

  4. THE WIDE DOOR CANNOT BECOME A CLOBBERER (no container). No property of the form schema
     declares a `default`, and every one of them is preserved by a `COALESCE(:bind, <table>.col)`
     in the upsert. Either half alone is not enough: the `default` is what ADR-0073 materialises,
     the COALESCE is what saves the NULL. This is the regression guard for the failure this issue
     was originally filed about.

  5. TENANCY AND SOFT-DELETE. The write reaches one hub only, and a soft-deleted settings row
     affects 0 rows — which `expect_rows` turns into the declared error instead of a silent write
     into a row `reservations.settings.get` cannot read back.

Usage: tests/settings_narrow_write.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: ERPLORA_TEST_PG_CONTAINER). Creates a
  throwaway database and DROPS it at the end, pass or fail. Without the container layers 2, 3
  and 5 are SKIPPED — never counted as passed. Layers 1 and 4 run regardless.
"""

import json
import os
import pathlib
import re
import subprocess
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())

CONTAINER = os.environ.get("ERPLORA_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"reservations_settings_narrow_write_test_{os.getpid()}"

NARROW = "reservations.settings.set_auto_confirm"
UPSERT = "reservations.settings.upsert"
FLAG = "auto_confirm"
TABLE = "reservations_settings"

NOW = "2026-09-08T09:00:00+02:00"
LATER = "2026-09-08T18:30:00+02:00"

AUDIT_COLUMNS = {"created_by", "updated_by", "created_at", "updated_at"}
IDENTITY_COLUMNS = {"id", "hub_id"}

# A restaurant that configured EVERY setting away from its factory value. Layer 2 leans on that:
# a column left at its default could be clobbered without the comparison noticing.
CONFIGURED = {
    "time_slot_duration": 45,
    "min_party_size": 2,
    "max_party_size": 12,
    "min_advance_hours": 4,
    "max_advance_days": 60,
    "require_phone": False,
    "require_email": True,
    "no_show_window_minutes": 30,
    "default_duration_minutes": 90,
    "send_confirmation_email": True,
    "send_reminder_email": True,
    "reminder_hours_before": 6,
    FLAG: True,
}

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


# ── manifest helpers ─────────────────────────────────────────────────────────────────────


def command(name: str) -> dict:
    return MANIFEST.get("commands", {}).get(name, {})


def schema_of(name: str) -> dict:
    rel = command(name).get("schema")
    if not isinstance(rel, str) or not (MODULE_DIR / rel).exists():
        return {}
    return json.loads((MODULE_DIR / rel).read_text())


def sql_text(name: str) -> str:
    return "\n".join((MODULE_DIR / rel).read_text() for rel in command(name).get("sql", []))


def strip_comments(sql: str) -> str:
    return re.sub(r"--[^\n]*", " ", sql)


# ── Layer 1: the contract ────────────────────────────────────────────────────────────────

ASSIGNMENT_RE = re.compile(r"([a-z_][a-z0-9_]*)\s*=", re.I)
INSERT_COLUMNS_RE = re.compile(rf"INSERT\s+INTO\s+{TABLE}\s*\(([^)]*)\)", re.I | re.S)


def check_command_is_declared() -> None:
    spec = command(NARROW)
    if not spec:
        fail(
            f"`{NARROW}` is not declared in module.json: the only way to flip {FLAG!r} from "
            f"another screen is still `{UPSERT}`, which takes the whole form"
        )
        return
    upsert = command(UPSERT)
    if spec.get("permission") != upsert.get("permission"):
        fail(
            f"commands.{NARROW}.permission is {spec.get('permission')!r} but `{UPSERT}` is gated "
            f"by {upsert.get('permission')!r}: the same policy must need the same permission, or "
            "the narrow door is either a privilege escalation or a dead end"
        )
    if spec.get("permission") not in MANIFEST.get("permissions", []):
        fail(f"commands.{NARROW}.permission {spec.get('permission')!r} is not in `permissions`")
    if spec.get("transaction") is not True:
        fail(f"commands.{NARROW}: `transaction` is not true — write and outbox must roll back together")
    emits = spec.get("emit", [])
    if "reservations.settings.updated" not in emits:
        fail(
            f"commands.{NARROW}.emit does not carry `reservations.settings.updated`: whoever "
            "reacts to a settings change (flows, other modules) would miss this one"
        )
    for event in emits:
        if event not in MANIFEST.get("events", {}).get("emits", []):
            fail(f"commands.{NARROW}.emit: {event!r} is not declared in `events.emits`")
    if not isinstance(spec.get("ai", {}).get("description"), str):
        fail(f"commands.{NARROW}.ai.description: missing — the assistant needs it in English")


def check_payload_is_one_boolean() -> None:
    schema = schema_of(NARROW)
    if not schema:
        fail(f"commands.{NARROW}.schema does not resolve to a JSON Schema in the package")
        return
    if schema.get("additionalProperties") is not False:
        fail(
            f"schemas of {NARROW}: `additionalProperties` is not false — a public command (no "
            "leading `_`, no `internal: true`) is a door anybody with the permission can push, "
            "so it must refuse what it does not declare"
        )
    props = schema.get("properties") or {}
    if set(props) != {FLAG}:
        fail(f"schemas of {NARROW}: declares {sorted(props)} — the narrow door takes exactly [{FLAG!r}]")
    if (props.get(FLAG) or {}).get("type") != "boolean":
        fail(
            f"schemas of {NARROW}: {FLAG!r} must be plainly `boolean`. The wide form declares "
            f'`["boolean", "null"]` because there NULL means «leave it alone»; a door that exists '
            "to set this one value has no such meaning to express"
        )
    if schema.get("required") != [FLAG]:
        fail(
            f"schemas of {NARROW}: {FLAG!r} must be `required` — otherwise an empty payload flips "
            "the restaurant's policy without saying so"
        )
    if FLAG in props and "default" in props[FLAG]:
        fail(
            f"schemas of {NARROW}: {FLAG!r} must NOT carry a `default` (ADR-0073 would materialise "
            "it and turn an omission into a decision)"
        )


def check_expect_rows_error_is_translated() -> None:
    expect = command(NARROW).get("expect_rows")
    if not isinstance(expect, dict):
        fail(
            f"commands.{NARROW}: no `expect_rows` gate — a write that matched no row would answer "
            "200 and emit the event for a change that never happened"
        )
        return
    if expect.get("op") != "min" or expect.get("n") != 1:
        fail(f"commands.{NARROW}.expect_rows: expected `min` 1, got {expect.get('op')!r} {expect.get('n')!r}")
    code = expect.get("error")
    if not isinstance(code, str) or not code.startswith("reservations."):
        fail(f"commands.{NARROW}.expect_rows.error: {code!r} is not a code of this module")
        return
    catalog = MANIFEST.get("errors")
    if isinstance(catalog, dict) and code not in catalog:
        fail(
            f"commands.{NARROW}.expect_rows.error: this module now ships an `errors` catalog and "
            f"{code!r} is not in it — the installer refuses a code that is raised and not declared "
            "(ADR-0398)"
        )
    for lang in ("en", "es"):
        catalogue = json.loads((MODULE_DIR / "locales" / f"{lang}.json").read_text())
        if code not in (catalogue.get("errors") or {}):
            fail(
                f"locales/{lang}.json: {code!r} has no message — the restaurant would read a raw "
                "error code, which is exactly what #51 is about (ADR-0055: `en` + its `es`)"
            )


def check_sql_touches_nothing_else() -> None:
    """The static half of the guard: a mutant that widens the write dies without Postgres."""
    sql = strip_comments(sql_text(NARROW))
    if not sql.strip():
        fail(f"commands.{NARROW}: declares no SQL")
        return
    allowed = {FLAG} | AUDIT_COLUMNS | IDENTITY_COLUMNS | {"is_deleted", "deleted_at"}
    assigned = {m.group(1).lower() for m in ASSIGNMENT_RE.finditer(sql)}
    widened = sorted(assigned - allowed - {"excluded"})
    if widened:
        fail(
            f"commands.{NARROW} SQL: touches {widened} — the whole point of this door is that it "
            f"writes {FLAG!r} and the audit trail, and nothing else (reservations#53)"
        )
    for match in INSERT_COLUMNS_RE.finditer(sql):
        columns = {c.strip().lower() for c in match.group(1).split(",") if c.strip()}
        extra = sorted(columns - allowed)
        if extra:
            fail(
                f"commands.{NARROW} SQL: the INSERT branch lists {extra} — the singleton it creates "
                f"for a hub with no settings must take the rest from the table DEFAULTs, so the "
                "factory values live in ONE place (the migration), not two"
            )


# ── Layer 4: the wide door cannot become a clobberer ──────────────────────────────────────


def check_wide_door_still_preserves() -> None:
    """The regression guard for what reservations#53 was filed about.

    Two halves, and BOTH are needed. ADR-0073 materialises a declared `default` into the payload,
    so a property that grows one stops arriving NULL; the `COALESCE(:bind, <table>.col)` is what
    turns a NULL into «leave it alone». Lose either and a foreign write that names one field
    resets the ones it did not name — measured: adding a single `default` to `time_slot_duration`
    is enough (45 -> 30).
    """
    schema = schema_of(UPSERT)
    props = schema.get("properties") or {}
    if not props:
        fail(f"schemas of {UPSERT}: no properties — this guard would pass by finding nothing")
        return
    with_default = sorted(k for k, v in props.items() if isinstance(v, dict) and "default" in v)
    if with_default:
        fail(
            f"schemas of {UPSERT}: {with_default} declare(s) a `default`. The runtime materialises "
            "it for every caller that omits the key (ADR-0073), so a screen that only wanted to "
            "change one setting now silently resets those — which is the defect reservations#53 "
            f"was filed about. Use `[\"<type>\", \"null\"]` with no default, like the other properties"
        )
    upsert_sql = strip_comments(sql_text(UPSERT))
    unprotected = [
        k
        for k in props
        if not re.search(rf"{k}\s*=\s*COALESCE\s*\(\s*:{k}\s*,\s*(?:{TABLE}\.)?{k}\s*\)", upsert_sql, re.I)
    ]
    if unprotected:
        fail(
            f"commands.{UPSERT} SQL: {sorted(unprotected)} is/are not written as "
            f"`COALESCE(:<prop>, {TABLE}.<prop>)` in the `DO UPDATE`, so a caller that omits them "
            "no longer leaves them alone — it writes NULL over them or resets them"
        )
    if not failures:
        notes.append(
            f"the wide door still preserves: {len(props)} properties, none with a `default`, all "
            f"COALESCEd against {TABLE}"
        )


# ── Postgres plumbing ────────────────────────────────────────────────────────────────────


def docker_available() -> bool:
    try:
        res = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER],
            capture_output=True,
            text=True,
        )
    except FileNotFoundError:
        return False
    return res.returncode == 0 and res.stdout.strip() == "true"


def psql(args: list[str], db: str | None = None, stdin: str | None = None) -> str:
    cmd = ["docker", "exec", "-i", CONTAINER, "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres"]
    if db:
        cmd += ["-d", db]
    res = subprocess.run(cmd + args, input=stdin, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout


def literal(value) -> str:
    """Mirrors the runtime's bind: a JSON boolean lands in an INTEGER column as 0/1 (hub#208)."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(r"(?<![:\w]):([a-z_][a-z0-9_]*)", lambda m: literal(params.get(m.group(1))), sql)


def apply_defaults(schema: dict, payload: dict) -> dict:
    """`registry.rs::apply_defaults` (ADR-0073): the runtime materialises the declared `default`
    of every key the caller left out. In THIS module none is declared — which is exactly what
    layer 4 keeps true."""
    out = dict(payload)
    for key, prop in (schema.get("properties") or {}).items():
        if key not in out and isinstance(prop, dict) and "default" in prop:
            out[key] = prop["default"]
    return out


def run_command(name: str, payload: dict, hub: str, user: str, now: str, new_id: str) -> int:
    params = {
        **apply_defaults(schema_of(name), payload),
        "new_id": new_id,
        "hub_id": hub,
        "current_user_id": user,
        "now": now,
    }
    affected = 0
    for rel in command(name)["sql"]:
        out = psql([], db=DB, stdin=bind((MODULE_DIR / rel).read_text(), params))
        for line in out.splitlines():
            tag = line.strip().split()
            if tag and tag[0] in ("INSERT", "UPDATE", "DELETE"):
                affected += int(tag[-1])
    return affected


def settings_row(hub: str) -> dict | None:
    out = psql(
        ["-t", "-A", "-c", f"SELECT row_to_json(t) FROM {TABLE} t WHERE hub_id = {literal(hub)}"],
        db=DB,
    ).strip()
    return json.loads(out) if out else None


def seed_configured(hub: str, new_id: str) -> dict:
    run_command(UPSERT, dict(CONFIGURED), hub, "u-owner", NOW, new_id)
    row = settings_row(hub)
    if row is None:
        raise RuntimeError(f"seeding {hub} through {UPSERT} left no row")
    return row


def diff(before: dict, after: dict, ignore: set[str]) -> dict:
    return {k: (before[k], after.get(k)) for k in before if k not in ignore and after.get(k) != before[k]}


# ── Layer 2: the row is not clobbered ────────────────────────────────────────────────────


def check_seed_differs_from_every_factory_value() -> None:
    """Anchors layer 2 in the other direction: a column seeded AT its factory value could be
    reset by a widened write without the comparison seeing anything. The factory values live in
    the `COALESCE(:bind, <n>)` fallbacks of the INSERT branch of the wide upsert."""
    fallbacks = dict(
        re.findall(
            r"COALESCE\s*\(\s*:([a-z_][a-z0-9_]*)\s*,\s*(\d+)\s*\)",
            strip_comments(sql_text(UPSERT)),
        )
    )
    for key in (schema_of(UPSERT).get("properties") or {}):
        if key not in CONFIGURED:
            fail(f"this test's restaurant does not configure {key!r}: a widened write could reset it unseen")
        elif key in fallbacks:
            seeded = 1 if CONFIGURED[key] is True else 0 if CONFIGURED[key] is False else CONFIGURED[key]
            if seeded == int(fallbacks[key]):
                fail(
                    f"this test's restaurant leaves {key!r} at its factory value {fallbacks[key]}: "
                    "pick a different one or layer 2 stops proving anything for that column"
                )


def check_narrow_write_leaves_the_rest_alone() -> None:
    hub = "hub-narrow"
    before = seed_configured(hub, "set-narrow")
    affected = run_command(NARROW, {FLAG: False}, hub, "u-whatsapp", LATER, "set-narrow-new")
    after = settings_row(hub)
    if affected != 1:
        fail(f"{NARROW}: affected {affected} row(s) on an existing settings row, expected 1")
    if after is None:
        fail(f"{NARROW}: the settings row is gone after the write")
        return
    if after[FLAG] != 0:
        fail(f"{NARROW}: {FLAG} is {after[FLAG]!r} after asking for false")
    clobbered = diff(before, after, ignore={FLAG, "updated_at", "updated_by"})
    if clobbered:
        fail(
            f"{NARROW}: flipping one switch changed {len(clobbered)} other column(s) — "
            + ", ".join(f"{k}: {was!r} -> {now!r}" for k, (was, now) in sorted(clobbered.items()))
        )
    if after.get("updated_at") != LATER or after.get("updated_by") != "u-whatsapp":
        fail(
            f"{NARROW}: the audit trail was not refreshed "
            f"(updated_at={after.get('updated_at')!r}, updated_by={after.get('updated_by')!r})"
        )
    notes.append(f"{NARROW} on a configured restaurant: only {FLAG} + audit moved")


def check_the_comparison_can_see_a_change() -> None:
    """Unlike Citas, the wide door here does NOT clobber (that is this issue's corrected premise),
    so the control cannot be «the other door wipes». It is «this comparison can see a write at
    all»: a wide write that NAMES one other field must show up as a difference. Without it, a
    comparison that silently compares nothing would keep layer 2 green forever."""
    hub = "hub-control"
    before = seed_configured(hub, "set-control")
    run_command(UPSERT, {"time_slot_duration": 15}, hub, "u-owner", LATER, "set-control-new")
    after = settings_row(hub)
    seen = diff(before, after or {}, ignore={"updated_at", "updated_by"})
    if list(seen) != ["time_slot_duration"]:
        fail(
            f"control: a wide write naming ONLY `time_slot_duration` shows up as {sorted(seen)}. "
            "Expected exactly that one column: if it is empty this file's comparison sees nothing "
            "and layer 2 proves nothing; if it is more, the wide door clobbers after all and the "
            "corrected premise of reservations#53 is wrong"
        )
        return
    notes.append(
        "control — a wide write naming one field moves exactly that field "
        f"({before['time_slot_duration']} -> {after['time_slot_duration']}), so the comparison sees writes"
    )


# ── Layer 3: the hub that never saved settings ───────────────────────────────────────────


def check_creates_the_singleton_like_upsert_would() -> None:
    narrow_hub, control_hub = "hub-fresh-narrow", "hub-fresh-control"
    affected = run_command(NARROW, {FLAG: True}, narrow_hub, "u-whatsapp", LATER, "set-fresh")
    run_command(UPSERT, {}, control_hub, "u-owner", LATER, "set-fresh-control")
    created, control = settings_row(narrow_hub), settings_row(control_hub)
    if affected != 1:
        fail(f"{NARROW}: affected {affected} row(s) on a hub with no settings, expected 1")
    if created is None:
        fail(
            f"{NARROW}: a hub that never saved its settings has no row, so the write matched "
            "nothing and the switch cannot be flipped at all"
        )
        return
    if created[FLAG] != 1:
        fail(
            f"{NARROW}: the singleton was created with {FLAG}={created[FLAG]!r} instead of the "
            "value that was asked for (a factory DEFAULT is not an answer to a request). This one "
            "asks for TRUE on purpose: the column's factory value is 0, so a DEFAULT here cannot "
            "pass by accident"
        )
    if control is None:
        fail(f"control: `{UPSERT}` with an empty form left no row")
        return
    drift = diff(control, created, ignore={FLAG, "id", "hub_id"} | AUDIT_COLUMNS)
    if drift:
        fail(
            f"{NARROW}: the singleton it creates differs from the one `{UPSERT}` writes from an "
            "empty form — "
            + ", ".join(f"{k}: {ctl!r} vs {new!r}" for k, (ctl, new) in sorted(drift.items()))
        )
    notes.append(f"{NARROW} on a fresh hub: singleton created with the same factory values as `{UPSERT}`")


# ── Layer 5: tenancy and soft-delete ─────────────────────────────────────────────────────


def check_write_stays_in_its_hub() -> None:
    mine, neighbour = "hub-mine", "hub-neighbour"
    seed_configured(mine, "set-mine")
    before = seed_configured(neighbour, "set-neighbour")
    run_command(NARROW, {FLAG: False}, mine, "u-whatsapp", LATER, "set-mine-new")
    after = settings_row(neighbour)
    if after != before:
        fail(
            f"{NARROW}: writing hub {mine!r} changed hub {neighbour!r} — "
            + ", ".join(sorted(diff(before, after or {}, ignore=set())))
        )
    notes.append(f"{NARROW}: the neighbour hub's settings are untouched")


def check_soft_deleted_row_is_refused() -> None:
    hub = "hub-deleted"
    seed_configured(hub, "set-deleted")
    psql(["-c", f"UPDATE {TABLE} SET is_deleted = 1 WHERE hub_id = {literal(hub)}"], db=DB)
    affected = run_command(NARROW, {FLAG: False}, hub, "u-whatsapp", LATER, "set-deleted-new")
    row = settings_row(hub)
    if affected != 0:
        fail(
            f"{NARROW}: wrote into a soft-deleted settings row ({affected} row(s)). That row is "
            f"invisible to `reservations.settings.get`, so the flip would be silently lost; "
            "`expect_rows` must see 0 and turn it into the declared error"
        )
    if row is not None and row[FLAG] != 1:
        fail(f"{NARROW}: the soft-deleted row was modified anyway ({FLAG}={row[FLAG]!r})")
    notes.append(f"{NARROW}: a soft-deleted singleton affects 0 rows → the `expect_rows` error")


# ── Runner ───────────────────────────────────────────────────────────────────────────────


def check_against_postgres() -> None:
    if not docker_available():
        notes.append(
            f"SKIPPED Postgres layers: container {CONTAINER!r} is not running "
            "(the contract layers above still ran)"
        )
        return
    if not command(NARROW).get("sql"):
        notes.append(f"SKIPPED Postgres layers: `{NARROW}` declares no SQL to run")
        return
    psql(["-c", f'DROP DATABASE IF EXISTS "{DB}"'])
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for entry in MANIFEST["migrations"]["postgres"]:
            rel = entry if isinstance(entry, str) else entry["file"]
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text())
        notes.append(
            f"scratch database {DB} built from {len(MANIFEST['migrations']['postgres'])} migrations"
        )
        check_narrow_write_leaves_the_rest_alone()
        check_the_comparison_can_see_a_change()
        check_creates_the_singleton_like_upsert_would()
        check_write_stays_in_its_hub()
        check_soft_deleted_row_is_refused()
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}"'])


def main() -> int:
    check_command_is_declared()
    check_payload_is_one_boolean()
    check_expect_rows_error_is_translated()
    check_sql_touches_nothing_else()
    check_wide_door_still_preserves()
    check_seed_differs_from_every_factory_value()
    check_against_postgres()

    for note in notes:
        print(f"  · {note}")
    print()
    if failures:
        print(f"FAILED — {len(failures)} break(s) in the narrow settings write (reservations#53):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        f"PASS — reservations v{MANIFEST.get('version')}: `{NARROW}` flips one switch, leaves the "
        "other twelve settings alone, and the wide door still cannot clobber them"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
