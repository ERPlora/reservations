-- Soft-delete de una fecha bloqueada. Runtime inyecta :hub_id, :current_user_id, :now.
-- Portado de ReservationService.delete_blocked_date.
UPDATE reservations_blockeddate
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :blocked_date_id AND hub_id = :hub_id AND is_deleted = 0;
