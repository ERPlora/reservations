-- Una reserva por id. Runtime inyecta :hub_id. Portado de ReservationService.get_reservation.
SELECT id, customer_id, guest_name, guest_phone, guest_email,
       date, time, party_size, duration_minutes, table_id,
       status, notes, internal_notes,
       confirmed_at, seated_at, completed_at, cancelled_at, cancellation_reason
FROM reservations_reservation
WHERE id = :reservation_id AND hub_id = :hub_id AND is_deleted = 0;
