#!/usr/bin/env python3
"""`reservations.settings.upsert` must PARSE on Postgres (reservations#19).

Why this file exists: `commands/settings_upsert.sql` referenced its own columns UNQUALIFIED
inside `ON CONFLICT (hub_id) DO UPDATE SET` (`time_slot_duration = COALESCE(:x,
time_slot_duration)`). In Postgres that name is ambiguous between the target table and the
`excluded` pseudo-table, so the statement does not even parse: EVERY call to
`reservations.settings.upsert` failed — including the lazy creation of the settings row, which
is the first thing the module does. SQLite tolerated it, Postgres never did, and since ADR-0154
the module only ships a `postgres` dialect.

`erplora validate` did NOT catch it: its `onconflict-unqualified` rule only sees the direct
`col = col + 1` shape, not `col = COALESCE(:bind, col)`. So the gate is here, against a real
Postgres — the same class of bug that shipped broken in ERPlora/whatsapp_inbox (ERPlora/pm#107).

What it does: builds a scratch database from THIS module's own migrations, lowers the named
binds `:name` to `$n` exactly like the runtime does (`hub/crates/db/src/lib.rs::translate`) and
asks Postgres to PREPARE the statement. Preparing is what the runtime does on every call, so a
statement that cannot be prepared is a command that can never run. Zero mocks.

Usage: tests/settings_upsert.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container by default (override:
  ERPLORA_TEST_PG_CONTAINER). Creates a scratch database and DROPS it at the end, pass or fail.
  If Docker or the container is missing the check is SKIPPED, never passed.
"""

import json
import os
import pathlib
import subprocess
import sys
import uuid

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text())
CONTAINER = os.environ.get("ERPLORA_TEST_PG_CONTAINER", "erplora-test-pg-5433")

# The command under test and the file that broke. Kept explicit (not "every SQL of the manifest")
# so a future unrelated statement cannot silently turn this regression test off.
COMMAND = "reservations.settings.upsert"
SQL_FILE = "commands/settings_upsert.sql"


def translate(sql):
    """Lower `:name` to `$n` like the runtime does.

    Mirrors `hub/crates/db/src/lib.rs::translate`: index by order of FIRST appearance, a repeated
    name reuses its index, `::` is the Postgres cast (never a bind), and `:name` inside a string
    literal or a comment is left verbatim — the runtime emits comments untouched, and translating
    a bind that only lives in a comment would create a phantom `$n`.
    """
    out, names, i, in_string = [], [], 0, False
    while i < len(sql):
        c = sql[i]
        if in_string:
            out.append(c)
            if c == "'":
                in_string = False
            i += 1
            continue
        if c == "'":
            in_string = True
            out.append(c)
            i += 1
            continue
        if sql[i : i + 2] == "--":
            j = sql.find("\n", i)
            j = len(sql) if j < 0 else j
            out.append(sql[i:j])
            i = j
            continue
        if sql[i : i + 2] == "/*":
            j = sql.find("*/", i + 2)
            j = len(sql) if j < 0 else j + 2
            out.append(sql[i:j])
            i = j
            continue
        if sql[i : i + 2] == "::":
            out.append("::")
            i += 2
            continue
        if c == ":":
            j = i + 1
            while j < len(sql) and (sql[j].isalnum() or sql[j] == "_"):
                j += 1
            name = sql[i + 1 : j]
            if name:
                if name not in names:
                    names.append(name)
                out.append(f"${names.index(name) + 1}")
                i = j
                continue
        out.append(c)
        i += 1
    return "".join(out), names


def docker_available():
    try:
        r = subprocess.run(
            ["docker", "exec", CONTAINER, "pg_isready", "-U", "postgres"],
            capture_output=True,
            text=True,
            timeout=30,
        )
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def psql(db, sql):
    return subprocess.run(
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
        ],
        input=sql,
        capture_output=True,
        text=True,
    )


def main():
    spec = MANIFEST["commands"][COMMAND]
    files = spec["sql"] if isinstance(spec["sql"], list) else [spec["sql"]]
    assert SQL_FILE in files, f"{COMMAND} no longer runs {SQL_FILE}: {files}"

    if not docker_available():
        print(f"SKIPPED: no Postgres in container {CONTAINER} (nothing was verified)")
        return 0

    db = f"reservations_settings_upsert_{uuid.uuid4().hex[:8]}"
    subprocess.run(
        ["docker", "exec", CONTAINER, "createdb", "-U", "postgres", db], check=True
    )
    try:
        for rel in MANIFEST["migrations"]["postgres"]:
            r = psql(db, (MODULE_DIR / rel).read_text())
            if r.returncode != 0:
                print(f"FAIL: migration {rel} does not apply\n{r.stderr}")
                return 1

        failed = 0
        for rel in files:
            sql, _names = translate((MODULE_DIR / rel).read_text())
            r = psql(db, f"PREPARE stmt AS {sql};\nDEALLOCATE stmt;\n")
            if r.returncode != 0:
                error = " ".join(
                    x for x in r.stderr.splitlines() if x.startswith("ERROR")
                )
                print(f"FAIL: Postgres cannot prepare {rel}\n    {error}")
                failed += 1
        if failed:
            return 1
        print(f"OK: Postgres prepares every statement of {COMMAND}")
        return 0
    finally:
        subprocess.run(
            ["docker", "exec", CONTAINER, "dropdb", "-U", "postgres", "--force", db]
        )


if __name__ == "__main__":
    sys.exit(main())
