-- Cambio de estado CON validación de la máquina de estados (WASM-TODO §1).
-- Lo invoca el handler WASM `set_status` (command privado `reservations._apply_status`).
-- Transiciones válidas (cualquier otra deja el UPDATE sin efecto y el assert revierte):
--   pending   → confirmed | seated | cancelled | no_show
--   confirmed → seated | cancelled | no_show
--   seated    → completed
-- Los timestamps de transición (*_at) los fija ESTE SQL con el :now del runtime
-- (autoritativo, el cliente ya no los envía). Runtime inyecta :hub_id, :current_user_id, :now.
UPDATE reservations_reservation
SET status              = :status,
    confirmed_at        = CASE WHEN :status = 'confirmed' THEN :now ELSE confirmed_at END,
    seated_at           = CASE WHEN :status = 'seated'    THEN :now ELSE seated_at    END,
    completed_at        = CASE WHEN :status = 'completed' THEN :now ELSE completed_at END,
    cancelled_at        = CASE WHEN :status = 'cancelled' THEN :now ELSE cancelled_at END,
    cancellation_reason = CASE WHEN :status = 'cancelled'
                               THEN COALESCE(:cancellation_reason, cancellation_reason)
                               ELSE cancellation_reason END,
    updated_by          = :current_user_id,
    updated_at          = :now
WHERE id = :reservation_id AND hub_id = :hub_id AND is_deleted = 0
  AND ((:status = 'confirmed' AND status = 'pending')
    OR (:status = 'seated'    AND status IN ('pending', 'confirmed'))
    OR (:status = 'completed' AND status = 'seated')
    OR (:status = 'cancelled' AND status IN ('pending', 'confirmed'))
    OR (:status = 'no_show'   AND status IN ('pending', 'confirmed')));
