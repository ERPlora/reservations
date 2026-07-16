-- PG-compat (auditoría pm#16, 07-17): los binds BOOLEANOS del schema van envueltos en
-- CASE WHEN :x THEN 1 WHEN NOT :x THEN 0 END — las columnas son INTEGER 0/1 por contrato
-- (§2.5) y Postgres NO castea boolean→bigint (SQLite sí lo toleraba). El tri-estado
-- preserva NULL para los COALESCE de opcionales.
-- Upsert de la config de reservas del hub (1 fila por hub_id). Runtime inyecta
-- :new_id (usado solo en alta), :hub_id, :current_user_id, :now.
-- Portado de ReservationService.update_settings + get_settings (creación lazy). ON CONFLICT(hub_id)
-- actualiza solo los campos enviados (COALESCE(:bind, col) = no tocar si NULL).
-- Requiere el índice único uq_reservations_settings_hub.
INSERT INTO reservations_settings
  (id, hub_id, time_slot_duration, min_party_size, max_party_size,
   min_advance_hours, max_advance_days, auto_confirm, require_phone, require_email,
   no_show_window_minutes, default_duration_minutes,
   send_confirmation_email, send_reminder_email, reminder_hours_before,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id,
   COALESCE(:time_slot_duration, 30), COALESCE(:min_party_size, 1), COALESCE(:max_party_size, 20),
   COALESCE(:min_advance_hours, 1), COALESCE(:max_advance_days, 30), COALESCE(CASE WHEN :auto_confirm THEN 1 WHEN NOT :auto_confirm THEN 0 END, 0),
   COALESCE(CASE WHEN :require_phone THEN 1 WHEN NOT :require_phone THEN 0 END, 1), COALESCE(CASE WHEN :require_email THEN 1 WHEN NOT :require_email THEN 0 END, 0),
   COALESCE(:no_show_window_minutes, 15), COALESCE(:default_duration_minutes, 120),
   COALESCE(CASE WHEN :send_confirmation_email THEN 1 WHEN NOT :send_confirmation_email THEN 0 END, 0), COALESCE(CASE WHEN :send_reminder_email THEN 1 WHEN NOT :send_reminder_email THEN 0 END, 0),
   COALESCE(:reminder_hours_before, 24),
   0, :current_user_id, :current_user_id, :now, :now)
ON CONFLICT(hub_id) DO UPDATE SET
   time_slot_duration       = COALESCE(:time_slot_duration, time_slot_duration),
   min_party_size           = COALESCE(:min_party_size, min_party_size),
   max_party_size           = COALESCE(:max_party_size, max_party_size),
   min_advance_hours        = COALESCE(:min_advance_hours, min_advance_hours),
   max_advance_days         = COALESCE(:max_advance_days, max_advance_days),
   auto_confirm             = COALESCE(CASE WHEN :auto_confirm THEN 1 WHEN NOT :auto_confirm THEN 0 END, auto_confirm),
   require_phone            = COALESCE(CASE WHEN :require_phone THEN 1 WHEN NOT :require_phone THEN 0 END, require_phone),
   require_email            = COALESCE(CASE WHEN :require_email THEN 1 WHEN NOT :require_email THEN 0 END, require_email),
   no_show_window_minutes   = COALESCE(:no_show_window_minutes, no_show_window_minutes),
   default_duration_minutes = COALESCE(:default_duration_minutes, default_duration_minutes),
   send_confirmation_email  = COALESCE(CASE WHEN :send_confirmation_email THEN 1 WHEN NOT :send_confirmation_email THEN 0 END, send_confirmation_email),
   send_reminder_email      = COALESCE(CASE WHEN :send_reminder_email THEN 1 WHEN NOT :send_reminder_email THEN 0 END, send_reminder_email),
   reminder_hours_before    = COALESCE(:reminder_hours_before, reminder_hours_before),
   updated_by               = :current_user_id,
   updated_at               = :now;
