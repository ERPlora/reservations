-- Alta de reserva. Runtime inyecta :new_id, :hub_id, :current_user_id, :now.
-- Portado de ReservationService.create. La validación de party_size vs settings, fecha bloqueada
-- y disponibilidad (motor de availability) va a WASM/runtime — ver WASM-TODO. Aquí se asume
-- payload ya validado por el JSON Schema + handler. status arranca en 'pending'.
INSERT INTO reservations_reservation
  (id, hub_id, customer_id, guest_name, guest_phone, guest_email,
   date, time, party_size, duration_minutes, table_id,
   status, notes, internal_notes,
   is_deleted, created_by, updated_by, created_at, updated_at)
VALUES
  (:new_id, :hub_id, :customer_id, :guest_name, :guest_phone, :guest_email,
   :date, :time, :party_size, :duration_minutes, :table_id,
   'pending', :notes, :internal_notes,
   0, :current_user_id, :current_user_id, :now, :now);
