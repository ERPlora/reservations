-- Alta en lista de espera. Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ReservationService.create_waitlist_entry.
INSERT INTO reservations_waitlistentry
  (id, hub_id, customer_id, guest_name, guest_phone, guest_email,
   date, preferred_time, party_size, notes,
   is_contacted, is_converted, reservation_id,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :customer_id, :guest_name, :guest_phone, :guest_email,
   :date, :preferred_time, :party_size, :notes,
   0, 0, NULL,
   0, :current_user_id, :current_user_id, :now, :now);
