// reservations#78 — the dates of Reservations follow the HUB's language, not the browser's.
//
// With the hub in Spanish, the date of a new reservation, the day picker of the book, the date of a
// waitlist entry and the two dates of Availability (occupancy, blocked date) read «09/29/2026» on a
// US-English browser: they were native `<input type="date">`, which Chromium paints with the
// BROWSER's (operating system's) locale. Whoever typed «03/04/2026» meaning the 3rd of April saved
// the 4th of March. The fix is the one schedules#56 and appointments#242 made: the module paints
// the date itself in the hub's day/month order, as numeric text read back by `parseCalendarDate`
// (digits only for the iPhone keypad, which has no «/», and a pasted ISO date), and what is sent is
// always 'YYYY-MM-DD'.
import { beforeEach, describe, expect, it } from 'vitest';

const commands: { name: string; payload: Record<string, unknown> }[] = [];
const queries: { name: string; params: Record<string, unknown> }[] = [];

function install(locale: string) {
  commands.length = 0;
  queries.length = 0;
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string, params: Record<string, unknown>) => {
      queries.push({ name, params });
      return [];
    },
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      // reservations#99 — the forms link a Clientes card first; the real create answers its id.
      return name === 'customers.create' ? { new_ids: ['c-new'] } : {};
    },
    on: () => () => {},
    locale,
    timezone: 'Europe/Madrid',
    hasPermission: () => true,
    // Keys, not prose (ADR-0055): the assertions below read the error CODE.
    t: (_catalog: unknown, key: string) => key,
  };
}

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, unknown>;

