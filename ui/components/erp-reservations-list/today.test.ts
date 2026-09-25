// reservations#45 — Reservas opens on TODAY's service, not on the whole book.
//
// Market decision (the table with the references goes in the PR body): the book of every
// restaurant reservation system opens on the day in progress with a day stepper and the covers
// of the day at the top — OpenTable GuestCenter, SevenRooms, Resy OS, Toast Tables, Tock,
// Lightspeed Reservations, Yelp Guest Manager — and this hub's own agenda already does the same
// (`appointments#93`: prev · date · next over the same list). A separate agenda screen would be a
// second way to read the same rows; the day stepper over the existing list is the simplest one.
//
// What this file pins:
//  1. The list query goes out anchored to the RESTAURANT's today (business zone, not the device),
//     ordered by time — the order the service happens in.
//  2. A header answers the three questions of the shift: which day, how many covers are committed
//     (and in how many bookings), and the next slot with the room left in it.
//  3. The day moves: previous / next / a typed date / back to today — list AND figures follow.
//  4. Searching a name looks through the WHOLE book (the guest who booked next Friday must be
//     found from today); clearing the search puts the day back.
//  5. The figures follow live changes (a new booking updates the covers).
//
// Tests assert on data attributes and i18n KEYS, never on prose: the `t` double returns the key.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MADRID = 'Europe/Madrid';
// 2026-09-25 18:10 in Madrid is 16:10 UTC; the device is set to Auckland (already the 26th there).
const NOW = new Date('2026-09-25T16:10:00Z');
const TODAY = '2026-09-25';

let listCalls: { name: string; params: Record<string, unknown> }[] = [];
let queryCalls: { name: string; params: Record<string, unknown> }[] = [];
let summary: Record<string, unknown>[] = [];
let slots: Record<string, unknown>[] = [];
let blocked: Record<string, unknown>[] = [];
let handlers: Record<string, (p: unknown) => void> = {};
const previousTZ = process.env.TZ;

beforeEach(() => {
  process.env.TZ = 'Pacific/Auckland';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  listCalls = [];
  queryCalls = [];
  handlers = {};
  summary = [{ reservations: 5, covers: 17 }];
  slots = [
    { timeslot_id: 's-lunch', start_time: '13:00:00', end_time: '16:00:00', max_reservations: 10, reserved: 4, available: 6 },
    { timeslot_id: 's-dinner', start_time: '20:00:00', end_time: '23:30:00', max_reservations: 8, reserved: 5, available: 3 },
  ];
  blocked = [];
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    timezone: MADRID,
    query: async (name: string, params: Record<string, unknown> = {}) => {
      queryCalls.push({ name, params: { ...params } });
      if (name === 'reservations.day.summary') return summary;
      if (name === 'reservations.slots.count_for') return slots;
      if (name === 'reservations.blocked_dates.on_date') return blocked;
      return [];
    },
    queryPage: async (name: string, params: Record<string, unknown>) => {
      listCalls.push({ name, params: JSON.parse(JSON.stringify(params)) });
      return { rows: [], total: 0 };
    },
    command: async () => ({}),
    on: (event: string, cb: (p: unknown) => void) => {
      handlers[event] = cb;
      return () => {};
    },
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = previousTZ;
});

type Host = HTMLElement & { shadowRoot: ShadowRoot };

