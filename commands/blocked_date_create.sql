-- Bloqueo de una fecha (o franja). Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ReservationService.create_blocked_date. blocked_from/blocked_until son NULL si
-- is_full_day=1. La unicidad (hub, date, blocked_from) la garantiza el índice.
INSERT INTO reservations_blockeddate
  (id, hub_id, date, reason, is_full_day, blocked_from, blocked_until,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :date, :reason, :is_full_day, :blocked_from, :blocked_until,
   0, :current_user_id, :current_user_id, :now, :now);
