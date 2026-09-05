#!/usr/bin/env python3
"""Every gate of `reservations__gate` refuses UNDER ITS OWN NAME (reservations#42).

`migrations/postgres/002_gate.sql` created the guard table with the anonymous column check
`CHECK (ok = 1)`, which Postgres auto-names `reservations__gate_ok_check`. So the THREE gates of
this module all fail with the SAME primary message, and which one refused travels in the separate
DETAIL field of the wire protocol:

    ERROR:   new row for relation "reservations__gate" violates check constraint "reservations__gate_ok_check"
    DETAIL:  Failing row contains (reservation_available, 0, ).

DETAIL never reaches the caller: a refusal arrives as `sqlx::Error::Database` wrapping
`PgDatabaseError`, whose `Display` writes the PRIMARY message and nothing else and whose
`message()` does not carry DETAIL. That is why this file reads ONLY the primary `ERROR:` line and
throws DETAIL away — a test that looked at DETAIL would pass with the defect still in place.

`reason` (migration 003, reservations#31) does not close this: the abort row is rolled back with
the transaction, so the motive never leaves the database either.

What is asserted, on a REAL Postgres, over the END state of the declared migrations:

  1. the anonymous `reservations__gate_ok_check` is GONE — while it coexists with the named ones an
     `ok = 0` violates BOTH and Postgres may report either name;
  2. each gate's `ok = 0` names ITS OWN constraint in the primary message, and no other;
  3. a gate nobody declared fails CLOSED (the whitelist), instead of violating nothing and letting
     the command commit;
  4. the happy path (`ok = 1`) still commits for every declared gate;
  5. no drift: the gates the commands actually write == the named constraints == the whitelist.

Uses the `erplora-test-pg-5433` container (override: ERPLORA_TEST_PG_CONTAINER); scratch DB dropped
at the end. Missing Docker = SKIPPED, never PASS.
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
TABLE = "reservations__gate"
ANONYMOUS = f"{TABLE}_ok_check"  # the name Postgres gives `CHECK (ok = 1)` written without one
WHITELIST = f"{TABLE}_is_declared"

failures: list[str] = []


def check(label, expected, actual):
    if expected != actual:
        failures.append(f"{label} — expected [{expected}], got [{actual}]")
        print(f"  FAIL: {label} — expected [{expected}], got [{actual}]")
    else:
        print(f"  ok: {label} = {expected}")


def psql(db, sql, expect_error=False):
    r = subprocess.run(
        ["docker", "exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", db,
         "-v", "ON_ERROR_STOP=1", "-q", "-X", "-tA"],
        input=sql, capture_output=True, text=True,
    )
    if expect_error:
        return r.returncode, r.stderr
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout


def primary_message(db, sql):
    """The PRIMARY message of the refusal, which is all `PgDatabaseError::message()` carries.

    DETAIL is dropped on purpose and not by omission: it is the field that DOES name the gate today
    and the field the caller never sees, so a test that read it would go green with the defect in.
    Returns `None` when the statement did not fail — which is itself a failure worth reporting.
    """
    code, stderr = psql(db, sql, expect_error=True)
    if code == 0:
        return None
    for line in stderr.splitlines():
        if line.startswith("ERROR:"):
            return line[len("ERROR:"):].strip()
    return stderr.strip()


VIOLATED = re.compile(r'violates check constraint "([^"]+)"')


def refusing_constraint(db, gate, ok=0):
    """The constraint named in the primary message when `(gate, ok)` is rejected."""
    message = primary_message(
        db, f"INSERT INTO {TABLE} (gate, ok) VALUES ('{gate}', {ok});"
    )
    if message is None:
        return "<accepted: nothing refused it>"
    hit = VIOLATED.search(message)
    return hit.group(1) if hit else message


GATE_INSERT = re.compile(
    r"INSERT\s+INTO\s+" + TABLE + r"\s*\([^)]*\)\s*SELECT\s+'([a-z0-9_]+)'",
    re.IGNORECASE,
)


def gates_the_commands_write():
    """The gate names the module actually asserts on, read from `commands/`, never from the issue."""
    found = set()
    for sql_file in sorted((MODULE_DIR / "commands").glob("*.sql")):
        for gate in GATE_INSERT.findall(sql_file.read_text()):
            found.add(gate)
    return sorted(found)


def declared_migrations():
    """`migrations.postgres` normalised to paths — an entry is a path OR `{file, kind, since}`."""
    out = []
    for entry in MANIFEST["migrations"]["postgres"]:
        out.append(entry if isinstance(entry, str) else entry["file"])
    return out


def contract_migrations():
    return sorted(
        entry["file"]
        for entry in MANIFEST["migrations"]["postgres"]
        if not isinstance(entry, str) and entry.get("kind") == "contract"
    )


def constraints(db):
    """`name -> definition` of every CHECK on the guard table, as Postgres holds it."""
    rows = psql(
        db,
        "SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint "
        f"WHERE conrelid = '{TABLE}'::regclass AND contype = 'c' ORDER BY conname;",
    )
    out = {}
    for line in rows.strip().splitlines():
        name, _, definition = line.partition("|")
        out[name] = definition
    return out


def main() -> int:
    ready = subprocess.run(
        ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
        capture_output=True, text=True,
    )
    if ready.returncode != 0:
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    gates = gates_the_commands_write()
    print(f"\n== the gates the commands write: {gates} ==")
    check("the module asserts on 3 gates", 3, len(gates))

    print("\n== the DROP is declared, so the runtime is allowed to run it ==")
    check(
        "the migration that retires the anonymous check is declared `contract`",
        ["migrations/postgres/004_named_gate_constraints.sql"],
        contract_migrations(),
    )

    db = f"reservations_named_gates_{uuid.uuid4().hex[:8]}"
    subprocess.run(["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True)
    try:
        for rel in declared_migrations():
            psql(db, (MODULE_DIR / rel).read_text())

        live = constraints(db)

        print("\n== 1. the anonymous check is GONE, not kept on as a belt ==")
        check(
            f"{ANONYMOUS} no longer exists (both alive = either name may be reported)",
            False,
            ANONYMOUS in live,
        )

        print("\n== 2. every gate refuses under ITS OWN name, in the PRIMARY message ==")
        for gate in gates:
            check(f"`{gate}` with ok=0 is refused by the constraint named after it",
                  gate, refusing_constraint(db, gate))

        print("\n== 3. a gate nobody declared fails CLOSED (whitelist), not open ==")
        check("an undeclared gate with ok=0 is refused by the whitelist",
              WHITELIST, refusing_constraint(db, "gate_nobody_declared", ok=0))
        check("an undeclared gate with ok=1 is refused too (a typo cannot commit)",
              WHITELIST, refusing_constraint(db, "gate_nobody_declared", ok=1))

        print("\n== 4. the happy path still commits ==")
        for gate in gates:
            psql(db, f"INSERT INTO {TABLE} (gate, ok) VALUES ('{gate}', 1);")
        check("the three ok=1 rows are in",
              str(len(gates)), psql(db, f"SELECT COUNT(*) FROM {TABLE};").strip())
        psql(db, (MODULE_DIR / "commands/_gate_clear.sql").read_text())
        check("_gate_clear drains the table", "0",
              psql(db, f"SELECT COUNT(*) FROM {TABLE};").strip())

        print("\n== 5. no drift: commands == named constraints == whitelist ==")
        named = sorted(
            name for name, definition in live.items()
            if name != WHITELIST and re.search(r"\bok\b", definition) and re.search(r"\bgate\b", definition)
        )
        check("one named constraint per gate the commands write", gates, named)

        whitelisted = sorted(re.findall(r"'([a-z0-9_]+)'", live.get(WHITELIST, "")))
        check("the whitelist enumerates exactly those gates", gates, whitelisted)
    finally:
        subprocess.run(["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db])

    print()
    if failures:
        print(f"FAILED — {len(failures)} assertion(s):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print("PASS — every gate of reservations__gate refuses under its own name (reservations#42)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
