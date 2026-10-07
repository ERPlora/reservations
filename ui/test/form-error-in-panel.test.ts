// pm#513 (out of pm#478) — on a phone, a refused save in Reservations showed NOTHING: the person
// pressed «Reserve», «Add», «Add slot» or «Block date» and the screen stayed as it was.
//
// The refusal did arrive; it was painted in the wrong place. Every form of this module lives in the
// `create` panel of its `ok-data-table`, and under 834 px that panel is a FULL-SCREEN sheet
// (`position: fixed; inset: 0; z-index: 1000`, outfitkit#75). The error banner was a child of the
// PAGE, so on a phone it sat under the sheet, out of sight (bench: hub:stable 1.1.30, 390 px ios —
// the banner was in the DOM, inside the viewport, and not on top).
//
// The rule this file fixes, for the four forms (reservation, waitlist, time slot, blocked date) —
// the same one Customers (customers#97), Services (services#115), Inventory (inventory#118) and
// Appointments (appointments#227) follow:
//
//   · what goes wrong while SAVING a panel's form is painted INSIDE that form, next to the button
//     that was pressed, and scrolled into view — it travels with the panel whatever the width;
//   · what goes wrong in a ROW action (confirm/seat/cancel a booking, contact/remove a waitlist
//     entry, remove a slot or a blocked date) stays on the PAGE: no panel is open then, and a
//     message inside a closed panel is just as invisible;
//   · a later save that works clears the page refusal too: it is the next thing the person did.
//
// Availability has TWO forms (time slot, blocked date), each in its own table's panel: the refusal
// of one must not show up in the other.
import { beforeEach, describe, expect, it, vi } from 'vitest';

class DomainError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const BOOKING = { id: 'r1', guest_name: 'Ana', guest_phone: '600', date: '2026-12-01', time: '21:00:00', party_size: 2, status: 'pending' };
const ENTRY = { id: 'w1', guest_name: 'Luis', guest_phone: '600', date: '2026-12-01', preferred_time: '21:00:00', party_size: 2, is_contacted: false, is_converted: false };
const SLOT = { id: 't1', day_of_week: 1, start_time: '13:00:00', end_time: '16:00:00', max_reservations: 10, is_active: 1 };
const BLOCKED = { id: 'b1', date: '2026-12-24', reason: 'Closed', is_full_day: 1 };

let refusal: Error | null = null;
/** Every element the component scrolled into view AFTER it had painted itself, in order. Scrolling a
 *  banner that has not rendered yet measures a 0-px box: the sheet stops with the banner still half
 *  under the tab bar (seen in the staff#72 bench at 390 px). */
let revealed: Element[] = [];

