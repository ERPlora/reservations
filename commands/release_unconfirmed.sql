-- reservations#5: release the `pending` reservations whose time has come and gone.
--
-- A pending reservation is a promise nobody kept: the guest never confirmed and, once its time is
-- past, never showed up either. Until something releases it, it keeps COUNTING against the slot
-- `max_reservations` — the slot is a window, so a stale 20:00 pending blocks a 22:30 booking in the
-- same 20:00–23:00 slot — and it clutters the pending list. Same job `tables.tables.expire_holds`
-- does for holds: a sweep, idempotent, every 15 minutes (`scheduled_tasks`, system context).
--
-- Grace = `settings.no_show_window_minutes` (default 15): the setting that already means "how long
-- after the time do we wait". Deliberately NOT `min_advance_hours` (a booking lead time, and a
-- waitlist promotion inside it would be released the moment it was created).
--
-- Released = `cancelled` with `cancellation_reason = 'unconfirmed'` — not `no_show`: nobody ever
-- confirmed the guest was coming, so counting it as a no-show would blame someone who never had a
-- table. `pending → cancelled` is a legal transition of the state machine (`_apply_status`).
--
-- Only `pending`; the second pass finds nothing (idempotent). Cross-hub: the sweep runs per hub with
-- `:hub_id` injected by the scheduler. `date`/`time` are naive local, `:now` is UTC — the same
-- known approximation the create gate makes with `erp_datediff_days`.
UPDATE reservations_reservation
SET status              = 'cancelled',
    cancelled_at        = :now,
    cancellation_reason = 'unconfirmed',
    updated_by          = :current_user_id,
    updated_at          = :now
FROM (SELECT 1 AS one) AS anchor
LEFT JOIN reservations_settings s ON s.hub_id = :hub_id AND s.is_deleted = 0
WHERE reservations_reservation.hub_id = :hub_id
  AND reservations_reservation.is_deleted = 0
  AND reservations_reservation.status = 'pending'
  AND erp_datediff_days(:now, reservations_reservation.date || ' ' || reservations_reservation.time)
      > COALESCE(s.no_show_window_minutes, 15) / 1440.0;
