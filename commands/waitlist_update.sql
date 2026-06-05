-- Marca de contactado/convertido o enmienda de notas en lista de espera.
-- Runtime inyecta :hub_id, :current_user_id, :now. Portado de ReservationService.update_waitlist_entry.
-- COALESCE(:bind, col) permite envíos parciales (NULL = no tocar).
-- NOTA: la promoción waitlist→reserva (crear reserva + fijar reservation_id + is_converted=1 de forma
-- atómica) es lógica multi-tabla que resuelve el handler WASM — ver WASM-TODO. Aquí solo el flag simple.
UPDATE reservations_waitlistentry
SET is_contacted = COALESCE(:is_contacted, is_contacted),
    is_converted = COALESCE(:is_converted, is_converted),
    notes        = COALESCE(:notes, notes),
    updated_by   = :current_user_id,
    updated_at   = :now
WHERE id = :entry_id AND hub_id = :hub_id AND is_deleted = 0;
