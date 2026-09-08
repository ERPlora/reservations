-- reservations#53 — flip ONE booking setting without going through the whole form.
--
-- WHY THIS FILE EXISTS. `whatsapp_inbox#126` offers «las reservas se confirman solas / las reviso
-- yo antes» from its «Reservar mesa» card, and the only door into that policy was
-- `reservations.settings.upsert`, which takes the entire settings form. Handing the WhatsApp
-- screen that door hands it the right to rewrite the restaurant's whole configuration in order to
-- flip one switch, and it breaks the symmetry with `appointments.settings.set_auto_confirm_online`
-- (appointments#149), which the same screen calls for the salon. One switch, one door.
--
-- WHAT THE TRIAGE CORRECTED (08/09/2026, against origin/main@b8c4621). The issue was written as
-- the mirror of Citas, where the wide door really does clobber: there every property of the form
-- schema carries a `default`, the runtime materialises the omitted ones (ADR-0073) and the SQL
-- writes them all. HERE it does not — `settings_upsert.sql` writes
-- `COALESCE(:bind, reservations_settings.col)` and no property declares a `default`, so an omitted
-- key arrives NULL and the old value survives. Measured. But it is ONE `default` away from
-- clobbering with nobody watching, which is why tests/settings_narrow_write.pg.test.py pins that
-- invariant as well as this command.
--
-- ONE STATEMENT, TWO BRANCHES. The singleton is created lazily (a restaurant that never saved its
-- settings has no row — `queries/settings_get.sql` says so out loud), so «update it, and create it
-- if it is not there» has to be atomic or two screens racing on a fresh hub end in a unique
-- violation. `ON CONFLICT (hub_id)` is the same inference `settings_upsert.sql` uses
-- (`uq_reservations_settings_hub`).
--
-- THE INSERT BRANCH LISTS NOTHING ELSE ON PURPOSE. Every other column carries its factory value as
-- a table DEFAULT in `001_init.sql`, and those are the same numbers the `COALESCE(:bind, <n>)`
-- fallbacks of the wide upsert use. Repeating them here would be a second copy that drifts the day
-- one of them changes; leaving them out makes the row this command creates identical to the one
-- `settings.upsert` writes from an empty form (pinned by the test).
--
-- THE `is_deleted = 0` GUARD. A soft-deleted singleton is invisible to `reservations.settings.get`,
-- so writing into it would lose the flip silently. Refusing affects 0 rows, which the command's
-- `expect_rows` gate turns into `reservations.cannot_update_settings` — a visible error instead of
-- a write nobody can read back.
--
-- The flag binds RAW: the runtime turns a JSON boolean into 0/1 for an INTEGER column
-- (`Json::Bool` → 0/1, hub#208 / ADR-0154).
--
-- The self-reference of the DO UPDATE goes QUALIFIED (`reservations_settings.is_deleted`) for the
-- same reason as in `settings_upsert.sql`: unqualified, Postgres cannot tell the stored row from
-- `excluded` and the statement does not even parse (reservations#19).
INSERT INTO reservations_settings
  (id, hub_id, auto_confirm, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :auto_confirm, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT (hub_id) DO UPDATE SET
  auto_confirm = excluded.auto_confirm,
  updated_by   = :current_user_id,
  updated_at   = :now
WHERE reservations_settings.is_deleted = 0;
