-- reservations#4: capacity per slot for a day — the READ side of the anti-overbooking gate.
--
-- The gate itself is inline (`_create_gated` / `_waitlist_promote`: a COUNT inside the conditional
-- INSERT, atomic). This query lets the availability screen SHOW how full each slot is without
-- trying to create. The one property that matters: it counts EXACTLY what the gate counts —
-- same "live" rule (not cancelled / no_show, not soft-deleted), same slot membership
-- (`time >= start_time AND time < end_time`, end exclusive), same weekday mapping.
--
-- Params: `:date` (YYYY-MM-DD, required); `:time` (HH:MM:SS, optional) narrows to the slot that
-- contains it. Runtime injects `:hub_id`.
SELECT t.id AS timeslot_id,
       t.start_time,
       t.end_time,
       t.max_reservations,
       COUNT(r.id) AS reserved,
       GREATEST(t.max_reservations - COUNT(r.id), 0) AS available
FROM reservations_timeslot t
LEFT JOIN reservations_reservation r
       ON r.hub_id = t.hub_id AND r.is_deleted = 0
      AND r.date = :date
      AND r.time >= t.start_time AND r.time < t.end_time
      AND r.status NOT IN ('cancelled', 'no_show')
WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
  AND t.day_of_week = erp_dow_mon0(:date)
  AND (CAST(:time AS TEXT) IS NULL
       OR (CAST(:time AS TEXT) >= t.start_time AND CAST(:time AS TEXT) < t.end_time))
GROUP BY t.id, t.start_time, t.end_time, t.max_reservations
ORDER BY t.start_time