async function mount(tag: string): Promise<Wc> {
  if (tag === 'erp-reservations-list') await import('./erp-reservations-list/erp-reservations-list');
  else if (tag === 'erp-reservations-waitlist') await import('./erp-reservations-waitlist/erp-reservations-waitlist');
  else await import('./erp-reservations-availability/erp-reservations-availability');
  const el = document.createElement(tag) as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

type Field = HTMLElement & { value?: string };
const field = (el: Wc, testid: string) => el.shadowRoot.querySelector(`[data-testid="${testid}"]`) as Field | null;
const shown = (el: Wc, testid: string) => String(field(el, testid)?.value ?? '');

/** What the browser hands over while she types: `ion-input` re-emits it as `ionInput`. */
async function type(el: Wc, testid: string, value: string) {
  const input = field(el, testid);
  expect(input, `${testid} must be rendered`).toBeTruthy();
  input!.value = value;
  input!.dispatchEvent(new CustomEvent('ionInput', { detail: { value }, bubbles: true, composed: true }));
  await el.updateComplete;
}

/** Leaving the field (blur / Enter): `ion-input` emits `ionChange`. */
async function leave(el: Wc, testid: string) {
  const input = field(el, testid)!;
  input.dispatchEvent(new CustomEvent('ionChange', { detail: { value: input.value }, bubbles: true, composed: true }));
  await el.updateComplete;
}

async function click(el: Wc, testid: string) {
  field(el, testid)!.dispatchEvent(new Event('click', { bubbles: true, composed: true }));
  await el.updateComplete;
}

/** How the 3rd of April 2026 is written in each language, and how the ambiguous «03/04/2026» is read. */
const EXPECTED = {
  es: { april3: '03/04/2026', sept29: '29/09/2026', typed: '2026-04-03', digits: '03042026' },
  en: { april3: '04/03/2026', sept29: '09/29/2026', typed: '2026-03-04', digits: '04032026' },
} as const;

const ALL_FIELDS: { tag: string; testid: string }[] = [
  { tag: 'erp-reservations-list', testid: 'reservations-date' },
  { tag: 'erp-reservations-list', testid: 'reservations-day-input' },
  { tag: 'erp-reservations-waitlist', testid: 'reservations-waitlist-date' },
  { tag: 'erp-reservations-availability', testid: 'reservations-availability-occupancy-date' },
  { tag: 'erp-reservations-availability', testid: 'reservations-availability-blocked-date' },
];

/** One date field of a form: where it lives, the state it fills, the command it ends up in. */
interface DateForm {
  screen: string;
  tag: string;
  testid: string;
  /** The component state holding the stored 'YYYY-MM-DD' of this field. */
  state: string;
  /** Fills the rest of the form so the save is only up to the date. */
  fill: (el: Wc) => void;
  save: (el: Wc) => Promise<void>;
  submit: string;
  command: string;
  error: string;
}

const FORMS: DateForm[] = [
  {
    screen: 'new reservation',
    tag: 'erp-reservations-list',
    testid: 'reservations-date',
    state: 'newDate',
    fill: (el) => Object.assign(el, { newName: 'Ana', newTime: '19:30' }),
    save: (el) => (el.createReservation as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-submit',
    command: 'reservations.reservations.create',
    error: 'formError',
  },
  {
    screen: 'waitlist entry',
    tag: 'erp-reservations-waitlist',
    testid: 'reservations-waitlist-date',
    state: 'newDate',
    fill: (el) => Object.assign(el, { newName: 'Luis', newPhone: '600', newTime: '19:30' }),
    save: (el) => (el.createEntry as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-waitlist-submit',
    command: 'reservations.waitlist.create',
    error: 'formError',
  },
  {
    screen: 'blocked date',
    tag: 'erp-reservations-availability',
    testid: 'reservations-availability-blocked-date',
    state: 'blockDate',
    fill: () => {},
    save: (el) => (el.createBlocked as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-availability-blocked-submit',
    command: 'reservations.blocked_dates.create',
    error: 'blockedFormError',
  },
];

for (const locale of ['es', 'en'] as const) {
  const want = EXPECTED[locale];

  describe(`reservations#78 — every date field is numeric text in the hub order (${locale})`, () => {
    beforeEach(() => install(locale));

    for (const f of ALL_FIELDS) {
      it(`${f.testid}: text in md mode with the numeric keypad, never a native type=date`, async () => {
        const el = await mount(f.tag);
        expect(el.shadowRoot.querySelector('ion-input[type="date"]'), 'a native date field paints the browser order').toBeNull();
        const input = field(el, f.testid)!;
        expect(input, f.testid).toBeTruthy();
        expect(input.getAttribute('type')).toBe('text');
        expect(input.getAttribute('inputmode'), 'the phone must open the numeric keypad').toBe('numeric');
        expect(input.getAttribute('mode'), 'fill=outline only paints in md').toBe('md');
        expect(input.getAttribute('fill')).toBe('outline');
        expect(input.getAttribute('placeholder')).toBe('ui.datePlaceholder');
      });
    }
  });

  for (const f of FORMS) {
    describe(`reservations#78 — ${f.screen} date in the hub order (${locale})`, () => {
      beforeEach(() => install(locale));

      it('typing «03/04/2026» stores the date in the hub order and, on leaving, repaints it', async () => {
        const el = await mount(f.tag);
        await type(el, f.testid, '3/4/2026');
        expect(el[f.state]).toBe(want.typed);
        expect(shown(el, f.testid), 'what she is typing stays on screen').toBe('3/4/2026');
        await leave(el, f.testid);
        expect(shown(el, f.testid), 'repainted zero-padded, same order as typed').toBe(formatted(want.typed, locale));
      });

      it('digits only (iPhone keypad, no «/») are read in the hub order', async () => {
        const el = await mount(f.tag);
        await type(el, f.testid, want.digits);
        expect(el[f.state]).toBe('2026-04-03');
        await leave(el, f.testid);
        expect(shown(el, f.testid)).toBe(want.april3);
      });

      it('the save sends YYYY-MM-DD and the next form starts empty', async () => {
        const el = await mount(f.tag);
        f.fill(el);
        await type(el, f.testid, want.sept29);
        await f.save(el);
        await el.updateComplete;
        const cmd = commands.find((c) => c.name === f.command);
        expect(cmd, 'the form must be saved').toBeTruthy();
        expect(cmd!.payload.date).toBe('2026-09-29');
        expect(el[f.error]).toBe('');
        expect(shown(el, f.testid), 'no stale text after the save').toBe('');
      });

      it('an impossible or half-typed date never keeps the last valid one: the save is refused, saying why', async () => {
        const el = await mount(f.tag);
        f.fill(el);
        await type(el, f.testid, want.sept29);
        await type(el, f.testid, locale === 'es' ? '31/02/2026' : '02/31/2026');
        expect(el[f.state]).toBe('');
        await leave(el, f.testid);
        expect(shown(el, f.testid), 'the unreadable text stays so the refusal points at it').toBe(locale === 'es' ? '31/02/2026' : '02/31/2026');
        expect(field(el, f.submit)!.hasAttribute('disabled'), 'the button must let her ask why').toBe(false);
        await f.save(el);
        expect(el[f.error]).toBe('ui.valDateUnreadable');
        expect(commands.filter((c) => c.name === f.command)).toHaveLength(0);
      });

      it('an emptied field keeps the save button off', async () => {
        const el = await mount(f.tag);
        f.fill(el);
        await type(el, f.testid, '');
        expect(field(el, f.submit)!.hasAttribute('disabled')).toBe(true);
      });
    });
  }

  describe(`reservations#78 — the day picker of the book (${locale})`, () => {
    beforeEach(() => install(locale));

    it('shows the day of the book in the hub order', async () => {
      const el = await mount('erp-reservations-list');
      el.day = '2026-09-29';
      await el.updateComplete;
      expect(shown(el, 'reservations-day-input')).toBe(want.sept29);
    });

    it('a complete date moves the book to that day; a half-typed one does not move it', async () => {
      const el = await mount('erp-reservations-list');
      el.day = '2026-09-29';
      await el.updateComplete;
      await type(el, 'reservations-day-input', '03/04');
      expect(el.day, 'half-typed: the book stays').toBe('2026-09-29');
      await type(el, 'reservations-day-input', '03/04/2026');
      expect(el.day).toBe(want.typed);
      expect(field(el, 'reservations-day')!.getAttribute('data-day')).toBe(want.typed);
      expect(queries.some((q) => q.name === 'reservations.day.summary' && q.params.date === want.typed), 'the figures follow the day').toBe(true);
      await leave(el, 'reservations-day-input');
      expect(shown(el, 'reservations-day-input')).toBe(formatted(want.typed, locale));
    });

    it('leaving with an unreadable text repaints the day the book is still on', async () => {
      const el = await mount('erp-reservations-list');
      el.day = '2026-09-29';
      await el.updateComplete;
      await type(el, 'reservations-day-input', '31/02');
      await leave(el, 'reservations-day-input');
      expect(el.day).toBe('2026-09-29');
      expect(shown(el, 'reservations-day-input')).toBe(want.sept29);
    });

    it('the previous/next day arrows repaint the field even while a text is being typed', async () => {
      const el = await mount('erp-reservations-list');
      el.day = '2026-09-29';
      await el.updateComplete;
      await type(el, 'reservations-day-input', '03/04');
      await click(el, 'reservations-next-day');
      expect(el.day).toBe('2026-09-30');
      expect(shown(el, 'reservations-day-input')).toBe(locale === 'es' ? '30/09/2026' : '09/30/2026');
      await type(el, 'reservations-day-input', '03/04');
      await click(el, 'reservations-prev-day');
      expect(el.day).toBe('2026-09-29');
      expect(shown(el, 'reservations-day-input')).toBe(want.sept29);
    });
  });

  describe(`reservations#78 — the occupancy date of Availability (${locale})`, () => {
    beforeEach(() => install(locale));

    it('a complete date loads the occupancy of that day; a half-typed one loads nothing', async () => {
      const el = await mount('erp-reservations-availability');
      el.occDate = '2026-09-29';
      await el.updateComplete;
      expect(shown(el, 'reservations-availability-occupancy-date')).toBe(want.sept29);
      queries.length = 0;
      await type(el, 'reservations-availability-occupancy-date', '03/04');
      expect(el.occDate).toBe('2026-09-29');
      expect(queries.filter((q) => q.name === 'reservations.slots.count_for')).toHaveLength(0);
      await type(el, 'reservations-availability-occupancy-date', '03/04/2026');
      expect(el.occDate).toBe(want.typed);
      expect(queries.filter((q) => q.name === 'reservations.slots.count_for').map((q) => q.params.date)).toEqual([want.typed]);
      await leave(el, 'reservations-availability-occupancy-date');
      expect(shown(el, 'reservations-availability-occupancy-date')).toBe(formatted(want.typed, locale));
    });

    it('leaving with an unreadable text repaints the date the occupancy is still on', async () => {
      const el = await mount('erp-reservations-availability');
      el.occDate = '2026-09-29';
      await el.updateComplete;
      await type(el, 'reservations-availability-occupancy-date', '31/02/2026');
      await leave(el, 'reservations-availability-occupancy-date');
      expect(el.occDate).toBe('2026-09-29');
      expect(shown(el, 'reservations-availability-occupancy-date')).toBe(want.sept29);
    });
  });
}

/** How the two ISO dates the tests type are painted back (written out, not computed by the helper). */
function formatted(iso: string, locale: 'es' | 'en'): string {
  const table: Record<string, Record<'es' | 'en', string>> = {
    '2026-04-03': { es: '03/04/2026', en: '04/03/2026' },
    '2026-03-04': { es: '04/03/2026', en: '03/04/2026' },
  };
  return table[iso][locale];
}

describe('reservations#78 — a hub locale Intl cannot read still paints and reads day first', () => {
  beforeEach(() => install('es_ES'));

  it('the blocked date reads «03/04/2026» as the 3rd of April and paints it back', async () => {
    const el = await mount('erp-reservations-availability');
    await type(el, 'reservations-availability-blocked-date', '03/04/2026');
    expect(el.blockDate).toBe('2026-04-03');
    await leave(el, 'reservations-availability-blocked-date');
    expect(shown(el, 'reservations-availability-blocked-date')).toBe('03/04/2026');
  });
});

describe('reservations#78 — the texts of a date field exist in both languages', () => {
  it('en and es carry ui.datePlaceholder in their own order and ui.valDateUnreadable', async () => {
    const en = (await import('../../locales/en.json')).default as { ui: Record<string, string> };
    const es = (await import('../../locales/es.json')).default as { ui: Record<string, string> };
    expect(en.ui.datePlaceholder).toBe('mm/dd/yyyy');
    expect(es.ui.datePlaceholder).toBe('dd/mm/aaaa');
    expect(en.ui.valDateUnreadable, 'en ui.valDateUnreadable').toBeTruthy();
    expect(es.ui.valDateUnreadable, 'es ui.valDateUnreadable').toBeTruthy();
    expect(es.ui.valDateUnreadable).not.toBe(en.ui.valDateUnreadable);
  });
});
