-- Ventanas horarias activas del hub. Runtime inyecta :hub_id.
-- Portado de ReservationService.list_time_slots. El mapeo day_of_week → nombre lo hace el SDK/UI.
SELECT id, day_of_week, start_time, end_time, max_reservations, is_active
FROM reservations_timeslot
WHERE hub_id = :hub_id AND is_deleted = 0 AND is_active = 1
ORDER BY day_of_week ASC, start_time ASC;
