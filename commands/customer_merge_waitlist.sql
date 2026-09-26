UPDATE reservations_waitlistentry
   SET customer_id = :surviving_id,
       updated_by  = :current_user_id,
       updated_at  = :now
 WHERE hub_id = :hub_id
   AND customer_id = :absorbed_id
   AND CAST(:surviving_id AS TEXT) <> CAST(:absorbed_id AS TEXT);

-- Waitlist twin of customer_merge_reservations.sql: runs right after it, in the same transaction,
-- for `reservations._on_customer_merged`. Same guards, same reasons — `hub_id` tenancy (an opaque
-- `customer_id` may name someone else in another hub), soft-deleted entries move too (it is the
-- customer's history), idempotent (a redelivery matches zero rows), and no `expect_rows` (a merged
-- customer with no waitlist entry is the ordinary case).
