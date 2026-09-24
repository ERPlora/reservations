-- reservations#45: the figures of ONE service day — what the manager reads on opening Reservas.
--
-- `covers` is the sum of the party sizes (guests, not bookings): `slots.count_for` counts bookings
-- per slot, the gate's unit, and cannot answer «how many people are coming tonight».
-- "Live" is the gate's rule (not cancelled / no_show, not soft-deleted); seated and completed
-- count, those guests are part of the day's service. No GROUP BY: always exactly one row, zeros
-- on an empty day.
--
-- Params: `:date` (YYYY-MM-DD, required). Runtime injects `:hub_id`.
SELECT CAST(COUNT(r.id) AS INTEGER) AS reservations,
       CAST(COALESCE(SUM(r.party_size), 0) AS INTEGER) AS covers
FROM reservations_reservation r
WHERE r.hub_id = :hub_id AND r.is_deleted = 0
  AND r.date = :date
  AND r.status NOT IN ('cancelled', 'no_show')
