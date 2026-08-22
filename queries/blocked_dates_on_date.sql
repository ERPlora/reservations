-- Bloqueos vivos (festivos/cierres) de UNA fecha concreta (read autoritativa del handler WASM
-- de `create` — ADR-0069, reservations#31). Antes el handler no podía distinguir «día
-- bloqueado» de «turno lleno»: todo rechazo llegaba como el CHECK crudo de `reservations__gate`.
--
-- `:date` llega de `reads.params` (`payload.date`, YYYY-MM-DD): comparación exacta por texto,
-- sin zona horaria. El corte fino (¿día completo o franja `blocked_from`..`blocked_until` que
-- cubre la hora?) lo hace el handler, que ya normalizó la hora a HH:MM:SS — la misma regla
-- inclusiva que aplica el gate de `_create_gated_insert.sql`.
SELECT id, date, reason, is_full_day, blocked_from, blocked_until
FROM reservations_blockeddate
WHERE hub_id = :hub_id AND is_deleted = 0 AND date = :date
ORDER BY date, id;
