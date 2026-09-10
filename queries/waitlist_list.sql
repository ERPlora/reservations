-- Lista de espera del hub. Runtime inyecta :hub_id. Portado de ReservationService.list_waitlist.
-- :include_converted (0|1): si 0 oculta las ya convertidas. Binds :date_from/:date_to: '' = sin filtro.
-- reservations#54: `is_contacted`/`is_converted` salen como BOOLEANO (en reposo son INTEGER
-- 0/1), que es lo que `waitlist.update` declara.
SELECT id, customer_id, guest_name, guest_phone, guest_email,
       date, preferred_time, party_size, notes,
       is_contacted <> 0 AS is_contacted, is_converted <> 0 AS is_converted,
       reservation_id
FROM reservations_waitlistentry
WHERE hub_id = :hub_id AND is_deleted = 0
