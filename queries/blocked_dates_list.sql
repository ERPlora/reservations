-- Fechas bloqueadas (festivos/cierres) en una ventana opcional. Runtime inyecta :hub_id.
-- Portado de ReservationService.list_blocked_dates. Binds :date_from/:date_to: '' = sin filtro.
-- reservations#54: `is_full_day` sale como BOOLEANO (en reposo es INTEGER 0/1), que es lo
-- que `blocked_dates.create` declara — así una fila listada se puede volver a crear tal cual.
SELECT id, date, reason, is_full_day <> 0 AS is_full_day, blocked_from, blocked_until
FROM reservations_blockeddate
WHERE hub_id = :hub_id AND is_deleted = 0
