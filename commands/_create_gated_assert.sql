-- Assert del gate de disponibilidad: si el INSERT condicional (_create_gated_insert.sql)
-- no materializó la reserva, EXISTS=0 viola el CHECK (ok = 1) de reservations__gate y
-- TODA la transacción revierte (la reserva no se crea, el evento no se emite).
-- SQLite no permite RAISE fuera de triggers; la tabla guardia es el mecanismo de aborto.
INSERT INTO reservations__gate (gate, ok)
SELECT 'reservation_available',
       CASE WHEN EXISTS (SELECT 1 FROM reservations_reservation
               WHERE id = :reservation_id AND hub_id = :hub_id) THEN 1 ELSE 0 END;
