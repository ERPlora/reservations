// reservations#99 — the Clientes card a reservation or a waitlist entry taken by hand belongs to.
//
// The erasure of a card (RESERVATIONS-F22, pm#637) empties the rows that carry its `customer_id`,
// so a row typed at the desk without one kept the guest's data for ever. The forms resolve the card
// before writing, the way the POS quick-create of Clientes does (`erp-customers-pos-search`): the
// card that already carries the number, read by the server as a number of the business's country
// (`customers.by_phone`, CUSTOMERS-F10), or a new card with what was typed (`customers.create`).
//
// Any failure is thrown, never swallowed: a booking written without its card is the bug this
// closes, and a card created after a failed lookup would be a duplicate.

export interface CustomerApi {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
}

export interface TypedGuest {
  name: string;
  phone: string;
}

/** Where a card created here came from — values of Clientes' own `source` list. */
export type GuestSource = 'phone' | 'walk_in';

interface CardRow {
  id?: unknown;
  name?: unknown;
}

/** Case- and accent-blind comparison of two names («lucia» is «Lucía»). */
function fold(name: unknown): string {
  return typeof name === 'string'
    ? name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
    : '';
}

export async function linkCustomer(api: CustomerApi, guest: TypedGuest, source: GuestSource): Promise<string> {
  const name = guest.name.trim();
  const phone = guest.phone.trim();
  if (phone) {
    const found = await api.query<CardRow[]>('customers.by_phone', { phone });
    const cards = (Array.isArray(found) ? found : []).filter((c) => typeof c.id === 'string' && c.id);
    // A number shared by a family: the card with the typed name is hers; otherwise the server's
    // first (Clientes' rule), never a new card for a number that already has one.
    const card = cards.find((c) => fold(c.name) === fold(name)) ?? cards[0];
    if (card) return card.id as string;
  }
  const payload: Record<string, unknown> = { name, source };
  if (phone) payload.phone = phone;
  const out = await api.command<{ new_ids?: unknown[] }>('customers.create', payload);
  const id = out?.new_ids?.[0];
  if (typeof id !== 'string' || !id) throw new Error('customers.create answered no id');
  return id;
}

/**
 * One form's memory of the card it last linked: a booking refused after its card was created (the
 * slot filled up, the day is closed) and retried as it was reuses that card instead of creating a
 * second one — a guest without a phone has nothing else to find her by.
 */
export class GuestCards {
  private last: { key: string; id: string } | null = null;

  async resolve(api: CustomerApi, guest: TypedGuest, source: GuestSource): Promise<string> {
    const key = `${fold(guest.name)}\u0000${guest.phone.trim()}`;
    if (this.last?.key === key) return this.last.id;
    const id = await linkCustomer(api, guest, source);
    this.last = { key, id };
    return id;
  }

  /** The booking was written: the next one looks her card up again (it may have been erased since). */
  forget(): void {
    this.last = null;
  }
}

/** The form's i18n key for a card that could not be resolved: Clientes' refusal of the number is
 *  said as such (the person can fix the digits); anything else, as «the card could not be saved». */
export function linkErrorKey(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'customers.phone_invalid' ? 'ui.errGuestPhoneInvalid' : 'ui.errLinkCustomer';
}
