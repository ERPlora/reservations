-- Alta de ventana horaria. Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ReservationService.create_time_slot. La unicidad (hub, day, start, end) la garantiza
-- el índice uq_reservations_timeslot_per_hub.
INSERT INTO reservations_timeslot
  (id, hub_id, day_of_week, start_time, end_time, max_reservations, is_active,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :day_of_week, :start_time, :end_time, :max_reservations, 1,
   0, :current_user_id, :current_user_id, :now, :now);
