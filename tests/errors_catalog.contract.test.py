#!/usr/bin/env python3
"""Every error code this module can refuse with is declared, and speaks `en` and `es` (ADR-0398).

THE SYMPTOM (reservations#56). `erplora validate` warned on every PR and every release that the
module emits twelve domain error codes without an `errors` catalog in `module.json`. Without the
catalog, retiring or renaming a code is not a visible change (the next release silently breaks
whoever matches on it), and a code with no message — `reservations.update_rejected`, #51 — is only
found when a guest-facing screen shows the raw code in English.

With the block present the hub's installer is STRICT: a code the module emits and does not declare
makes it refuse the install. So this test checks the three sides at once, from the files alone:

  1. the manifest carries an `errors` catalog;
  2. every code the module EMITS is declared — `expect_rows.error` of any command, and every
     `"reservations.<snake_case>"` literal in the production part of `handler/src/lib.rs`
     (the `#[cfg(test)]` module and comments are cut out: a code only a test mentions is not
     emitted);
  3. every declared code has its text in `locales/en.json` and `locales/es.json → errors`
     (ADR-0055: the UI translates by code), and every live declaration is still emitted — a
     code the module stopped raising is retired with `deprecated`, not left behind.

A floor on the discovered codes guards the sweep itself: a scan that finds nothing passes.

Usage: tests/errors_catalog.contract.test.py   (exit 0 = green)
  No Postgres, no Docker: it reads the manifest, the handler source and the locales.
"""

import json
import pathlib
import re
import sys

MODULE_DIR = pathlib.Path(__file__).resolve().parent.parent
MANIFEST = json.loads((MODULE_DIR / "module.json").read_text(encoding="utf-8"))
MODULE_ID = MANIFEST["id"]
HANDLER = MODULE_DIR / "handler" / "src" / "lib.rs"
LOCALES = ("en", "es")

#: The twelve codes the module raised when the catalog was introduced (reservations#56).
MIN_EMITTED = 12

CODE_RE = re.compile(r'"(' + re.escape(MODULE_ID) + r'\.[a-z][a-z0-9_]*)"')


def strip_rust_comments(src: str) -> str:
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return re.sub(r"//[^\n]*", "", src)


def handler_codes() -> dict[str, str]:
    """Code -> where it is raised, for the production part of the handler."""
    if not HANDLER.exists():
        return {}
    src = HANDLER.read_text(encoding="utf-8")
    cut = src.find("#[cfg(test)]")
    if cut >= 0:
        src = src[:cut]
    src = strip_rust_comments(src)
    found = {}
    for match in CODE_RE.finditer(src):
        code = match.group(1)
        # `Operation::sql("reservations._apply_update", …)` names a command, not an error.
        if code.split(".", 1)[1].startswith("_"):
            continue
        found.setdefault(code, "handler/src/lib.rs")
    return found


def command_codes() -> dict[str, str]:
    found = {}
    for name, command in (MANIFEST.get("commands") or {}).items():
        code = ((command or {}).get("expect_rows") or {}).get("error")
        if code:
            found.setdefault(code, f"commands.{name}.expect_rows.error")
    return found


def main() -> int:
    failures = []
    emitted = {**handler_codes(), **command_codes()}

    if len(emitted) < MIN_EMITTED:
        print(
            f"FAIL: the sweep found only {len(emitted)} emitted code(s), fewer than the "
            f"{MIN_EMITTED} the module raised when the catalog was introduced — the discovery "
            "is broken, and a broken sweep passes."
        )
        return 1

    catalog = MANIFEST.get("errors")
    if not isinstance(catalog, dict):
        print(
            f"FAIL: module.json has no `errors` catalog, yet the module emits {len(emitted)} "
            f"domain error code(s): {', '.join(sorted(emitted))} (ADR-0398)"
        )
        return 1

    for code, where in sorted(emitted.items()):
        if code not in catalog:
            failures.append(
                f"{code} is emitted by {where} but not declared in module.json → errors"
            )

    for code, decl in sorted(catalog.items()):
        if (
            not (isinstance(decl, dict) and "deprecated" in decl)
            and code not in emitted
        ):
            failures.append(
                f"{code} is declared but nothing emits it — retire it with `deprecated`, "
                "do not leave it behind"
            )

    for lang in LOCALES:
        path = MODULE_DIR / "locales" / f"{lang}.json"
        texts = json.loads(path.read_text(encoding="utf-8")).get("errors") or {}
        for code in sorted(catalog):
            text = texts.get(code)
            if not isinstance(text, str) or not text.strip():
                failures.append(f"{code} has no text in locales/{lang}.json → errors")

    if failures:
        print(f"FAIL ({len(failures)}):")
        for failure in failures:
            print(f"  - {failure}")
        return 1

    print(
        f"OK: {len(emitted)} emitted code(s), all declared in module.json → errors and "
        f"translated in {' + '.join(LOCALES)}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
