-- Edición de campos de reserva. Runtime inyecta :hub_id, :current_user_id, :now.
-- Portado de ReservationService.update. El patrón COALESCE(:bind, col) permite envíos parciales:
-- pasar NULL en un bind deja el valor actual. (El handler normaliza ausente → NULL.)
UPDATE reservations_reservation
SET guest_name       = COALESCE(:guest_name, guest_name),
    guest_phone      = COALESCE(:guest_phone, guest_phone),
    guest_email      = COALESCE(:guest_email, guest_email),
    date             = COALESCE(:date, date),
    time             = COALESCE(:time, time),
    party_size       = COALESCE(:party_size, party_size),
    duration_minutes = COALESCE(:duration_minutes, duration_minutes),
    table_id         = COALESCE(:table_id, table_id),
    notes            = COALESCE(:notes, notes),
    internal_notes   = COALESCE(:internal_notes, internal_notes),
    updated_by       = :current_user_id,
    updated_at       = :now
WHERE id = :reservation_id AND hub_id = :hub_id AND is_deleted = 0;
