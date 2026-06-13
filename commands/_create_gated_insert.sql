-- Alta de reserva CON gate de disponibilidad (WASM-TODO §2/§4, anti-overbooking).
-- Lo invoca el handler WASM `create_reservation` (command privado `reservations._create_gated`).
-- El INSERT condicional solo materializa la fila si TODAS las condiciones se cumplen,
-- evaluadas contra datos vivos DENTRO de la transacción del command (el conteo de
-- capacidad del slot es atómico). Si no se cumplen, no inserta nada y el assert
-- (_create_gated_assert.sql) revierte la transacción.
-- El handler pasa :reservation_id (de context.new_ids) y el payload normalizado
-- (time en HH:MM:SS). Runtime inyecta :hub_id, :current_user_id, :now.
-- Los COALESCE sobre settings replican los defaults de la migración (sin fila de settings,
-- aplican los mismos límites por defecto). day_of_week del módulo: 0=lunes … 6=domingo;
-- Se usan las funciones-puente erp_dow_mon0(x) (día de semana 0=lunes…6=domingo, ya con la
-- conversión por dialecto) y erp_datediff_days(a, b) (días fraccionarios) — ADR-0007 §4a.
INSERT INTO reservations_reservation
  (id, hub_id, customer_id, guest_name, guest_phone, guest_email,
   date, time, party_size, duration_minutes, table_id,
   status, confirmed_at, notes, internal_notes,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :reservation_id, :hub_id, :customer_id, :guest_name,
  COALESCE(:guest_phone, ''), COALESCE(:guest_email, ''),
  :date, :time, :party_size,
  COALESCE(:duration_minutes, s.default_duration_minutes, 120),
  :table_id,
  CASE WHEN COALESCE(s.auto_confirm, 0) = 1 THEN 'confirmed' ELSE 'pending' END,
  CASE WHEN COALESCE(s.auto_confirm, 0) = 1 THEN :now ELSE NULL END,
  COALESCE(:notes, ''), COALESCE(:internal_notes, ''),
  0, :current_user_id, :current_user_id, :now, :now
FROM (SELECT 1 AS one)
LEFT JOIN reservations_settings s ON s.hub_id = :hub_id AND s.is_deleted = 0
WHERE
  -- party_size dentro de los límites de settings
  :party_size >= COALESCE(s.min_party_size, 1)
  AND :party_size <= COALESCE(s.max_party_size, 20)
  -- ventana de antelación: min_advance_hours <= (fecha-hora - now) <= max_advance_days
  AND erp_datediff_days(:date || ' ' || :time, :now) >= COALESCE(s.min_advance_hours, 1) / 24.0
  AND erp_datediff_days(:date || ' ' || :time, :now) <= COALESCE(s.max_advance_days, 30)
  -- la fecha/hora no está bloqueada (día completo o franja que solape la hora)
  AND NOT EXISTS (
        SELECT 1 FROM reservations_blockeddate b
        WHERE b.hub_id = :hub_id AND b.is_deleted = 0 AND b.date = :date
          AND (b.is_full_day = 1
               OR (b.blocked_from IS NOT NULL AND b.blocked_until IS NOT NULL
                   AND :time >= b.blocked_from AND :time <= b.blocked_until)))
  -- existe franja activa del día que contiene la hora Y con hueco (conteo atómico)
  AND EXISTS (
        SELECT 1 FROM reservations_timeslot t
        WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
          AND t.day_of_week = erp_dow_mon0(:date)
          AND :time >= t.start_time AND :time < t.end_time
          AND (SELECT COUNT(*) FROM reservations_reservation r
               WHERE r.hub_id = :hub_id AND r.is_deleted = 0 AND r.date = :date
                 AND r.time >= t.start_time AND r.time < t.end_time
                 AND r.status NOT IN ('cancelled', 'no_show')) < t.max_reservations);
