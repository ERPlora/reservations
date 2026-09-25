-- The hub's reservations, with optional filters. The runtime injects :hub_id.
-- `starts_at` = date + time as ISO text, so its text order IS calendar order: the list engine
-- sorts by ONE column, and a search across days needs day first, then hour (reservations#67).
SELECT id, customer_id, guest_name, guest_phone, guest_email,
       date, time, party_size, duration_minutes, table_id,
       status, notes,
       date || ' ' || time AS starts_at
FROM reservations_reservation
WHERE hub_id = :hub_id AND is_deleted = 0
