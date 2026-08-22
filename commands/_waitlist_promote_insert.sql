-- Promoción waitlist → reserva, paso 1/3 (WASM-TODO §3, multi-tabla atómica).
-- Lo invoca el handler WASM `waitlist_update` cuando el payload pide is_converted=1
-- (command privado `reservations._waitlist_promote`). Crea la reserva LEYENDO los datos
-- de la propia entrada de waitlist (la fila es la autoridad, no el cliente) y re-aplica
-- el gate de disponibilidad (fecha no bloqueada, franja activa, capacidad del slot con
-- conteo atómico). La ventana de antelación NO se aplica: la promoción es una acción de
-- staff, habitualmente para el mismo día. Solo promociona entradas vivas no convertidas.
-- Runtime inyecta :hub_id, :current_user_id, :now; el handler pasa :entry_id y
-- :reservation_id (de context.new_ids).
--
-- reservations#34: `preferred_time` se NORMALIZA a HH:MM:SS en la tabla derivada, UNA vez.
-- El schema del alta en lista de espera acepta HH:MM (la API puede mandarlo; solo el
-- formulario normaliza) y copiarlo tal cual guardaba «21:00» donde el alta directa guarda
-- «21:00:00» — y algo peor que cosmética: TODAS las comparaciones de abajo son
-- lexicográficas, así que una franja que EMPIEZA a las 21:00:00 nunca casaba
-- ('21:00' >= '21:00:00' es falso en texto) y la promoción rebotaba en el gate sin motivo.
INSERT INTO reservations_reservation
  (id, hub_id, customer_id, guest_name, guest_phone, guest_email,
   date, time, party_size, duration_minutes, table_id,
   status, confirmed_at, notes, internal_notes,
   is_deleted, created_by, updated_by, created_at, updated_at)
SELECT
  :reservation_id, :hub_id, w.customer_id, w.guest_name, w.guest_phone, w.guest_email,
  w.date, w.preferred_time, w.party_size,
  COALESCE(s.default_duration_minutes, 120),
  NULL,
  CASE WHEN COALESCE(s.auto_confirm, 0) = 1 THEN 'confirmed' ELSE 'pending' END,
  CASE WHEN COALESCE(s.auto_confirm, 0) = 1 THEN :now ELSE NULL END,
  w.notes, '',
  0, :current_user_id, :current_user_id, :now, :now
FROM (SELECT w0.id, w0.hub_id, w0.customer_id, w0.guest_name, w0.guest_phone,
             w0.guest_email, w0.date, w0.party_size, w0.notes,
             w0.is_deleted, w0.is_converted,
             CASE WHEN LENGTH(w0.preferred_time) = 5
                  THEN w0.preferred_time || ':00'
                  ELSE w0.preferred_time END AS preferred_time
      FROM reservations_waitlistentry w0) w
LEFT JOIN reservations_settings s ON s.hub_id = :hub_id AND s.is_deleted = 0
WHERE w.id = :entry_id AND w.hub_id = :hub_id AND w.is_deleted = 0 AND w.is_converted = 0
  -- la fecha/hora preferida no está bloqueada
  AND NOT EXISTS (
        SELECT 1 FROM reservations_blockeddate b
        WHERE b.hub_id = :hub_id AND b.is_deleted = 0 AND b.date = w.date
          AND (b.is_full_day = 1
               OR (b.blocked_from IS NOT NULL AND b.blocked_until IS NOT NULL
                   AND w.preferred_time >= b.blocked_from AND w.preferred_time <= b.blocked_until)))
  -- existe franja activa que contiene la hora preferida Y con hueco (conteo atómico)
  AND EXISTS (
        SELECT 1 FROM reservations_timeslot t
        WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
          AND t.day_of_week = erp_dow_mon0(w.date)
          AND w.preferred_time >= t.start_time AND w.preferred_time < t.end_time
          AND (SELECT COUNT(*) FROM reservations_reservation r
               WHERE r.hub_id = :hub_id AND r.is_deleted = 0 AND r.date = w.date
                 AND r.time >= t.start_time AND r.time < t.end_time
                 AND r.status NOT IN ('cancelled', 'no_show')) < t.max_reservations);
