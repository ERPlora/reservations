// reservations#99 — a reservation or a waitlist entry taken by hand is linked to a Clientes card.
//
// The erasure listener (RESERVATIONS-F22, pm#637) empties every row of the erased card by
// `customer_id`; a row typed at the desk carried none, so the guest's name, phone and notes outlived
// the erasure. The forms now resolve the card the way the POS quick-create of Clientes does: the
// card that already carries the number (`customers.by_phone`, compared as a number of the business's
// country), or a new one with what was typed (`customers.create` → `new_ids[0]`).
import { describe, expect, it } from 'vitest';
import { linkCustomer, type CustomerApi } from './link-customer';

interface Call {
  kind: 'query' | 'command';
  name: string;
  params: Record<string, unknown>;
}

function api(opts: {
  byPhone?: unknown[] | Error;
  created?: unknown;
  createError?: Error;
}): CustomerApi & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ kind: 'query', name, params });
      if (opts.byPhone instanceof Error) throw opts.byPhone;
      return (opts.byPhone ?? []) as T;
    },
    async command<T>(name: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ kind: 'command', name, params });
      if (opts.createError) throw opts.createError;
      return (opts.created ?? { new_ids: ['c-new'] }) as T;
    },
  };
}

describe('linkCustomer — the card a hand-taken booking belongs to', () => {
  it('a caller whose number is already on a card is linked to that card, and no card is created', async () => {
    const a = api({ byPhone: [{ id: 'c-ana', name: 'Ana García', phone: '+34600111222' }] });
    const id = await linkCustomer(a, { name: 'Ana', phone: '600 111 222' }, 'phone');
    expect(id).toBe('c-ana');
    expect(a.calls).toEqual([{ kind: 'query', name: 'customers.by_phone', params: { phone: '600 111 222' } }]);
  });

  it('two cards share the number: the one with the typed name wins, ignoring case and accents', async () => {
    const a = api({
      byPhone: [
        { id: 'c-marta', name: 'Marta Ruiz', phone: '+34600111222' },
        { id: 'c-lucia', name: 'Lucía Ruiz', phone: '+34600111222' },
      ],
    });
    expect(await linkCustomer(a, { name: '  lucia ruiz ', phone: '600111222' }, 'phone')).toBe('c-lucia');
  });

  it('two cards share the number and none has the typed name: the first one the server answers', async () => {
    const a = api({
      byPhone: [
        { id: 'c-marta', name: 'Marta Ruiz', phone: '+34600111222' },
        { id: 'c-lucia', name: 'Lucía Ruiz', phone: '+34600111222' },
      ],
    });
    expect(await linkCustomer(a, { name: 'Pepe', phone: '600111222' }, 'phone')).toBe('c-marta');
    expect(a.calls.some((c) => c.name === 'customers.create'), 'a shared number must not spawn a third card').toBe(false);
  });

  it('a new caller gets a card with what was typed, marked with where it came from', async () => {
    const a = api({ byPhone: [], created: { new_ids: ['c-luis'] } });
    const id = await linkCustomer(a, { name: ' Luis Pérez ', phone: ' 600 333 444 ' }, 'phone');
    expect(id).toBe('c-luis');
    expect(a.calls.at(-1)).toEqual({
      kind: 'command',
      name: 'customers.create',
      params: { name: 'Luis Pérez', phone: '600 333 444', source: 'phone' },
    });
  });

  it('without a phone nothing is looked up by number: the card is created with the name alone', async () => {
    const a = api({ created: { new_ids: ['c-walkin'] } });
    expect(await linkCustomer(a, { name: 'Mesa de Juan', phone: '   ' }, 'walk_in')).toBe('c-walkin');
    expect(a.calls).toEqual([
      { kind: 'command', name: 'customers.create', params: { name: 'Mesa de Juan', source: 'walk_in' } },
    ]);
  });

  it('a create that answers no id is a failure, never an unlinked booking', async () => {
    const a = api({ byPhone: [], created: {} });
    await expect(linkCustomer(a, { name: 'Luis', phone: '600333444' }, 'phone')).rejects.toBeInstanceOf(Error);
  });

  it('a lookup row without an id is no card: the booking never carries an empty link', async () => {
    const a = api({ byPhone: [{ name: 'Ana', phone: '+34600111222' }], created: { new_ids: ['c-ana2'] } });
    await expect(linkCustomer(a, { name: 'Ana', phone: '600111222' }, 'phone')).resolves.toBe('c-ana2');
  });

  it('a failed lookup by number is a failure: no card is created blind (it would be a duplicate)', async () => {
    const a = api({ byPhone: new Error('boom') });
    await expect(linkCustomer(a, { name: 'Ana', phone: '600111222' }, 'phone')).rejects.toThrow('boom');
    expect(a.calls.some((c) => c.name === 'customers.create')).toBe(false);
  });

  it('a refused create travels up as it came (its code is what the form translates)', async () => {
    const refusal = Object.assign(new Error('not a phone'), { code: 'customers.phone_invalid' });
    const a = api({ byPhone: [], createError: refusal });
    await expect(linkCustomer(a, { name: 'Luis', phone: '12' }, 'phone')).rejects.toBe(refusal);
  });
});
