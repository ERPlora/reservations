// reservations#77 — the hours of Reservations follow the HUB's language, not the browser's.
//
// With the hub in Spanish, the hour of a new reservation, the preferred hour of a waitlist entry
// and the start/end of a time slot read «07:30 PM» on an English browser. Those fields were native
// `<input type="time">`: Chromium paints that control with the BROWSER's (operating system's)
// clock and ignores the hub language — the finding schedules#50, appointments#214 and staff#86
// closed. The fix is the same one: the module paints the time itself, in the hub clock (24 h in
// Spanish), as a text field read back by `parseWallTime` (it understands «19:30», «1930», «9» or
// «7:30 pm»), and what is sent is always 'HH:MM:SS'. The tables read that very clock.
import { beforeEach, describe, expect, it } from 'vitest';

const commands: { name: string; payload: Record<string, unknown> }[] = [];

const SLOT = { id: 't1', day_of_week: 4, start_time: '19:30:00', end_time: '23:00:00', max_reservations: 10, is_active: 1 };
const OCCUPANCY = [{ timeslot_id: 't1', start_time: '19:30:00', end_time: '23:00:00', max_reservations: 10, reserved: 2, available: 8 }];

function install(locale: 'es' | 'en') {
  commands.length = 0;
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => (name === 'reservations.slots.count_for' ? OCCUPANCY : []),
    queryAll: async () => [],
    queryPage: async (name: string) => (name === 'reservations.timeslots.list' ? { rows: [SLOT], total: 1 } : { rows: [], total: 0 }),
    command: async (name: string, payload: Record<string, unknown>) => {
      commands.push({ name, payload });
      // reservations#99 — the forms link a Clientes card first; the real create answers its id.
      return name === 'customers.create' ? { new_ids: ['c-new'] } : {};
    },
    on: () => () => {},
    locale,
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

/** Blank spaces normalized: `Intl` separates «AM/PM» with a narrow no-break space. */
const plain = (s: string) => s.replace(/\s/g, ' ');
const shown = (el: Wc, testid: string) => plain(String(field(el, testid)?.value ?? ''));

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

/** A paste event carrying `text` (happy-dom has no DataTransfer-backed ClipboardEvent). */
async function paste(el: Wc, testid: string, text: string) {
  const input = field(el, testid)!;
  const ev = new Event('paste', { bubbles: true, composed: true, cancelable: true }) as Event & { clipboardData: unknown };
  ev.clipboardData = { getData: () => text };
  input.dispatchEvent(ev);
  await el.updateComplete;
  return ev;
}

const EXPECTED = {
  es: { evening: '19:30', late: '23:00', range: '19:30–23:00' },
  en: { evening: '07:30 PM', late: '11:00 PM', range: '07:30 PM–11:00 PM' },
} as const;

/** One time field of a form: where it lives, the state it fills, the command it ends up in. */
interface TimeForm {
  screen: string;
  tag: string;
  testid: string;
  /** The component state holding the stored 'HH:MM' of this field. */
  state: string;
  /** Fills the rest of the form so the save is only up to the time. */
  fill: (el: Wc) => void;
  save: (el: Wc) => Promise<void>;
  submit: string;
  command: string;
  /** The payload key the hour travels in. */
  key: string;
  error: string;
}

const FORMS: TimeForm[] = [
  {
    screen: 'new reservation',
    tag: 'erp-reservations-list',
    testid: 'reservations-time',
    state: 'newTime',
    fill: (el) => Object.assign(el, { newName: 'Ana', newDate: '2026-10-02' }),
    save: (el) => (el.createReservation as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-submit',
    command: 'reservations.reservations.create',
    key: 'time',
    error: 'formError',
  },
  {
    screen: 'waitlist entry',
    tag: 'erp-reservations-waitlist',
    testid: 'reservations-waitlist-time',
    state: 'newTime',
    fill: (el) => Object.assign(el, { newName: 'Luis', newPhone: '600', newDate: '2026-10-02' }),
    save: (el) => (el.createEntry as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-waitlist-submit',
    command: 'reservations.waitlist.create',
    key: 'preferred_time',
    error: 'formError',
  },
  {
    screen: 'time slot start',
    tag: 'erp-reservations-availability',
    testid: 'reservations-availability-slot-start',
    state: 'slotStart',
    fill: (el) => Object.assign(el, { slotEnd: '23:00' }),
    save: (el) => (el.createSlot as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-availability-slot-submit',
    command: 'reservations.timeslots.create',
    key: 'start_time',
    error: 'slotFormError',
  },
  {
    screen: 'time slot end',
    tag: 'erp-reservations-availability',
    testid: 'reservations-availability-slot-end',
    state: 'slotEnd',
    fill: (el) => Object.assign(el, { slotStart: '13:00' }),
    save: (el) => (el.createSlot as (e: Event) => Promise<void>).call(el, new Event('submit')),
    submit: 'reservations-availability-slot-submit',
    command: 'reservations.timeslots.create',
    key: 'end_time',
    error: 'slotFormError',
  },
];

for (const locale of ['es', 'en'] as const) {
  const want = EXPECTED[locale];

  for (const f of FORMS) {
    describe(`reservations#77 — ${f.screen} in the hub clock (${locale})`, () => {
      beforeEach(() => install(locale));

      it('the field is numeric text in md mode, never a native type=time', async () => {
        const el = await mount(f.tag);
        expect(el.shadowRoot.querySelector('ion-input[type="time"]'), 'a native time field paints the browser clock').toBeNull();
        const input = field(el, f.testid)!;
        expect(input, f.testid).toBeTruthy();
        expect(input.getAttribute('type')).toBe('text');
        expect(input.getAttribute('inputmode'), 'the phone must open the numeric keypad').toBe('numeric');
        expect(input.getAttribute('mode'), 'fill=outline only paints in md').toBe('md');
        expect(input.getAttribute('fill')).toBe('outline');
        expect(input.getAttribute('placeholder')).toBe('ui.timePlaceholder');
      });

      it('typing «1930» stores 19:30 and, on leaving, repaints it in the hub clock', async () => {
        const el = await mount(f.tag);
        await type(el, f.testid, '1930');
        expect(el[f.state]).toBe('19:30');
        expect(shown(el, f.testid), 'what she is typing stays on screen').toBe('1930');
        await leave(el, f.testid);
        expect(shown(el, f.testid)).toBe(want.evening);
      });

      it('a time pasted as «7:30 pm» is stored as 19:30 and painted in the hub clock at once', async () => {
        const el = await mount(f.tag);
        const ev = await paste(el, f.testid, '7:30 pm');
        expect(ev.defaultPrevented).toBe(true);
        expect(el[f.state]).toBe('19:30');
        expect(shown(el, f.testid)).toBe(want.evening);
      });

      it('pasting text that is not a time is left to the browser (not swallowed)', async () => {
        const el = await mount(f.tag);
        const ev = await paste(el, f.testid, 'dinner');
        expect(ev.defaultPrevented).toBe(false);
        expect(el[f.state]).toBe('');
      });

      it('the save sends HH:MM:SS whatever the spelling typed, and the next form starts empty', async () => {
        const el = await mount(f.tag);
        f.fill(el);
        await type(el, f.testid, '7:30 pm');
        await f.save(el);
        await el.updateComplete;
        const cmd = commands.find((c) => c.name === f.command);
        expect(cmd, 'the form must be saved').toBeTruthy();
        expect(cmd!.payload[f.key]).toBe('19:30:00');
        expect(el[f.error]).toBe('');
        expect(shown(el, f.testid), 'no stale text after the save').toBe('');
      });

      it('a half-typed hour («19:») never keeps the last valid one: the save is refused, saying why', async () => {
        const el = await mount(f.tag);
        f.fill(el);
        await type(el, f.testid, '1930');
        await type(el, f.testid, '19:');
        expect(el[f.state]).toBe('');
        await leave(el, f.testid);
        expect(shown(el, f.testid), 'the unreadable text stays so the refusal points at it').toBe('19:');
        expect(field(el, f.submit)!.hasAttribute('disabled'), 'the button must let her ask why').toBe(false);
        await f.save(el);
        expect(el[f.error]).toBe('ui.valTimeUnreadable');
        expect(commands.filter((c) => c.name === f.command)).toHaveLength(0);
      });

      it('an emptied field still keeps the save button off', async () => {
        const el = await mount(f.tag);
        f.fill(el);
        await type(el, f.testid, '');
        expect(field(el, f.submit)!.hasAttribute('disabled')).toBe(true);
      });
    });
  }

  describe(`reservations#77 — the tables read the hub clock (${locale})`, () => {
    beforeEach(() => install(locale));

    type Col = { key: string; format?: (r: Record<string, unknown>) => string };

    it('the reservations list shows the hour in the hub clock', async () => {
      const el = await mount('erp-reservations-list');
      const col = (el.columns as Col[]).find((c) => c.key === 'time')!;
      expect(plain(col.format!({ time: '19:30:00' }))).toBe(want.evening);
    });

    it('the waitlist shows the preferred hour in the hub clock', async () => {
      const el = await mount('erp-reservations-waitlist');
      const col = (el.columns as Col[]).find((c) => c.key === 'preferred_time')!;
      expect(plain(col.format!({ preferred_time: '19:30:00' }))).toBe(want.evening);
    });

    it('the time slots table shows start and end in the hub clock, never the raw HH:MM:SS', async () => {
      const el = await mount('erp-reservations-availability');
      const cols = el.slotColumns as Col[];
      expect(plain(cols.find((c) => c.key === 'start_time')!.format!(SLOT))).toBe(want.evening);
      expect(plain(cols.find((c) => c.key === 'end_time')!.format!(SLOT))).toBe(want.late);
    });

    it('the occupancy of the day shows each slot in the hub clock', async () => {
      const el = await mount('erp-reservations-availability');
      const col = (el.occColumns as Col[]).find((c) => c.key === 'slot')!;
      expect(plain(col.format!(OCCUPANCY[0]))).toBe(want.range);
    });

    it('the card of a time slot (phone) names its start in the hub clock', async () => {
      const el = await mount('erp-reservations-availability');
      const table = el.shadowRoot.querySelector('ok-data-table#slots') as unknown as { cardTitle: (r: Record<string, unknown>) => string };
      expect(plain(table.cardTitle(SLOT))).toBe(`ui.dayFriday · ${want.evening}`);
    });
  });
}

describe('reservations#77 — the texts of a time field exist in both languages', () => {
  it('en and es carry ui.timePlaceholder and ui.valTimeUnreadable', async () => {
    const en = (await import('../../locales/en.json')).default as { ui: Record<string, string> };
    const es = (await import('../../locales/es.json')).default as { ui: Record<string, string> };
    for (const key of ['timePlaceholder', 'valTimeUnreadable']) {
      expect(en.ui[key], `en ui.${key}`).toBeTruthy();
      expect(es.ui[key], `es ui.${key}`).toBeTruthy();
    }
  });
});