beforeEach(() => {
  refusal = null;
  revealed = [];
  vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (this: HTMLElement) {
    if ((this as HTMLElement & { hasUpdated?: boolean }).hasUpdated !== false) revealed.push(this);
  });
  (globalThis as Record<string, unknown>).erplora = {
    timezone: 'Europe/Madrid',
    query: async () => [],
    queryOptional: async () => undefined,
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async (name: string) => {
      // reservations#99 — the forms link a Clientes card first; the real create answers its id.
      if (name === 'customers.create') return { new_ids: ['c-new'] };
      if (refusal) throw refusal;
      return {};
    },
    on: () => () => {},
    hasPermission: () => true,
    locale: 'es',
    t: (_c: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> } & Record<string, any>;

async function mount(tag: string, path: string): Promise<Wc> {
  await import(path);
  const el = document.createElement(tag) as Wc;
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: Wc): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

const submitEvent = (): Event => new Event('submit', { cancelable: true });
const rowAction = (actionId: string, row: object): CustomEvent =>
  new CustomEvent('rowAction', { detail: { actionId, row } });

/** The error banner INSIDE the given panel form, or null. */
const inForm = (el: Wc, form: string, testid: string): Element | null =>
  el.shadowRoot.querySelector(`form[slot="create"][data-testid="${form}"] [data-testid="${testid}"]`);

/** The banner inside the form AND scrolled into view: pressing the button at the foot of a long
 *  form, the banner that appears above it is pushed half off a phone screen otherwise. */
const inFormAndRevealed = (el: Wc, form: string, testid: string): Element | null => {
  const banner = inForm(el, form, testid);
  return banner && revealed.includes(banner) ? banner : null;
};

/** The error banner on the PAGE (outside every panel), or null. */
const onPage = (el: Wc, testid: string): Element | null => {
  const banner = el.shadowRoot.querySelector(`[data-testid="${testid}"]`);
  return banner && !banner.closest('form[slot="create"]') ? banner : null;
};

/** How each form is driven: fill a valid new row, save it, and run the row action the server can
 *  refuse (no confirmation step in this module: the row action IS the call). */
interface Screen {
  surface: string;
  tag: string;
  path: string;
  form: string;
  formError: string;
  pageError: string;
  fill: (el: Wc) => void;
  /** Correct one field of the form, the way typing into it does (one `@ionInput` = one render). */
  edit: (el: Wc) => void;
  save: (el: Wc) => Promise<void>;
  rowAct: (el: Wc) => Promise<void>;
}

const SCREENS: Screen[] = [
  {
    surface: 'reservation',
    tag: 'erp-reservations-list',
    path: '../components/erp-reservations-list/erp-reservations-list',
    form: 'reservations-form',
    formError: 'reservations-form-error',
    pageError: 'reservations-page-error',
    fill: (el) => { el.newName = 'Ana'; el.newDate = '2026-12-01'; el.newTime = '21:00'; el.newParty = '2'; },
    edit: (el) => { el.newName = 'Ana B'; },
    save: (el) => el.createReservation(submitEvent()),
    rowAct: (el) => el.onRowAction(rowAction('cancel', BOOKING)),
  },
  {
    surface: 'waitlist',
    tag: 'erp-reservations-waitlist',
    path: '../components/erp-reservations-waitlist/erp-reservations-waitlist',
    form: 'reservations-waitlist-form',
    formError: 'reservations-waitlist-form-error',
    pageError: 'reservations-waitlist-page-error',
    fill: (el) => { el.newName = 'Luis'; el.newPhone = '600'; el.newDate = '2026-12-01'; el.newTime = '21:00'; el.newParty = '2'; },
    edit: (el) => { el.newName = 'Luis B'; },
    save: (el) => el.createEntry(submitEvent()),
    rowAct: (el) => el.onRowAction(rowAction('remove', ENTRY)),
  },
  {
    surface: 'time slot',
    tag: 'erp-reservations-availability',
    path: '../components/erp-reservations-availability/erp-reservations-availability',
    form: 'reservations-availability-slot-form',
    formError: 'reservations-availability-slot-form-error',
    pageError: 'reservations-availability-page-error',
    fill: (el) => { el.slotDay = '1'; el.slotStart = '13:00'; el.slotEnd = '16:00'; el.slotMax = '10'; },
    edit: (el) => { el.slotMax = '12'; },
    save: (el) => el.createSlot(submitEvent()),
    rowAct: (el) => el.onSlotAction(rowAction('remove', SLOT)),
  },
  {
    surface: 'blocked date',
    tag: 'erp-reservations-availability',
    path: '../components/erp-reservations-availability/erp-reservations-availability',
    form: 'reservations-availability-blocked-form',
    formError: 'reservations-availability-blocked-form-error',
    pageError: 'reservations-availability-page-error',
    fill: (el) => { el.blockDate = '2026-12-24'; el.blockReason = 'Closed'; },
    edit: (el) => { el.blockReason = 'Holiday'; },
    save: (el) => el.createBlocked(submitEvent()),
    rowAct: (el) => el.onBlockedAction(rowAction('remove', BLOCKED)),
  },
];

/** A row action the server refuses. */
async function refusedRowAction(el: Wc, s: Screen): Promise<void> {
  refusal = new DomainError('bench.in_use', 'in use');
  await s.rowAct(el);
  await settle(el);
}

describe.each(SCREENS)('pm#513 · $surface: save refusal in the form, row refusal on the page', (s) => {
  it('a refused save lands in the form and is scrolled into view', async () => {
    const el = await mount(s.tag, s.path);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await settle(el);
    const banner = inForm(el, s.form, s.formError);
    expect(banner, 'on a phone the panel covers the page: the refusal has to travel with the form').not.toBeNull();
    expect(inFormAndRevealed(el, s.form, s.formError), 'and it is scrolled into view').not.toBeNull();
    expect(banner?.textContent?.trim()).toBe('rejected');
    expect(onPage(el, s.pageError), 'the page under the sheet shows nothing').toBeNull();
    expect(onPage(el, s.formError), 'the old page banner is gone').toBeNull();
  });

  it('correcting a field after a refusal does not scroll the sheet back to the banner', async () => {
    // The banner is scrolled into view ONCE, when the refusal arrives. Every keystroke re-renders the
    // form: scrolling on every render would yank the sheet away from the field being corrected.
    const el = await mount(s.tag, s.path);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await settle(el);
    revealed = [];
    s.edit(el);
    await settle(el);
    expect(inForm(el, s.form, s.formError), 'the refusal is still there').not.toBeNull();
    expect(revealed, 'but the sheet stays where the person is typing').toEqual([]);
  });

  it('a new attempt clears the previous refusal of the form', async () => {
    const el = await mount(s.tag, s.path);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    refusal = null;
    s.fill(el);
    await s.save(el);
    await settle(el);
    expect(inForm(el, s.form, s.formError)).toBeNull();
  });

  it('a refused row action (no panel open) is shown on the page, not in the form', async () => {
    const el = await mount(s.tag, s.path);
    await refusedRowAction(el, s);
    const banner = onPage(el, s.pageError);
    expect(banner, 'no panel is open: inside the form it would be invisible').not.toBeNull();
    expect(banner?.textContent?.trim()).toBe('in use');
    expect(inForm(el, s.form, s.formError)).toBeNull();
  });

  it('the page error of a refused row action goes away once a later save succeeds', async () => {
    const el = await mount(s.tag, s.path);
    await refusedRowAction(el, s);
    refusal = null;
    s.fill(el);
    await s.save(el);
    await settle(el);
    expect(onPage(el, s.pageError), 'a stale refusal must not stay red after a save that worked').toBeNull();
  });

  it('the page error of a refused row action goes away once a later save is refused too', async () => {
    const el = await mount(s.tag, s.path);
    await refusedRowAction(el, s);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await settle(el);
    expect(onPage(el, s.pageError), 'the refusal that matters now is the form one').toBeNull();
    expect(inForm(el, s.form, s.formError)).not.toBeNull();
  });

  it('running the row action again hides the previous refusal until the new answer arrives', async () => {
    const el = await mount(s.tag, s.path);
    await refusedRowAction(el, s);
    refusal = null;
    await s.rowAct(el);
    await settle(el);
    expect(onPage(el, s.pageError)).toBeNull();
  });

  it('a refused row action does not wipe the refusal still shown in the form', async () => {
    const el = await mount(s.tag, s.path);
    s.fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await s.save(el);
    await refusedRowAction(el, s);
    expect(inForm(el, s.form, s.formError)?.textContent?.trim()).toBe('rejected');
  });
});

describe('pm#513 · availability: each form keeps its own refusal', () => {
  const tag = 'erp-reservations-availability';
  const path = '../components/erp-reservations-availability/erp-reservations-availability';

  it('a refused time slot is not painted in the blocked-date form', async () => {
    const el = await mount(tag, path);
    SCREENS[2].fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await el.createSlot(submitEvent());
    await settle(el);
    expect(inForm(el, 'reservations-availability-slot-form', 'reservations-availability-slot-form-error')).not.toBeNull();
    expect(el.shadowRoot.querySelector('[data-testid="reservations-availability-blocked-form-error"]')).toBeNull();
  });

  it('a refused blocked date is not painted in the time-slot form', async () => {
    const el = await mount(tag, path);
    SCREENS[3].fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await el.createBlocked(submitEvent());
    await settle(el);
    expect(inForm(el, 'reservations-availability-blocked-form', 'reservations-availability-blocked-form-error')).not.toBeNull();
    expect(el.shadowRoot.querySelector('[data-testid="reservations-availability-slot-form-error"]')).toBeNull();
  });
});

describe('pm#513 · availability: saving one form leaves the other form\'s refusal alone', () => {
  const tag = 'erp-reservations-availability';
  const path = '../components/erp-reservations-availability/erp-reservations-availability';
  const SLOT_ERR = ['reservations-availability-slot-form', 'reservations-availability-slot-form-error'] as const;
  const BLOCKED_ERR = ['reservations-availability-blocked-form', 'reservations-availability-blocked-form-error'] as const;

  it('a time slot saved after a refused blocked date keeps the blocked-date refusal', async () => {
    const el = await mount(tag, path);
    SCREENS[3].fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await el.createBlocked(submitEvent());
    refusal = null;
    SCREENS[2].fill(el);
    await el.createSlot(submitEvent());
    await settle(el);
    expect(inForm(el, ...BLOCKED_ERR)?.textContent?.trim(), 'its fields still hold what was refused').toBe('rejected');
  });

  it('a blocked date saved after a refused time slot keeps the time-slot refusal', async () => {
    const el = await mount(tag, path);
    SCREENS[2].fill(el);
    refusal = new DomainError('bench.rejected', 'rejected');
    await el.createSlot(submitEvent());
    refusal = null;
    SCREENS[3].fill(el);
    await el.createBlocked(submitEvent());
    await settle(el);
    expect(inForm(el, ...SLOT_ERR)?.textContent?.trim(), 'its fields still hold what was refused').toBe('rejected');
  });
});

describe('pm#513 · reservation: the refusal of a set_status is on the page for every row action', () => {
  it.each(['confirm', 'seat', 'complete', 'cancel'])('%s', async (actionId) => {
    const el = await mount('erp-reservations-list', '../components/erp-reservations-list/erp-reservations-list');
    refusal = new DomainError('bench.in_use', 'in use');
    await el.onRowAction(rowAction(actionId, BOOKING));
    await settle(el);
    expect(onPage(el, 'reservations-page-error')?.textContent?.trim()).toBe('in use');
  });
});

describe('pm#513 · waitlist: the refusal of every row action is on the page', () => {
  it.each(['contact', 'convert', 'remove'])('%s', async (actionId) => {
    const el = await mount('erp-reservations-waitlist', '../components/erp-reservations-waitlist/erp-reservations-waitlist');
    refusal = new DomainError('bench.in_use', 'in use');
    await el.onRowAction(rowAction(actionId, ENTRY));
    await settle(el);
    expect(onPage(el, 'reservations-waitlist-page-error')?.textContent?.trim()).toBe('in use');
  });
});
