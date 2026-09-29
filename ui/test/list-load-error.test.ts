// A list that could not load must not read «No …» + «0 records» (pm#533, hub#2328).
//
// The shell's `<ok-data-table>` (OutfitKit ≥ 0.1.113) paints a failed load itself: «could not
// load», the reason and a Retry button. Each reservations table (waitlist, occupancy, time slots,
// blocked dates, the book) hands it its `error` and reloads on its `retry` event — and drops its
// own red banner, which would say the same thing twice. But a module paints with the SHELL's
// OutfitKit (ADR-0451): on a hub whose table has no `error` property the banner is the only place
// the reason is shown, so it stays.
//
// The book (reservations#41) steps its table aside when there is nothing to show and paints one
// full block instead (loading / error / first run): there the table is hidden, so that block keeps
// the error and its Retry. The table only carries the error while it is on screen (a search is on).
//
// The shell's table is stood in for by a bare element registered BEFORE the screens load (as the
// shell does at boot; the screens' own `define()` then loses, like in the hub). Its `error`
// property is added or removed per test, which is exactly what `dataTableShowsLoadError()` reads.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

class ShellTable extends HTMLElement {}
const errors = new WeakMap<HTMLElement, unknown>();

function shellTableKnowsErrors(yes: boolean) {
  if (yes) {
    Object.defineProperty(ShellTable.prototype, 'error', {
      configurable: true,
      get(this: HTMLElement) { return errors.get(this) ?? ''; },
      set(this: HTMLElement, v: unknown) { errors.set(this, v); },
    });
  } else {
    delete (ShellTable.prototype as { error?: unknown }).error;
  }
}

const ROW = { id: 'r1', guest_name: 'Ana', timeslot_id: 't1' };

/** Tables fed by a paged list (`queryPage`) or by a plain query (occupancy). */
const TABLES = [
  { tag: 'erp-reservations-waitlist', table: 'reservations-waitlist-table', banner: 'reservations-waitlist-load-error', read: 'page' },
  { tag: 'erp-reservations-availability', table: 'reservations-availability-slots-table', banner: 'reservations-availability-slots-error', read: 'page' },
  { tag: 'erp-reservations-availability', table: 'reservations-availability-blocked-table', banner: 'reservations-availability-blocked-error', read: 'page' },
  { tag: 'erp-reservations-availability', table: 'reservations-availability-occupancy-table', banner: 'reservations-availability-occupancy-error', read: 'reservations.slots.count_for' },
] as const;

let hubAnswers = false;
let pageCalls = 0;
let queryCalls: string[] = [];

beforeAll(async () => {
  customElements.define('ok-data-table', ShellTable);
  await import('../components/erp-reservations-waitlist/erp-reservations-waitlist');
  await import('../components/erp-reservations-availability/erp-reservations-availability');
  await import('../components/erp-reservations-list/erp-reservations-list');
});

beforeEach(() => {
  document.body.innerHTML = '';
  hubAnswers = false;
  pageCalls = 0;
  queryCalls = [];
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string) => {
      queryCalls.push(name);
      if (!hubAnswers) throw new Error('The hub is not responding.');
      return name === 'reservations.slots.count_for' ? [ROW] : [];
    },
    queryPage: async () => {
      pageCalls++;
      if (!hubAnswers) throw new Error('The hub is not responding.');
      return { rows: [ROW], total: 1 };
    },
    command: async () => ({}),
    hasPermission: () => true,
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };
type Table = HTMLElement & { error: string; rows: unknown[] };

const calls = (read: string) => (read === 'page' ? pageCalls : queryCalls.filter((n) => n === read).length);

async function settle(el: Screen): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await el.updateComplete;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function mountFailed(tag: string, testid: string): Promise<{ el: Screen; table: Table }> {
  const el = document.createElement(tag) as Screen;
  document.body.appendChild(el);
  await vi.waitFor(() => {
    if (pageCalls === 0) throw new Error('the list has not asked for its page yet');
  });
  await settle(el);
  const table = el.shadowRoot.querySelector<Table>(`ok-data-table[testid="${testid}"]`);
  expect(table, `${tag} paints ${testid}`).toBeTruthy();
  return { el, table: table! };
}

describe.each(TABLES)('$table — a list that could not load (pm#533)', ({ tag, table: testid, banner, read }) => {
  it('hands the reason to the shell table and paints no second banner', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed(tag, testid);
    expect(table.error).toBe('The hub is not responding.');
    expect(el.shadowRoot.querySelector(`[data-testid="${banner}"]`), 'the reason would be said twice').toBeNull();
  });

  it('Retry on the table asks the hub again and paints the rows that now arrive', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed(tag, testid);
    const before = calls(read);
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(() => {
      if (calls(read) === before) throw new Error('Retry did not ask the hub again');
    });
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (table.error !== '') throw new Error('the error is still on the table');
    });
    expect(table.rows).toEqual([ROW]);
  });

  it('on a shell whose table cannot paint the error, keeps its own banner with the reason', async () => {
    shellTableKnowsErrors(false);
    const { el } = await mountFailed(tag, testid);
    const node = el.shadowRoot.querySelector(`[data-testid="${banner}"]`);
    expect(node, 'an older hub would show the failure nowhere').toBeTruthy();
    expect(node!.textContent).toContain('The hub is not responding.');
  });
});

