// pm#637 — the book and the waitlist after a customer's personal data was erased (RESERVATIONS-F22).
//
// The listener of `customer.anonymized` blanks the name copied into her reservations and waitlist
// entries but keeps the sheet link. Where each screen shows that name — the «Cliente» column and
// the title of the card view — it must say «Cliente borrado» instead of an empty gap, in the
// user's language, and must not say it of a row that never had a sheet (a walk-in).
//
// What is asserted is what the screen HANDS the shell's table (`columns[].format`, `cardTitle`):
// the table paints with the shell's OutfitKit (ADR-0451), the screen owns the words.
import { beforeEach, describe, expect, it } from 'vitest';
import esLocale from '../../locales/es.json';
import enLocale from '../../locales/en.json';

const CATALOGS: Record<string, unknown> = { es: esLocale, en: enLocale };
function lookup(catalog: unknown, key: string): string | undefined {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), catalog);
  return typeof value === 'string' ? value : undefined;
}

const BASE = {
  guest_phone: '', guest_email: '', date: '2026-10-14', time: '20:00:00', preferred_time: '21:00:00',
  party_size: 4, duration_minutes: 120, table_id: null, status: 'confirmed', notes: '',
  is_contacted: false, is_converted: false,
};
const ERASED = { ...BASE, id: 'erased', customer_id: 'c9', guest_name: '' };
const KEPT = { ...BASE, id: 'kept', customer_id: 'c1', guest_name: 'Ana López' };
const WALKIN = { ...BASE, id: 'walkin', customer_id: null, guest_name: '' };
const BLANK_LINK = { ...BASE, id: 'blank', customer_id: '  ', guest_name: '' };

let locale: 'es' | 'en' = 'es';
beforeEach(() => {
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({ rows: [ERASED, KEPT, WALKIN, BLANK_LINK], total: 4 }),
    command: async () => ({}),
    hasPermission: () => true,
    on: () => () => {},
    get locale() {
      return locale;
    },
    t: (_catalog: unknown, key: string) => lookup(CATALOGS[locale], key) ?? lookup(CATALOGS.en, key) ?? key,
  };
});

type Column = { key: string; format?: (row: Record<string, unknown>) => unknown };
type Table = HTMLElement & { columns: Column[]; cardTitle: (row: Record<string, unknown>) => string };
type Screen = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

const SCREENS = [
  { tag: 'erp-reservations-list', load: () => import('../components/erp-reservations-list/erp-reservations-list') },
  { tag: 'erp-reservations-waitlist', load: () => import('../components/erp-reservations-waitlist/erp-reservations-waitlist') },
] as const;

async function table(screen: (typeof SCREENS)[number]): Promise<Table> {
  await screen.load();
  const el = document.createElement(screen.tag) as Screen;
  document.body.appendChild(el);
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    await el.updateComplete;
  }
  const found = el.shadowRoot.querySelector('ok-data-table') as Table | null;
  expect(found, `${screen.tag} paints its table`).toBeTruthy();
  return found!;
}

function nameCell(t: Table, row: Record<string, unknown>): string {
  const column = t.columns.find((c) => c.key === 'guest_name');
  expect(column, 'the table has the «Cliente» column').toBeTruthy();
  return String(column!.format ? column!.format(row) : row.guest_name);
}

describe.each(SCREENS)('pm#637 — $tag names an erased customer', (screen) => {
  it('the «Cliente» column says «Cliente borrado» for her, and nothing of the kind for the others', async () => {
    locale = 'es';
    const t = await table(screen);
    expect(nameCell(t, ERASED)).toBe('Cliente borrado');
    expect(nameCell(t, KEPT)).toBe('Ana López');
    expect(nameCell(t, WALKIN)).toBe('—');
    expect(nameCell(t, BLANK_LINK), 'a link made of blanks is no link').toBe('—');
  });

  it('in English the column says «Deleted customer»', async () => {
    locale = 'en';
    const t = await table(screen);
    expect(nameCell(t, ERASED)).toBe('Deleted customer');
  });

  it('the card view is titled «Cliente borrado» for her and keeps the name of the others', async () => {
    locale = 'es';
    const t = await table(screen);
    expect(t.cardTitle(ERASED)).toBe('Cliente borrado');
    expect(t.cardTitle(KEPT)).toBe('Ana López');
    expect(t.cardTitle(WALKIN)).toBe('—');
  });
});

it('both catalogues carry the label, in the words of Clientes and Citas', () => {
  expect(lookup(esLocale, 'ui.erasedCustomer')).toBe('Cliente borrado');
  expect(lookup(enLocale, 'ui.erasedCustomer')).toBe('Deleted customer');
});
