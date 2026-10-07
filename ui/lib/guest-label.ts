// pm#637 — what the book and the waitlist paint where the guest's name was (RESERVATIONS-F22).
//
// The listener of `customer.anonymized` blanks the name Reservas copied into a reservation or a
// waitlist entry but keeps `customer_id` (it now names the pseudonymised sheet). A linked row with
// no name is therefore an erased customer and reads with the translated label the caller hands in;
// a row with neither a sheet nor a name is not an erasure and gets the neutral dash.

export interface GuestRef {
  customer_id?: unknown;
  guest_name?: unknown;
}

export function guestLabel(row: GuestRef, erasedLabel: string): string {
  const name = typeof row.guest_name === 'string' ? row.guest_name.trim() : '';
  if (name) return name;
  const id = typeof row.customer_id === 'string' ? row.customer_id.trim() : '';
  return id ? erasedLabel : '—';
}
