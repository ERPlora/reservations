-- Config de reservas del hub (1 fila). Runtime inyecta :hub_id.
-- Portado de ReservationService.get_settings. El "crea si no existe" (lazy default) lo gestiona
-- el SDK/UI o el comando settings.upsert — aquí solo se lee. Devuelve 0 filas si aún no hay config.
SELECT id, time_slot_duration, min_party_size, max_party_size,
       min_advance_hours, max_advance_days, auto_confirm,
       require_phone, require_email, no_show_window_minutes,
       default_duration_minutes, send_confirmation_email,
       send_reminder_email, reminder_hours_before
FROM reservations_settings
WHERE hub_id = :hub_id AND is_deleted = 0
LIMIT 1;
