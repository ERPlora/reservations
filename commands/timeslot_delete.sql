-- Soft-delete de una ventana horaria. Runtime inyecta :hub_id, :current_user_id, :now.
-- Portado de ReservationService.delete_time_slot.
UPDATE reservations_timeslot
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :time_slot_id AND hub_id = :hub_id AND is_deleted = 0;
