-- Soft-delete de una reserva. Runtime inyecta :hub_id, :current_user_id, :now.
-- Portado de ReservationService.delete.
UPDATE reservations_reservation
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :reservation_id AND hub_id = :hub_id AND is_deleted = 0;
