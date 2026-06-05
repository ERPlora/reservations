-- Lista de espera del hub. Runtime inyecta :hub_id. Portado de ReservationService.list_waitlist.
-- :include_converted (0|1): si 0 oculta las ya convertidas. Binds :date_from/:date_to: '' = sin filtro.
SELECT id, customer_id, guest_name, guest_phone, guest_email,
       date, preferred_time, party_size, notes,
       is_contacted, is_converted, reservation_id
FROM reservations_waitlistentry
WHERE hub_id = :hub_id AND is_deleted = 0
  AND (:include_converted = 1 OR is_converted = 0)
  AND (:date_from = '' OR date >= :date_from)
  AND (:date_to   = '' OR date <= :date_to)
ORDER BY date ASC, preferred_time ASC
LIMIT :limit;
