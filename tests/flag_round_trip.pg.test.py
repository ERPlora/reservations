#!/usr/bin/env python3
"""reservations#54 — a row this module HANDS BACK must be a row this module ACCEPTS.

WHY THIS FILE EXISTS. `reservations.settings.get` returned the five toggles as the INTEGER they
are stored as, while `reservations.settings.upsert` declares them `boolean`, so the most ordinary
operation an API has — read the row, change one field, save it back — died in validation:

    POST /api/query   {"name":"reservations.settings.get"}
    → {"auto_confirm":1, "require_phone":0, "send_reminder_email":1, …}

    POST /api/command {"name":"reservations.settings.upsert","payload":<the same row>}
    → 422  /auto_confirm: 1 is not of type "boolean","null"

The screen never noticed: the Settings tab is painted FROM the schema, so the form always sent
booleans. Everything that reads before it writes ate it — the assistant, the flows, the public
API, any configuration script. The textbook «works through the UI, fails through the door next
to it». The same asymmetry was in `blocked_dates` (`is_full_day`) and in the waiting list
(`is_contacted`, `is_converted`), which is why the guard below is a RULE and not two patches.

THE CONVENTION THIS FILE PINS (the one appointments#79 already settled). One idea, one type at
each boundary:

  * AT REST the flag is `INTEGER` 0/1. That is the hub's row contract (§2.5 / ADR-0007) and it
    does not move: the portable DDL has no BOOLEAN, and counters share the same column type.
  * ON THE WIRE the flag is a JSON `boolean`, in BOTH directions. The write schemas already said
    so; the reads now say the same by projecting `col <> 0`, so a read's output validates against
    the write's schema.

Both halves are first-class in the runtime, which is why this costs nothing at the edges
(`hub/crates/db/src/lib.rs`): writing, `Json::Bool(b) => q.bind(if *b {1} else {0})` (hub#208 /
ADR-0154); reading, a boolean SQL expression comes back as JSON `true`/`false` while an INTEGER
column always comes back as a JSON number.

WHAT IS CHECKED, in three layers:

  1. THE GUARD (no container, always runs). Every property that any command schema declares
     `boolean` is a flag. No query may hand that name back as the bare INTEGER column — that is
     precisely the defect, and it is a PATTERN, so it is checked for every query of the manifest
     and not only for the ones the issue happened to name. A query added tomorrow with a raw flag
     in its SELECT fails here (root CLAUDE.md, «cero regresiones»: the fix ships the rule, not
     only the patch).

  2. THE ROUND-TRIP (real Postgres). Against a throwaway database built from this module's own
     migrations: run the REAL write SQL, read it back with the REAL query, serialise the row the
     way the runtime does (`row_to_json`: int8 → number, bool → true/false) and validate it
     against the write command's JSON Schema. Green means read → edit → save actually works.

  3. THE FILTER STILL FILTERS. This is the trap the projection change walks into, and the reason
     this file is not a copy of its appointments sibling. The list engine compares a filter as
     TEXT (`crates/runtime/src/queries.rs`: `CAST(sub.<col> AS TEXT) = CAST(:f_<col> AS TEXT)`),
     and `CAST(true AS TEXT)` is `'true'`, not `'1'`. A `filterType: 'select'` box still offering
     `value: '1'` over a column that now answers `true` matches NOTHING — and an empty table
     looks exactly like «no rows found». hub#1182 closed with the rule that a filter that does
     not filter cannot go green again; this layer is that rule for the flags: the closed domain
     the box offers must BE the domain the query answers, asked of a real Postgres.

It refuses to skip its own assertion. Without `jsonschema` the round-trip layer FAILS instead of
excusing itself — a validation test that skips is a green light for nothing (module-toolkit#50).
The gate hands over a python that has it through `ERPLORA_PYTHON`.

Usage: tests/flag_round_trip.pg.test.py   (exit 0 = green)
  Uses the `erplora-test-pg-5433` container (override: ERPLORA_TEST_PG_CONTAINER). Creates a
  throwaway database and DROPS it at the end, pass or fail. Without the container the Postgres
  layers are SKIPPED — never counted as passed. The guard layer runs regardless.
"""

