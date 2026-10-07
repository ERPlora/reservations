UPDATE reservations_reservation
   SET guest_name          = '',
       guest_phone         = '',
       guest_email         = '',
       notes               = '',
       internal_notes      = '',
       cancellation_reason = '',
       updated_by          = :current_user_id,
       updated_at          = :now
 WHERE hub_id = :hub_id
   AND customer_id = :customer_id
   AND CAST(:customer_id AS TEXT) <> ''
   AND (guest_name <> '' OR guest_phone <> '' OR guest_email <> ''
        OR notes <> '' OR internal_notes <> '' OR cancellation_reason <> '');

-- Reservations · `customer.anonymized`, step 1/2 — the book forgets who the guest was (pm#637,
-- RESERVATIONS-F22). Prose at the BOTTOM by house rule (hub#1137/ADR-0387).
--
-- `customers.anonymize` is the platform's GDPR erasure (art. 17, customers#11). It publishes
-- `customer.anonymized`; the outbox relay hands its params (`customer_id`, `reason`, `hub_id`) to
-- this command verbatim, so there is no `schema`. Runtime injects :hub_id, :current_user_id, :now.
--
-- Every reservation of that customer — live and soft-deleted, any status — loses what was copied
-- from her (name, phone, email), both free-text notes (they may carry an allergy or a wheelchair:
-- health data) and the cancellation reason, which she may have given herself. The name goes to ''
-- and not to a marker: the screen paints a translated «Deleted customer» for a blank name on a
-- linked row, a stored English word would reach a Spanish book raw.
--
-- KEPT on purpose: the row, `customer_id` (it now names the pseudonymised sheet `customers` keeps,
-- so it is not personal data on its own), date, time, party size, duration, table and status. That
-- is the restaurant's own record of the covers it served, and the occupancy of each slot counts it.
-- The reservation is NOT cancelled: what to do with a future booking is the restaurant's decision.
--
-- The `hub_id` guard is load-bearing: `customer_id` is an opaque id with no cross-module foreign
-- key, and the same string may name a different person in another hub. The empty-id guard keeps a
-- degenerate event from erasing every row whose link is blank.
--
-- IDEMPOTENT: the outbox is at-least-once. The OR guard skips a row with nothing personal left, so
-- a redelivery stamps nothing; each arm is pinned by its own row in
-- `tests/customer_erasure.pg.test.py` (a row erased before with ONE column left). No `expect_rows`:
-- erasing a customer who never booked is the ordinary case.
