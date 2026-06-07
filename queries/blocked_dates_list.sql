-- Fechas bloqueadas (festivos/cierres) en una ventana opcional. Runtime inyecta :hub_id.
-- Portado de ReservationService.list_blocked_dates. Binds :date_from/:date_to: '' = sin filtro.
SELECT id, date, reason, is_full_day, blocked_from, blocked_until
FROM reservations_blockeddate
WHERE hub_id = :hub_id AND is_deleted = 0
