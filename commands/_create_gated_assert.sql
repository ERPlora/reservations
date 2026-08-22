-- Assert del gate de disponibilidad: si el INSERT condicional (_create_gated_insert.sql)
-- no materializó la reserva, EXISTS=0 viola el CHECK (ok = 1) de reservations__gate y
-- TODA la transacción revierte (la reserva no se crea, el evento no se emite).
-- SQLite no permite RAISE fuera de triggers; la tabla guardia es el mecanismo de aborto.
--
-- reservations#31: la fila que aborta lleva ahora el MOTIVO (`reason`, migración 003), evaluado
-- con las mismas condiciones del INSERT condicional y en el MISMO orden que el pre-check del
-- handler WASM (`create_refusal`): party_size → ventana de antelación → fecha bloqueada →
-- sin franja que cubra la hora → franja llena. Los códigos de `reason` son los mismos sufijos
-- que los errores de dominio del handler (`no_capacity`, `no_service_day`, …), que es lo que
-- el usuario ve traducido; esta columna es el diagnóstico del guardián para quien depure el
-- rechazo que el handler dejó pasar (la carrera la cierra solo el gate, dentro de la tx).
INSERT INTO reservations__gate (gate, ok, reason)
SELECT 'reservation_available',
       CASE WHEN EXISTS (SELECT 1 FROM reservations_reservation
               WHERE id = :reservation_id AND hub_id = :hub_id) THEN 1 ELSE 0 END,
       CASE
         WHEN EXISTS (SELECT 1 FROM reservations_reservation
                      WHERE id = :reservation_id AND hub_id = :hub_id) THEN ''
         WHEN :party_size < COALESCE(s.min_party_size, 1)
           OR :party_size > COALESCE(s.max_party_size, 20) THEN 'party_size_exceeded'
         WHEN erp_datediff_days(:date || ' ' || :time, :now) < COALESCE(s.min_advance_hours, 1) / 24.0
           OR erp_datediff_days(:date || ' ' || :time, :now) > COALESCE(s.max_advance_days, 30)
           THEN 'outside_advance_window'
         WHEN EXISTS (SELECT 1 FROM reservations_blockeddate b
                      WHERE b.hub_id = :hub_id AND b.is_deleted = 0 AND b.date = :date
                        AND (b.is_full_day = 1
                             OR (b.blocked_from IS NOT NULL AND b.blocked_until IS NOT NULL
                                 AND :time >= b.blocked_from AND :time <= b.blocked_until)))
           THEN 'date_blocked'
         WHEN NOT EXISTS (SELECT 1 FROM reservations_timeslot t
                          WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
                            AND t.day_of_week = erp_dow_mon0(:date)
                            AND :time >= t.start_time AND :time < t.end_time)
           THEN 'no_service_day'
         WHEN NOT EXISTS (SELECT 1 FROM reservations_timeslot t
                          WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
                            AND t.day_of_week = erp_dow_mon0(:date)
                            AND :time >= t.start_time AND :time < t.end_time
                            AND (SELECT COUNT(*) FROM reservations_reservation r
                                 WHERE r.hub_id = :hub_id AND r.is_deleted = 0 AND r.date = :date
                                   AND r.time >= t.start_time AND r.time < t.end_time
                                   AND r.status NOT IN ('cancelled', 'no_show')) < t.max_reservations)
           THEN 'no_capacity'
         ELSE 'gate_rejected'
       END
FROM (SELECT 1 AS one)
LEFT JOIN reservations_settings s ON s.hub_id = :hub_id AND s.is_deleted = 0;