describe('erp-reservations-list — the book that could not load (pm#533)', () => {
  const TABLE = 'reservations-table';
  const BLOCK = 'reservations-load-error';

  it('with nothing on screen the table steps aside and the full error block keeps the reason and Retry', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed('erp-reservations-list', TABLE);
    expect(table.hidden, 'the table would read «no reservations» under the error').toBe(true);
    const block = el.shadowRoot.querySelector(`[data-testid="${BLOCK}"]`);
    expect(block, 'the failure would be shown nowhere').toBeTruthy();
    expect(block!.textContent).toContain('The hub is not responding.');
    expect(block!.querySelector('[data-testid="reservations-retry"]')).toBeTruthy();
  });

  it('when the figures of the day fail with the book, the reason is said once, where its Retry is', async () => {
    shellTableKnowsErrors(true);
    const { el } = await mountFailed('erp-reservations-list', TABLE);
    await vi.waitFor(() => {
      if (!queryCalls.includes('reservations.day.summary')) throw new Error('the day figures were not asked for');
    });
    await settle(el);
    expect(el.shadowRoot.querySelector(`[data-testid="${BLOCK}"]`)?.textContent).toContain('The hub is not responding.');
    expect(el.shadowRoot.querySelector('[data-testid="reservations-summary-error"]'), 'the reason would be said twice').toBeNull();
    expect(el.shadowRoot.querySelector('[data-testid="reservations-summary-loading"]'), 'the figures would look like they are still loading').toBeNull();
  });

  it('with a search on and the figures failed too, only the table carries the reason', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed('erp-reservations-list', TABLE);
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'ana' }));
    await vi.waitFor(async () => {
      await settle(el);
      if (table.hidden) throw new Error('the table is still hidden with a search on');
    });
    expect(table.error).toBe('The hub is not responding.');
    expect(el.shadowRoot.querySelector('[data-testid="reservations-summary-error"]'), 'the reason would be said twice').toBeNull();
  });

  it('with a search on the table stays: it carries the reason and the block is not painted twice', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed('erp-reservations-list', TABLE);
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'ana' }));
    await vi.waitFor(async () => {
      await settle(el);
      if (table.hidden) throw new Error('the table is still hidden with a search on');
    });
    expect(table.error).toBe('The hub is not responding.');
    expect(el.shadowRoot.querySelector(`[data-testid="${BLOCK}"]`), 'the reason would be said twice').toBeNull();
  });

  it('with a search on and a table that cannot paint the error, the block stays', async () => {
    shellTableKnowsErrors(false);
    const { el, table } = await mountFailed('erp-reservations-list', TABLE);
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'ana' }));
    await vi.waitFor(async () => {
      await settle(el);
      if (table.hidden) throw new Error('the table is still hidden with a search on');
    });
    expect(el.shadowRoot.querySelector(`[data-testid="${BLOCK}"]`)?.textContent).toContain('The hub is not responding.');
  });

  it('Retry on the table asks again for the page AND the figures of the day that failed with it', async () => {
    shellTableKnowsErrors(true);
    const { el, table } = await mountFailed('erp-reservations-list', TABLE);
    table.dispatchEvent(new CustomEvent('searchChange', { detail: 'ana' }));
    await settle(el);
    const pages = pageCalls;
    const summaries = queryCalls.filter((n) => n === 'reservations.day.summary').length;
    hubAnswers = true;
    table.dispatchEvent(new CustomEvent('retry', { detail: {} }));
    await vi.waitFor(() => {
      if (pageCalls === pages) throw new Error('Retry did not ask for the page again');
      if (queryCalls.filter((n) => n === 'reservations.day.summary').length === summaries) {
        throw new Error('Retry did not ask for the day figures again');
      }
    });
    await vi.waitFor(async () => {
      await el.updateComplete;
      if (table.error !== '') throw new Error('the error is still on the table');
    });
    expect(el.shadowRoot.querySelector('[data-testid="reservations-summary-error"]'), 'the day figures still say they failed').toBeNull();
  });

  it('the Retry of the full block also asks again for the figures of the day', async () => {
    shellTableKnowsErrors(true);
    const { el } = await mountFailed('erp-reservations-list', TABLE);
    const summaries = queryCalls.filter((n) => n === 'reservations.day.summary').length;
    hubAnswers = true;
    el.shadowRoot.querySelector<HTMLElement>('[data-testid="reservations-retry"]')!.click();
    await vi.waitFor(() => {
      if (queryCalls.filter((n) => n === 'reservations.day.summary').length === summaries) {
        throw new Error('the full-block Retry did not ask for the day figures again');
      }
    });
    await vi.waitFor(async () => {
      await settle(el);
      if (el.shadowRoot.querySelector('[data-testid="reservations-summary-error"]')) throw new Error('the day figures still say they failed');
    });
  });
});
