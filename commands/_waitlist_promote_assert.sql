-- Promoción waitlist → reserva, paso 3/3: assert de atomicidad. Exige que (1) la reserva
-- exista (el gate de disponibilidad del paso 1 pasó) Y (2) la entrada quedó convertida y
-- enlazada a ESA reserva. Si cualquier paso falló (slot lleno, fecha bloqueada, entrada
-- inexistente o ya convertida), EXISTS=0 viola el CHECK (ok = 1) de reservations__gate y
-- la transacción completa revierte: ni reserva ni flag.
INSERT INTO reservations__gate (gate, ok)
SELECT 'waitlist_promoted',
       (EXISTS (SELECT 1 FROM reservations_reservation
                WHERE id = :reservation_id AND hub_id = :hub_id)
        AND EXISTS (SELECT 1 FROM reservations_waitlistentry
                    WHERE id = :entry_id AND hub_id = :hub_id
                      AND is_converted = 1 AND reservation_id = :reservation_id));
