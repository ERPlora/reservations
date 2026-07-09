-- Assert de la máquina de estados: la transición solo es válida si el UPDATE condicional
-- (_apply_status_update.sql) realmente aplicó (status = :status Y updated_at = :now — el
-- :now es idéntico en todos los statements del mismo command). Una transición ilegal
-- (p.ej. completed sin pasar por seated, o reserva inexistente) deja EXISTS=0, viola el
-- CHECK (ok = 1) de reservations__gate y revierte la transacción completa.
INSERT INTO reservations__gate (gate, ok)
SELECT 'status_transition_valid',
       CASE WHEN EXISTS (SELECT 1 FROM reservations_reservation
               WHERE id = :reservation_id AND hub_id = :hub_id AND is_deleted = 0
                 AND status = :status AND updated_at = :now) THEN 1 ELSE 0 END;
