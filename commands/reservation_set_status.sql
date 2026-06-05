-- Cambio de estado de una reserva (confirmar/sentar/completar/cancelar/no-show).
-- Runtime inyecta :hub_id, :current_user_id, :now. Portado de ReservationService.update_status.
--
-- IMPORTANTE: las TRANSICIONES VÁLIDAS de la máquina de estados (p.ej. solo 'pending'→'confirmed',
-- solo 'seated'→'completed') y los timestamps por transición (confirmed_at/seated_at/...) los valida
-- y resuelve el handler WASM ANTES de este UPDATE — ver WASM-TODO. Este SQL aplica el resultado:
-- el handler pasa :status ya validado y los :*_at correspondientes (NULL si no aplica).
UPDATE reservations_reservation
SET status              = :status,
    confirmed_at        = COALESCE(:confirmed_at, confirmed_at),
    seated_at           = COALESCE(:seated_at, seated_at),
    completed_at        = COALESCE(:completed_at, completed_at),
    cancelled_at        = COALESCE(:cancelled_at, cancelled_at),
    cancellation_reason = COALESCE(:cancellation_reason, cancellation_reason),
    updated_by          = :current_user_id,
    updated_at          = :now
WHERE id = :reservation_id AND hub_id = :hub_id AND is_deleted = 0;