import json
import os
import pathlib
import re
import subprocess
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))

CONTAINER = os.environ.get("ERPLORA_TEST_PG_CONTAINER", "erplora-test-pg-5433")
DB = f"reservations_flag_round_trip_test_{os.getpid()}"
HUB = "hub-under-test"
USER = "u-1"
NOW = "2026-09-10T09:00:00+02:00"

SETTINGS_GET = "reservations.settings.get"
SETTINGS_UPSERT = "reservations.settings.upsert"

#: The toggles as the form sends them — deliberately MIXED, so a read that answered a constant
#: (or that got the two halves of `<> 0` backwards) cannot pass by accident.
SETTINGS_FLAGS = {
    "auto_confirm": True,
    "require_phone": False,
    "require_email": True,
    "send_confirmation_email": True,
    "send_reminder_email": False,
}

failures: list[str] = []
notes: list[str] = []


def fail(msg: str) -> None:
    failures.append(msg)


# ── manifest helpers ─────────────────────────────────────────────────────────────────────


def sql_of(command: str, index: int = 0) -> str:
    return MANIFEST["commands"][command]["sql"][index]


def query_sql(name: str) -> str:
    return MANIFEST["queries"][name]["sql"]


def schema_of(command: str) -> dict:
    rel = MANIFEST["commands"][command]["schema"]
    return json.loads((MODULE_DIR / rel).read_text(encoding="utf-8"))


def declares_boolean(decl: object) -> bool:
    """`{"type": "boolean"}` and `{"type": ["boolean", "null"]}` are the same promise.

    The nullable form is the one the WIDE settings form uses (there NULL means «leave this one
    alone»), and it is the majority in this module — a guard that only understood the bare string
    would find NOTHING here and pass by looking in the wrong place.
    """
    if not isinstance(decl, dict):
        return False
    kind = decl.get("type")
    return kind == "boolean" or (isinstance(kind, list) and "boolean" in kind)


def flag_properties() -> dict[str, list[str]]:
    """Every property some command schema declares `boolean`, and who declares it."""
    flags: dict[str, list[str]] = {}
    for name, spec in MANIFEST.get("commands", {}).items():
        rel = spec.get("schema")
        if not isinstance(rel, str):
            continue
        path = MODULE_DIR / rel
        if not path.exists():
            continue
        schema = json.loads(path.read_text(encoding="utf-8"))
        for prop, decl in (schema.get("properties") or {}).items():
            if declares_boolean(decl):
                flags.setdefault(prop, []).append(name)
    return flags


# ── SELECT-list parsing ──────────────────────────────────────────────────────────────────

# A bare column reference: `is_full_day` or `bd.is_full_day`, and nothing else.
BARE_COLUMN_RE = re.compile(r"^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$", re.I)


def _strip_noise(sql: str) -> str:
    """Line comments and single-quoted literals out of the way, so neither a `--` nor a
    `', '` can be mistaken for SQL structure while scanning parentheses."""
    sql = re.sub(r"--[^\n]*", " ", sql)
    return re.sub(r"'(?:[^']|'')*'", "''", sql)


def output_select(sql: str) -> str | None:
    """The SELECT list the query actually ANSWERS with: the last one at parenthesis depth 0.

    It has to be that one and not the first: a query that opens with a `WITH cfg AS (SELECT …)`
    would otherwise be audited on its plumbing instead of on the row that leaves the module.
    """
    clean = _strip_noise(sql)
    depth, start = 0, None
    for match in re.finditer(r"\(|\)|\bSELECT\b", clean, re.I):
        token = match.group(0)
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
        elif depth == 0:
            start = match.end()
    if start is None:
        return None
    depth = 0
    for match in re.finditer(r"\(|\)|\bFROM\b", clean[start:], re.I):
        token = match.group(0)
        if token == "(":
            depth += 1
        elif token == ")":
            depth -= 1
        elif depth == 0:
            return clean[start : start + match.start()]
    return clean[start:]


def select_items(sql: str) -> dict[str, str]:
    """Output column name → the expression that produces it (top-level commas only)."""
    body = output_select(sql)
    if body is None:
        return {}
    items: dict[str, str] = {}
    depth, current = 0, ""
    for char in body:
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        if char == "," and depth == 0:
            _add_item(items, current)
            current = ""
        else:
            current += char
    _add_item(items, current)
    return items


