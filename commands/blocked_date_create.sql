-- PG-compat (auditoría pm#16, 07-17): los binds BOOLEANOS del schema van envueltos en
-- CASE WHEN :x THEN 1 WHEN NOT :x THEN 0 END — las columnas son INTEGER 0/1 por contrato
-- (§2.5) y Postgres NO castea boolean→bigint (SQLite sí lo toleraba). El tri-estado
-- preserva NULL para los COALESCE de opcionales.
-- Bloqueo de una fecha (o franja). Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ReservationService.create_blocked_date. blocked_from/blocked_until son NULL si
-- is_full_day=1. La unicidad (hub, date, blocked_from) la garantiza el índice.
INSERT INTO reservations_blockeddate
  (id, hub_id, date, reason, is_full_day, blocked_from, blocked_until,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :date, :reason, CASE WHEN :is_full_day THEN 1 WHEN NOT :is_full_day THEN 0 END, :blocked_from, :blocked_until,
   0, :current_user_id, :current_user_id, :now, :now);
