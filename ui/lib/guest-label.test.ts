// pm#637 — what the book and the waitlist paint where the guest's name was.
//
// When Clientes erases a customer's personal data (GDPR), Reservas blanks the name it copied into
// her reservations and waitlist entries (RESERVATIONS-F22) but keeps the link to the pseudonymised
// sheet. An empty cell would read as a broken row, so the screen says «Deleted customer» — the
// words Citas uses for the same case. A row with no sheet and no name is not an erasure: it gets
// the neutral dash, never a claim that somebody was deleted.
import { describe, expect, it } from 'vitest';
import { guestLabel } from './guest-label';

const ERASED = 'Deleted customer';

describe('guestLabel', () => {
  it('a written name is shown as it is', () => {
    expect(guestLabel({ customer_id: 'c1', guest_name: 'Ana López' }, ERASED)).toBe('Ana López');
    expect(guestLabel({ customer_id: null, guest_name: 'Walk-in Luis' }, ERASED)).toBe('Walk-in Luis');
  });

  it('a linked sheet with a blank name is an erased customer', () => {
    expect(guestLabel({ customer_id: 'c1', guest_name: '' }, ERASED)).toBe(ERASED);
    expect(guestLabel({ customer_id: 'c1', guest_name: null }, ERASED)).toBe(ERASED);
    expect(guestLabel({ customer_id: 'c1' }, ERASED)).toBe(ERASED);
  });

  it('no sheet and no name is a dash, not an erasure', () => {
    expect(guestLabel({ customer_id: '', guest_name: '' }, ERASED)).toBe('—');
    expect(guestLabel({ customer_id: null, guest_name: null }, ERASED)).toBe('—');
    expect(guestLabel({}, ERASED)).toBe('—');
  });

  it('a link made of blanks is no link', () => {
    expect(guestLabel({ customer_id: '  ', guest_name: '' }, ERASED)).toBe('—');
  });

  it('a name made of blanks is no name', () => {
    expect(guestLabel({ customer_id: 'c1', guest_name: '   ' }, ERASED)).toBe(ERASED);
  });
});
