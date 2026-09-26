UPDATE reservations_reservation
   SET customer_id = :surviving_id,
       updated_by  = :current_user_id,
       updated_at  = :now
 WHERE hub_id = :hub_id
   AND customer_id = :absorbed_id
   AND CAST(:surviving_id AS TEXT) <> CAST(:absorbed_id AS TEXT);

-- Reservations · `customer.merged` — re-point a merged customer's reservations to the survivor
-- (customers#86/customers#87). Runs from the outbox relay when `customers` publishes
-- `customer.merged`; the payload IS the emitter's params, so no `schema` here — the shape belongs
-- to the neighbour, not to us.
--
-- The `hub_id` guard is not decoration: `customer_id` is an OPAQUE id with no cross-module foreign
-- key, and the same string may name another person in another hub.
--
-- ALL rows move — live and soft-deleted, any status — because it is the customer's history, not a
-- working set. `guest_name`/`guest_phone`/`guest_email` are a snapshot of how the booking was made
-- and are deliberately NOT touched.
--
-- No unique index in this module includes `customer_id`, so a blind re-point cannot collide (unlike
-- `services`' `use_index`). It never reads `customers`, so it does not require the absorbed sheet to
-- still exist.
--
-- The `surviving_id <> absorbed_id` guard turns a degenerate event into a no-op instead of
-- re-stamping the survivor's own rows.
--
-- IDEMPOTENT: the outbox is at-least-once, so a redelivery matches zero rows. No `expect_rows`:
-- merging a customer who never booked is the ordinary case.
