-- Marca de contactado o enmienda de notas en lista de espera (command privado
-- `reservations._waitlist_update`, ruta "simple" del handler WASM `waitlist_update`).
-- Runtime inyecta :hub_id, :current_user_id, :now. Portado de ReservationService.update_waitlist_entry.
-- COALESCE(:bind, col) permite envíos parciales (NULL = no tocar).
-- NOTA: si el payload pide is_converted=1, el handler NO usa este SQL: hace la promoción
-- atómica waitlist→reserva vía `reservations._waitlist_promote` (WASM-TODO §3).
UPDATE reservations_waitlistentry
SET is_contacted = COALESCE(:is_contacted, is_contacted),
    is_converted = COALESCE(:is_converted, is_converted),
    notes        = COALESCE(:notes, notes),
    updated_by   = :current_user_id,
    updated_at   = :now
WHERE id = :entry_id AND hub_id = :hub_id AND is_deleted = 0;
