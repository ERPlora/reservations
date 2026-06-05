-- Soft-delete de una entrada de lista de espera. Runtime inyecta :hub_id, :current_user_id, :now.
-- Portado de ReservationService.delete_waitlist_entry.
UPDATE reservations_waitlistentry
SET is_deleted = 1,
    deleted_at = :now,
    updated_by = :current_user_id,
    updated_at = :now
WHERE id = :entry_id AND hub_id = :hub_id AND is_deleted = 0;
