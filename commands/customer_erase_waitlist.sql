UPDATE reservations_waitlistentry
   SET guest_name  = '',
       guest_phone = '',
       guest_email = '',
       notes       = '',
       updated_by  = :current_user_id,
       updated_at  = :now
 WHERE hub_id = :hub_id
   AND customer_id = :customer_id
   AND CAST(:customer_id AS TEXT) <> ''
   AND (guest_name <> '' OR guest_phone <> '' OR guest_email <> '' OR notes <> '');

-- Waitlist twin of customer_erase_reservations.sql: runs right after it, in the same transaction,
-- for `reservations._on_customer_anonymized` (pm#637, RESERVATIONS-F22). Same guards, same reasons
-- — `hub_id` tenancy (an opaque `customer_id` may name someone else in another hub), a blank id
-- touches nothing, soft-deleted and converted entries are emptied too (it is still her data), and
-- the OR guard makes a redelivery stamp nothing. Kept: the entry, its day, preferred time, party
-- size, contacted/converted flags, the sheet link and the reservation it became.
--
-- An entry typed on the «Lista de espera» screen carries no `customer_id` (the form has no sheet
-- picker), so the erasure cannot find it: that gap is reservations#99, not something this statement
-- may guess at by matching a phone number.
