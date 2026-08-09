-- Edición de una reserva. Runtime inyecta :hub_id, :current_user_id, :now.
--
-- PASA POR LA MISMA PUERTA QUE EL ALTA (reservations#14). Antes era un `UPDATE … WHERE id` a secas:
-- el alta comprobaba aforo, ventana de antelación, días bloqueados y hueco en la franja, y la
-- edición no comprobaba nada. O sea que la puerta estaba solo a la entrada — mover la misma reserva
-- a una franja llena, a un día cerrado o a una mesa de cuarenta comensales pasaba sin más.
--
-- Las condiciones se evalúan sobre los valores EFECTIVOS —`COALESCE(:campo, campo)`, lo que la
-- reserva va a ser, no lo que era—, porque si no una edición parcial esquivaría la guarda:
-- mandar solo `:time` movería la hora sin que nadie mirase la fecha.
--
-- ⚠️ El conteo de aforo EXCLUYE la propia reserva (`r.id <> :reservation_id`). Sin eso, mover una
-- reserva DENTRO de su propia franja se contaría a sí misma y el cambio se rechazaría por llena —
-- una guarda que impide justo lo que no cambia nada.
--
-- `table_id` usa DOS centinelas, como `staff_member.user_id` (ADR-0188): `NULL` = no tocar,
-- `''` = DESASIGNAR. Con el `COALESCE(:table_id, table_id)` de antes, `NULL` significaba «déjalo
-- como está» y no había forma de expresar «quítale la mesa», así que una asignación equivocada se
-- quedaba puesta para siempre. El bind va dentro de `COALESCE(:table_id, '__keep__')` porque
-- Postgres no infiere el tipo de un `:bind IS NULL` a pelo y devuelve 42P08.
--
-- Y el command declara `expect_rows: {op: min, n: 1}`: si la edición no pasa la puerta —o la
-- reserva no existe en este hub— revierte y devuelve `reservations.update_rejected`, en vez de no
-- escribir nada y emitir `reservations.reservation.updated` igualmente.
UPDATE reservations_reservation
SET guest_name       = COALESCE(:guest_name, guest_name),
    guest_phone      = COALESCE(:guest_phone, guest_phone),
    guest_email      = COALESCE(:guest_email, guest_email),
    date             = COALESCE(:date, date),
    time             = COALESCE(:time, time),
    party_size       = COALESCE(:party_size, party_size),
    duration_minutes = COALESCE(:duration_minutes, duration_minutes),
    table_id         = CASE
                         WHEN COALESCE(:table_id, '__keep__') = '__keep__' THEN table_id
                         WHEN :table_id = '' THEN NULL
                         ELSE :table_id
                       END,
    notes            = COALESCE(:notes, notes),
    internal_notes   = COALESCE(:internal_notes, internal_notes),
    updated_by       = :current_user_id,
    updated_at       = :now
FROM (SELECT 1 AS one) AS anchor
LEFT JOIN reservations_settings s ON s.hub_id = :hub_id AND s.is_deleted = 0
WHERE reservations_reservation.id = :reservation_id
  AND reservations_reservation.hub_id = :hub_id
  AND reservations_reservation.is_deleted = 0
  -- aforo dentro de los límites configurados
  AND COALESCE(:party_size, reservations_reservation.party_size) >= COALESCE(s.min_party_size, 1)
  AND COALESCE(:party_size, reservations_reservation.party_size) <= COALESCE(s.max_party_size, 20)
  -- ventana de antelación, medida contra el reloj del SERVIDOR
  AND erp_datediff_days(
        COALESCE(:date, reservations_reservation.date) || ' ' || COALESCE(:time, reservations_reservation.time),
        :now) >= COALESCE(s.min_advance_hours, 1) / 24.0
  AND erp_datediff_days(
        COALESCE(:date, reservations_reservation.date) || ' ' || COALESCE(:time, reservations_reservation.time),
        :now) <= COALESCE(s.max_advance_days, 30)
  -- el día/hora no está bloqueado (día completo o franja que solape)
  AND NOT EXISTS (
        SELECT 1 FROM reservations_blockeddate b
        WHERE b.hub_id = :hub_id AND b.is_deleted = 0
          AND b.date = COALESCE(:date, reservations_reservation.date)
          AND (b.is_full_day = 1
               OR (b.blocked_from IS NOT NULL AND b.blocked_until IS NOT NULL
                   AND COALESCE(:time, reservations_reservation.time) >= b.blocked_from
                   AND COALESCE(:time, reservations_reservation.time) <= b.blocked_until)))
  -- hay franja activa que contiene la hora Y con hueco, SIN contarse a sí misma
  AND EXISTS (
        SELECT 1 FROM reservations_timeslot t
        WHERE t.hub_id = :hub_id AND t.is_deleted = 0 AND t.is_active = 1
          AND t.day_of_week = erp_dow_mon0(COALESCE(:date, reservations_reservation.date))
          AND COALESCE(:time, reservations_reservation.time) >= t.start_time
          AND COALESCE(:time, reservations_reservation.time) < t.end_time
          AND (SELECT COUNT(*) FROM reservations_reservation r
               WHERE r.hub_id = :hub_id AND r.is_deleted = 0
                 AND r.id <> :reservation_id
                 AND r.date = COALESCE(:date, reservations_reservation.date)
                 AND r.time >= t.start_time AND r.time < t.end_time
                 AND r.status NOT IN ('cancelled', 'no_show')) < t.max_reservations);
