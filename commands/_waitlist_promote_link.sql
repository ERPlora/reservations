-- Promoción waitlist → reserva, paso 2/3: enlaza la entrada con la reserva recién creada
-- (is_converted=1 + reservation_id) en la MISMA transacción. Solo si la entrada sigue
-- viva y sin convertir (anti doble-promoción).
UPDATE reservations_waitlistentry
SET is_converted   = 1,
    reservation_id = :reservation_id,
    is_contacted   = COALESCE(:is_contacted, is_contacted),
    notes          = COALESCE(:notes, notes),
    updated_by     = :current_user_id,
    updated_at     = :now
WHERE id = :entry_id AND hub_id = :hub_id AND is_deleted = 0 AND is_converted = 0;