async function settle(el: HTMLElement) {
  const wc = el as unknown as { updateComplete: Promise<unknown> };
  for (let i = 0; i < 3; i += 1) {
    await wc.updateComplete;
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  await wc.updateComplete;
}

async function mount(): Promise<Host> {
  await import('./erp-reservations-list');
  const el = document.createElement('erp-reservations-list') as Host;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

const $ = (el: Host, sel: string) => el.shadowRoot.querySelector(sel) as HTMLElement | null;
const lastList = () => listCalls[listCalls.length - 1]?.params ?? {};
const dateFilter = () => (lastList().filters as Record<string, unknown> | undefined)?.date;
const lastQuery = (name: string) => [...queryCalls].reverse().find((c) => c.name === name)?.params;

async function click(el: Host, sel: string) {
  const b = $(el, sel);
  expect(b, `no control ${sel}`).toBeTruthy();
  b!.click();
  await settle(el);
}

describe('1 · the book opens on the restaurant today, in service order', () => {
  it('the list query is anchored to today on the BUSINESS clock, not the device one', async () => {
    await mount();
    expect(dateFilter(), 'the list is not anchored to a day').toEqual({ from: TODAY, to: TODAY });
  });

  it('the rows come ordered by time: the order the service happens in', async () => {
    await mount();
    expect(lastList().sort).toBe('time');
    expect(lastList().dir).toBe('asc');
  });

  it('the date column no longer offers its own filter box: the day bar owns the date', async () => {
    const el = await mount();
    const table = $(el, 'ok-data-table') as unknown as { columns: { key: string; filterable?: boolean }[] };
    const date = table.columns.find((c) => c.key === 'date');
    expect(date?.filterable ?? false).toBe(false);
  });
});

describe('2 · the header answers the three questions of the shift', () => {
  it('shows the day it is anchored to', async () => {
    const el = await mount();
    expect($(el, '[data-testid="reservations-day"]')?.getAttribute('data-day')).toBe(TODAY);
    expect(($(el, '[data-testid="reservations-day-input"]') as unknown as { value: string }).value).toBe(TODAY);
  });

  it('names the day in sentence case: «Viernes, 25 de septiembre», never «25 De Septiembre»', async () => {
    const el = await mount();
    expect($(el, '.dayname')?.textContent?.trim()).toBe('Viernes, 25 de septiembre');
  });

  it('shows the covers committed and the bookings they come in, from the day summary', async () => {
    const el = await mount();
    expect(lastQuery('reservations.day.summary')).toEqual({ date: TODAY });
    expect($(el, '[data-testid="reservations-covers"]')?.getAttribute('data-value')).toBe('17');
    expect($(el, '[data-testid="reservations-bookings"]')?.getAttribute('data-value')).toBe('5');
  });

  it('the next slot today is the first one that has not ended yet, with the room left', async () => {
    const el = await mount(); // 18:10 in Madrid: lunch ended at 16:00, dinner is next
    expect(lastQuery('reservations.slots.count_for')).toEqual({ date: TODAY });
    const next = $(el, '[data-testid="reservations-next-slot"]');
    expect(next?.getAttribute('data-state')).toBe('open');
    expect(next?.getAttribute('data-start')).toBe('20:00:00');
    expect(next?.getAttribute('data-available')).toBe('3');
  });

  it('a slot in progress is still the one to watch', async () => {
    vi.setSystemTime(new Date('2026-09-25T12:30:00Z')); // 14:30 in Madrid, lunch running
    const el = await mount();
    expect($(el, '[data-testid="reservations-next-slot"]')?.getAttribute('data-start')).toBe('13:00:00');
  });

  it('a full slot says so', async () => {
    slots[1].available = 0;
    const el = await mount();
    expect($(el, '[data-testid="reservations-next-slot"]')?.getAttribute('data-state')).toBe('full');
  });

  it('after the last slot of today there is no next slot, and it says so', async () => {
    vi.setSystemTime(new Date('2026-09-25T21:45:00Z')); // 23:45 in Madrid
    const el = await mount();
    expect($(el, '[data-testid="reservations-next-slot"]')?.getAttribute('data-state')).toBe('over');
  });

  it('a day without active slots reads «no service», not an empty figure', async () => {
    slots = [];
    const el = await mount();
    expect($(el, '[data-testid="reservations-next-slot"]')?.getAttribute('data-state')).toBe('no-service');
  });

  it('a day blocked whole (holiday, closure) reads «closed», whatever the slots say', async () => {
    blocked = [{ id: 'b1', date: TODAY, reason: 'Holiday', is_full_day: true }];
    const el = await mount();
    expect(lastQuery('reservations.blocked_dates.on_date')).toEqual({ date: TODAY });
    expect($(el, '[data-testid="reservations-next-slot"]')?.getAttribute('data-state')).toBe('closed');
  });

  it('a summary that fails to load is painted as an error, not as zero covers', async () => {
    const client = (globalThis as Record<string, unknown>).erplora as Record<string, unknown>;
    const base = client.query as (n: string, p?: Record<string, unknown>) => Promise<unknown>;
    client.query = async (n: string, p?: Record<string, unknown>) => {
      if (n === 'reservations.day.summary') throw new Error('boom');
      return base(n, p);
    };
    const el = await mount();
    expect($(el, '[data-testid="reservations-covers"]')).toBeNull();
    expect($(el, '[data-testid="reservations-summary-error"]')).toBeTruthy();
  });
});

describe('3 · the day moves, and list + figures follow', () => {
  it('next day: list and figures move to tomorrow, and on another day the next slot is its first one', async () => {
    const el = await mount();
    await click(el, '[data-testid="reservations-next-day"]');
    expect(dateFilter()).toEqual({ from: '2026-09-26', to: '2026-09-26' });
    expect(lastQuery('reservations.day.summary')).toEqual({ date: '2026-09-26' });
    expect(lastQuery('reservations.slots.count_for')).toEqual({ date: '2026-09-26' });
    expect($(el, '[data-testid="reservations-next-slot"]')?.getAttribute('data-start')).toBe('13:00:00');
  });

  it('previous day', async () => {
    const el = await mount();
    await click(el, '[data-testid="reservations-prev-day"]');
    expect(dateFilter()).toEqual({ from: '2026-09-24', to: '2026-09-24' });
  });

  it('a typed date', async () => {
    const el = await mount();
    const input = $(el, '[data-testid="reservations-day-input"]')!;
    (input as unknown as { value: string }).value = '2026-10-03';
    input.dispatchEvent(new CustomEvent('ionInput', { detail: { value: '2026-10-03' } }));
    await settle(el);
    expect(dateFilter()).toEqual({ from: '2026-10-03', to: '2026-10-03' });
    expect(lastQuery('reservations.day.summary')).toEqual({ date: '2026-10-03' });
  });

  it('«Today» only shows away from today, and brings the book back to it', async () => {
    const el = await mount();
    expect($(el, '[data-testid="reservations-today"]'), 'the «Today» button shows ON today').toBeNull();
    await click(el, '[data-testid="reservations-next-day"]');
    await click(el, '[data-testid="reservations-today"]');
    expect(dateFilter()).toEqual({ from: TODAY, to: TODAY });
  });
});

describe('4 · a search looks through the whole book', () => {
  it('typing a name drops the day anchor; clearing the search puts it back', async () => {
    const el = await mount();
    const table = $(el, 'ok-data-table')!;
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'garcía' }));
    await settle(el);
    expect(lastList().search).toBe('garcía');
    expect(dateFilter(), 'the search is still trapped in one day').toBeUndefined();
    table.dispatchEvent(new CustomEvent('searchChange', { detail: '' }));
    await settle(el);
    expect(dateFilter()).toEqual({ from: TODAY, to: TODAY });
  });

  // reservations#67: across days, ordering by the hour mixes them («Carmen · 28/9 · 13:15» above
  // «Marta · 25/9 · 20:30»). The matches go in calendar order: day first, then the hour.
  it('the matches of a search come in calendar order; clearing it goes back to the hour', async () => {
    const el = await mount();
    const table = $(el, 'ok-data-table')!;
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'garcía' }));
    await settle(el);
    expect(lastList().sort, 'the matches of several days are still ordered by the hour only').toBe('starts_at');
    expect(lastList().dir).toBe('asc');
    table.dispatchEvent(new CustomEvent('searchChange', { detail: '' }));
    await settle(el);
    expect(lastList().sort).toBe('time');
  });

  it('a column the person sorted by on purpose survives the search', async () => {
    const el = await mount();
    const table = $(el, 'ok-data-table')!;
    table.dispatchEvent(new CustomEvent('sortChange', { detail: { sort: 'guest_name', dir: 'desc' } }));
    await settle(el);
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'garcía' }));
    await settle(el);
    expect(lastList().sort).toBe('guest_name');
    expect(lastList().dir).toBe('desc');
  });

  it('«Clear filters» keeps the book on the day it was showing', async () => {
    const el = await mount();
    await click(el, '[data-testid="reservations-next-day"]');
    const table = $(el, 'ok-data-table')!;
    table.dispatchEvent(new CustomEvent('filterChange', { detail: { col: 'status', value: 'confirmed' } }));
    await settle(el);
    await click(el, '[data-testid="reservations-clear-filters"]');
    expect(dateFilter()).toEqual({ from: '2026-09-26', to: '2026-09-26' });
    expect((lastList().filters as Record<string, unknown>).status).toBeUndefined();
  });
});

describe('5 · the figures follow live changes', () => {
  it('a new booking re-reads the covers of the day', async () => {
    const el = await mount();
    summary = [{ reservations: 6, covers: 21 }];
    handlers['reservations.reservation.created']?.({});
    await settle(el);
    expect($(el, '[data-testid="reservations-covers"]')?.getAttribute('data-value')).toBe('21');
  });
});
