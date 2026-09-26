// reservations#71 — every field of the "new reservation" form, and the day picker of the list,
// shows its BOX.
//
// The Hub shell pins `mode: 'ios'` (ADR-0143), and there Ionic never paints `fill` on
// ion-input/ion-select/ion-textarea: a control with no `fill` renders as loose text with no border
// (name, phone, date, time, party size and the day picker were exactly that), and a `fill` alone is
// only rescued by the shell's registration shim (hub#1060). The combination that paints on its own
// is `fill="outline" mode="md"`, the convention of the shell (hub#760) and of the modules swept by
// ERPlora/pm#152 — and the one the module-toolkit gate asks for (pm#479).
import { beforeEach, describe, expect, it } from 'vitest';

beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryAll: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async () => ({}),
    on: () => () => {},
    hasPermission: () => true,
    locale: 'en',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

async function mount(): Promise<Wc> {
  await import('./erp-reservations-list');
  const el = document.createElement('erp-reservations-list') as unknown as Wc;
  document.body.appendChild(el);
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
  return el;
}

const CONTROLS = 'ion-input, ion-select, ion-textarea';

function expectBox(f: Element): void {
  const id = f.getAttribute('data-testid') ?? f.tagName;
  expect(f.getAttribute('fill'), `${id}: no fill → no box in ios mode`).toBe('outline');
  expect(f.getAttribute('mode'), `${id}: fill without mode="md" never paints in ios mode`).toBe('md');
}

describe('reservations list: every field has its box in ios mode (reservations#71)', () => {
  it('the five fields of the new reservation form are boxed', async () => {
    const el = await mount();
    const form = el.shadowRoot.querySelector('form[slot="create"]');
    expect(form, 'the create form is projected into the table').not.toBeNull();
    const fields = [...form!.querySelectorAll(CONTROLS)];
    expect(fields.map((f) => f.getAttribute('data-testid'))).toEqual([
      'reservations-guest-name',
      'reservations-guest-phone',
      'reservations-date',
      'reservations-time',
      'reservations-party-size',
    ]);
    for (const f of fields) expectBox(f);
  });

  it('the day picker of the list is boxed', async () => {
    const el = await mount();
    const day = el.shadowRoot.querySelector('[data-testid="reservations-day-input"]');
    expect(day, 'the day picker is on screen').not.toBeNull();
    expectBox(day!);
  });

  it('no control rendered anywhere on the screen is left without its box', async () => {
    const el = await mount();
    const fields = [...el.shadowRoot.querySelectorAll(CONTROLS)];
    expect(fields.length).toBeGreaterThanOrEqual(6);
    for (const f of fields) expectBox(f);
  });
});