def _add_item(items: dict[str, str], raw: str) -> None:
    """Records output name → the expression WITHOUT its alias clause.

    Dropping the `AS x` matters: the check below asks whether the expression is a bare column,
    and `is_full_day AS is_full_day` is not literally bare while being exactly the defect.
    """
    expr = " ".join(raw.split())
    if not expr:
        return
    alias = re.search(r"\bAS\s+([a-z_][a-z0-9_]*)$", expr, re.I)
    if alias:
        name = alias.group(1)
        expr = expr[: alias.start()].strip()
    else:
        name = expr.split(".")[-1]
    items[name.strip()] = expr


# ── Layer 1: the guard ───────────────────────────────────────────────────────────────────


def check_no_query_returns_a_raw_flag() -> None:
    """A flag leaves this module as a JSON boolean. A bare INTEGER column cannot do that."""
    flags = flag_properties()
    if not flags:
        fail(
            "no command schema declares a `boolean` property — either the schemas changed shape "
            "or this guard is looking in the wrong place; it must never pass by finding nothing"
        )
        return
    notes.append(
        f"flags under contract: {', '.join(sorted(flags))} "
        f"({len(MANIFEST.get('queries', {}))} queries scanned)"
    )
    for name, spec in sorted(MANIFEST.get("queries", {}).items()):
        rel = spec.get("sql")
        if not isinstance(rel, str):
            continue
        path = MODULE_DIR / rel
        if not path.exists():
            fail(f"queries.{name}.sql: {rel!r} is not in the package")
            continue
        for column, expr in select_items(path.read_text(encoding="utf-8")).items():
            if column not in flags:
                continue
            if BARE_COLUMN_RE.match(expr):
                fail(
                    f"queries.{name} ({rel}): projects {column!r} as the bare INTEGER column, so "
                    f"it answers 0/1 — but {', '.join(flags[column])} declares {column!r} as "
                    f"`boolean`, so the row it hands back cannot be sent back in. Project it as a "
                    f"boolean: `{column} <> 0 AS {column}`"
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
    cmd += args
    res = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    if res.returncode != 0:
        raise RuntimeError(res.stderr.strip() or res.stdout.strip())
    return res.stdout


def literal(value) -> str:
    """Mirrors the runtime's bind: a JSON boolean reaches an INTEGER column as 0/1 (hub#208)."""
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    return "'" + str(value).replace("'", "''") + "'"


def bind(sql: str, params: dict) -> str:
    return re.sub(
        r"(?<![:\w]):([a-z_][a-z0-9_]*)", lambda m: literal(params.get(m.group(1))), sql
    )


def run_sql_file(rel: str, params: dict) -> None:
    psql([], db=DB, stdin=bind((MODULE_DIR / rel).read_text(encoding="utf-8"), params))


def base_of(rel: str, params: dict) -> str:
    """The query's SQL with its binds resolved, ready to be wrapped as a derived table."""
    return bind((MODULE_DIR / rel).read_text(encoding="utf-8"), params).rstrip().rstrip(";")


def run_query(rel: str, params: dict) -> list[dict]:
    """The rows AS THE RUNTIME HANDS THEM OVER: `row_to_json` maps int8 → JSON number and
    bool → JSON true/false, exactly like `crates/db/src/lib.rs` does per column type."""
    out = psql(["-t", "-A", "-c", f"SELECT row_to_json(r) FROM ({base_of(rel, params)}) r"], db=DB)
    return [json.loads(line) for line in out.splitlines() if line.strip()]


# ── Layer 2: the round-trip ──────────────────────────────────────────────────────────────


def validate(payload: dict, schema: dict, what: str) -> None:
    import jsonschema

    errors = sorted(
        jsonschema.Draft202012Validator(schema).iter_errors(payload),
        key=lambda e: list(e.absolute_path),
    )
    for err in errors:
        where = "/".join(str(p) for p in err.absolute_path) or "<root>"
        fail(f"{what}: /{where}: {err.message}")


def check_settings_round_trip() -> None:
    """Save the form the way the shell does, read it back, save THAT. The symptom of #54."""
    rows = run_query(query_sql(SETTINGS_GET), {"hub_id": HUB})
    if len(rows) != 1:
        fail(f"{SETTINGS_GET}: expected the singleton row, got {len(rows)}")
        return
    row = dict(rows[0])
    notes.append(f"{SETTINGS_GET} → {json.dumps(row, sort_keys=True)}")
    for flag, sent in SETTINGS_FLAGS.items():
        if row.get(flag) != sent:
            fail(
                f"{SETTINGS_GET}: {flag!r} came back as {row.get(flag)!r} after the form saved "
                f"{sent!r} — the read has to answer the value that was written, as a boolean"
            )
    # The shell sends the snapshot back without the id — it is not in the form schema.
    row.pop("id", None)
    validate(row, schema_of(SETTINGS_UPSERT), f"{SETTINGS_GET} → {SETTINGS_UPSERT}")


def check_flag_values_are_accepted_back(query: str, rows: list[dict]) -> None:
    """Every flag in these rows must be a value the doors that take that name accept.

    Property by property, and not «the whole row against the whole schema», because a LIST row
    is wider than the write it feeds: the waiting list hands back eleven columns and
    `waitlist.update` takes three. Narrowing to the shared names asks exactly the question that
    matters — «is what you hand me for this name something you would take back?» — instead of
    reporting a dozen `additionalProperties` that were never part of the contract.
    """
    flags = flag_properties()
    for row in rows:
        for prop, value in row.items():
            if prop not in flags:
                continue
            for command in flags[prop]:
                decl = (schema_of(command).get("properties") or {}).get(prop)
                validate({prop: value}, {"properties": {prop: decl}}, f"{query} → {command}")
            if not isinstance(value, bool) and value is not None:
                fail(
                    f"{query}: {prop!r} came back as {value!r} ({type(value).__name__}); the "
                    f"doors that take {prop!r} declare it `boolean`"
                )


# ── Layer 3: the filter still filters ────────────────────────────────────────────────────

#: `filterType: 'select'` box → the values it offers, read from the Web Component that paints it.
SELECT_OPTIONS_RE = re.compile(r"\{\s*value:\s*'([^']*)'\s*,\s*label:")


def balanced_slice(src: str, open_at: int) -> str:
    """The text from the brace at `open_at` to the one that closes it, brace-counted.

    Cutting on the next `},` — what an eyeballed regex does — stops INSIDE the `options` array,
    so a two-value box reads as a one-value box and the check compares half a domain against a
    whole one (measured writing this file: it reported `['1']` for a box offering `'1'`/`'0'`).
    """
    depth = 0
    for i in range(open_at, len(src)):
        if src[i] == "{":
            depth += 1
        elif src[i] == "}":
            depth -= 1
            if depth == 0:
                return src[open_at : i + 1]
    return src[open_at:]


def enclosing_brace(src: str, pos: int) -> int:
    """Index of the innermost `{` still open at `pos`, or -1 when `pos` sits inside no object."""
    open_braces: list[int] = []
    for i in range(pos):
        if src[i] == "{":
            open_braces.append(i)
        elif src[i] == "}" and open_braces:
            open_braces.pop()
    return open_braces[-1] if open_braces else -1


def select_filter_options() -> dict[str, list[str]]:
    """`column -> the values its select box offers`, for every flag column a component filters.

    Read from the components rather than declared here, so a box that changes its options without
    changing the query is caught by the same run that would have blessed it.
    """
    flags = flag_properties()
    found: dict[str, list[str]] = {}
    for path in sorted((MODULE_DIR / "ui").rglob("*.ts")):
        if path.name.endswith(".test.ts"):
            continue
        src = path.read_text(encoding="utf-8")
        for match in re.finditer(r"key:\s*'(\w+)'", src):
            column = match.group(1)
            if column not in flags:
                continue
            start = enclosing_brace(src, match.start())
            if start < 0:
                continue
            block = balanced_slice(src, start)
            if "filterType: 'select'" not in block:
                continue
            values = SELECT_OPTIONS_RE.findall(block)
            if values:
                found.setdefault(column, []).extend(values)
    return found


def query_that_filters(column: str) -> str | None:
    """The single query whose `list.filters` concedes an `eq` on this column.

    If two conceded it, the box could not be checked without knowing which table paints it, and
    guessing is how a gate blesses the wrong query — so it says so and fails instead.
    """
    owners = [
        name
        for name, spec in MANIFEST.get("queries", {}).items()
        if (spec.get("list") or {}).get("filters", {}).get(column, {}).get("op") == "eq"
    ]
    if len(owners) == 1:
        return owners[0]
    if not owners:
        fail(
            f"the table paints a select filter on {column!r} but no query concedes `op: eq` on "
            f"it — the runtime drops the `f_{column}` it sends and the box does nothing (hub#1182)"
        )
        return None
    fail(
        f"{column!r} is filtered by more than one query ({', '.join(sorted(owners))}); teach this "
        "check which table the box belongs to before trusting it"
    )
    return None


def check_select_boxes_still_match(seeded: dict[str, dict]) -> None:
    """The domain the box offers must BE the domain the query answers, asked of Postgres.

    Built exactly like `crates/runtime/src/queries.rs` builds it, because the whole point is that
    the comparison happens as TEXT: `CAST(true AS TEXT)` is `'true'`, so a box still offering
    `'1'` silently answers an empty table.
    """
    boxes = select_filter_options()
    if not boxes:
        fail(
            "no select filter over a flag column was found in ui/ — this module paints two "
            "(`is_full_day`, `is_contacted`); a discovery that finds none is broken, not clean"
        )
        return
    for column, offered in sorted(boxes.items()):
        query = query_that_filters(column)
        if query is None:
            continue
        fixture = seeded.get(query)
        if fixture is None:
            fail(
                f"the select box on {column!r} filters {query}, and this check has no rows seeded "
                f"for it: teach it the fixture instead of letting the box go unchecked"
            )
            continue
        base = base_of(query_sql(query), fixture["params"])
        answered = sorted(
            line.strip()
            for line in psql(
                ["-t", "-A", "-c", f"SELECT DISTINCT CAST(sub.{column} AS TEXT) FROM ({base}) AS sub"],
                db=DB,
            ).splitlines()
            if line.strip()
        )
        if answered != sorted(set(offered)):
            fail(
                f"{query}: the box on {column!r} offers {sorted(set(offered))} but the query "
                f"answers {answered} — the engine compares them as text "
                f"(`CAST(sub.{column} AS TEXT) = CAST(:f_{column} AS TEXT)`), so every option is "
                f"a funnel that empties the table (hub#1182)"
            )
            continue
        for value in sorted(set(offered)):
            hits = psql(
                [
                    "-t",
                    "-A",
                    "-c",
                    f"SELECT COUNT(*) FROM ({base}) AS sub "
                    f"WHERE CAST(sub.{column} AS TEXT) = CAST('{value}' AS TEXT)",
                ],
                db=DB,
            ).strip()
            if hits == "0":
                fail(
                    f"{query}: filtering {column!r} by the option {value!r} answers no row, and "
                    f"the fixture has one on each side — the box is a dead funnel"
                )
        notes.append(f"{query}: box on {column!r} offers {sorted(set(offered))}, and each one hits")


# ── The fixture ──────────────────────────────────────────────────────────────────────────


def seed() -> dict[str, dict]:
    """Writes through the REAL command SQL, one row on each side of every flag."""
    run_sql_file(
        sql_of(SETTINGS_UPSERT),
        {
            "new_id": "set-1",
            "hub_id": HUB,
            "time_slot_duration": 30,
            "min_party_size": 1,
            "max_party_size": 20,
            "min_advance_hours": 1,
            "max_advance_days": 30,
            "no_show_window_minutes": 15,
            "default_duration_minutes": 120,
            "reminder_hours_before": 24,
            "current_user_id": USER,
            "now": NOW,
            **SETTINGS_FLAGS,
        },
    )
    blocked = sql_of("reservations.blocked_dates.create")
    run_sql_file(
        blocked,
        {
            "new_id": "blk-full",
            "hub_id": HUB,
            "date": "2026-12-25",
            "reason": "Navidad",
            "is_full_day": True,
            "blocked_from": None,
            "blocked_until": None,
            "current_user_id": USER,
            "now": NOW,
        },
    )
    run_sql_file(
        blocked,
        {
            "new_id": "blk-partial",
            "hub_id": HUB,
            "date": "2026-12-24",
            "reason": "Nochebuena, solo cenas",
            "is_full_day": False,
            "blocked_from": "13:00:00",
            "blocked_until": "17:00:00",
            "current_user_id": USER,
            "now": NOW,
        },
    )
    waitlist = sql_of("reservations.waitlist.create")
    for entry_id, name in (("wl-pending", "Ana"), ("wl-contacted", "Bruno")):
        run_sql_file(
            waitlist,
            {
                "new_id": entry_id,
                "hub_id": HUB,
                "customer_id": None,
                "guest_name": name,
                "guest_phone": "600100200",
                "guest_email": "",
                "date": "2026-12-31",
                "preferred_time": "21:00:00",
                "party_size": 4,
                "notes": "",
                "current_user_id": USER,
                "now": NOW,
            },
        )
    # The «contacted» side goes in through the command the WASM handler dispatches to, not through
    # a hand-written UPDATE: seeding past the real write is how a fixture starts proving nothing.
    run_sql_file(
        sql_of("reservations._waitlist_update"),
        {
            "entry_id": "wl-contacted",
            "hub_id": HUB,
            "is_contacted": True,
            "is_converted": None,
            "notes": None,
            "current_user_id": USER,
            "now": NOW,
        },
    )
    return {
        "reservations.blocked_dates.list": {"params": {"hub_id": HUB}},
        "reservations.waitlist.list": {"params": {"hub_id": HUB}},
    }


def check_against_postgres() -> None:
    if not docker_available():
        notes.append(
            f"SKIPPED Postgres layers: container {CONTAINER!r} is not running "
            "(the guard layer above still ran)"
        )
        return
    try:
        import jsonschema  # noqa: F401
    except ImportError:
        fail(
            "`jsonschema` is not importable, so the round-trip cannot be validated. This layer "
            "REFUSES to skip: hand over an interpreter that has it (ERPLORA_PYTHON), because a "
            "validation test that excuses itself is a green light for nothing"
        )
        return

    psql(["-c", f'DROP DATABASE IF EXISTS "{DB}"'])
    psql(["-c", f'CREATE DATABASE "{DB}"'])
    try:
        for entry in MANIFEST["migrations"]["postgres"]:
            rel = entry if isinstance(entry, str) else entry["file"]
            psql([], db=DB, stdin=(MODULE_DIR / rel).read_text(encoding="utf-8"))
        notes.append(
            f"scratch database built from {len(MANIFEST['migrations']['postgres'])} migrations"
        )
        seeded = seed()
        check_settings_round_trip()
        for query, fixture in sorted(seeded.items()):
            rows = run_query(query_sql(query), fixture["params"])
            if not rows:
                fail(f"{query}: the fixture seeded rows and the query answered none")
                continue
            notes.append(f"{query} → {len(rows)} row(s)")
            check_flag_values_are_accepted_back(query, rows)
        on_date = run_query(
            query_sql("reservations.blocked_dates.on_date"),
            {"hub_id": HUB, "date": "2026-12-25"},
        )
        check_flag_values_are_accepted_back("reservations.blocked_dates.on_date", on_date)
        check_select_boxes_still_match(seeded)
    finally:
        psql(["-c", f'DROP DATABASE IF EXISTS "{DB}"'])


# ── Runner ───────────────────────────────────────────────────────────────────────────────


def main() -> int:
    check_no_query_returns_a_raw_flag()
    check_against_postgres()

    for note in notes:
        print(f"  · {note}")
    print()
    if failures:
        print(f"FAILED — {len(failures)} break(s) in the flag round-trip (reservations#54):")
        for f in failures:
            print(f"  - {f}")
        return 1
    print(
        f"PASS — reservations v{MANIFEST.get('version')}: every flag crosses the wire as a JSON "
        "boolean, what the reads hand back validates against the writes that take it, and the "
        "select boxes still answer rows"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
