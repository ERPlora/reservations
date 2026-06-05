-- Reservas del hub con filtros opcionales. Runtime inyecta :hub_id.
-- Portado de ReservationService.list. Los binds :status y :date deben pasarse: '' = sin filtro.
SELECT id, customer_id, guest_name, guest_phone, guest_email,
       date, time, party_size, duration_minutes, table_id,
       status, notes
FROM reservations_reservation
WHERE hub_id = :hub_id AND is_deleted = 0
  AND (:status = '' OR status = :status)
  AND (:date   = '' OR date   = :date)
ORDER BY date ASC, time ASC
LIMIT :limit;
