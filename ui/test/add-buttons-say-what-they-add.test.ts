// reservations#75 — Availability stacks two tables with their own «+» and both bar buttons were
// called «Add» / «Añadir»: a screen reader heard the same name twice and could not tell which one
// creates a time slot and which one blocks a date. The waitlist had the kitchen#121 variant of the
// same defect: with its «New» panel open, the bar button AND the panel submit were both «Add».
//
// The fix follows the pattern OutfitKit anchored in outfitkit#220 (adopted in kitchen#121): every
// bar button is named per table with `.labels=${{ add: … }}` and says WHAT it adds, and every
// submit says what it DOES — so no two buttons on a screen share a name, with the panels open, in
// `en` (the source) and `es` (every app is translated, ADR-0055/0199), on desktop and on a phone.
import { beforeEach, describe, expect, it } from 'vitest';
import en from '../../locales/en.json';
import es from '../../locales/es.json';

const CATALOGS: Record<string, unknown> = { en, es };

/** Resolves `ui.x` against the REAL module catalog, so the test hears the words a person hears. */
function translate(lang: string, key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], CATALOGS[lang]);
  return typeof value === 'string' ? value : key;
}

/** happy-dom has no matchMedia: the viewport is whatever this stub says. */
function viewport(mobile: boolean): void {
  (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({
    media: q, matches: mobile, onchange: null,
    addListener: () => {}, removeListener: () => {},
    addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}

function sdk(lang: string): void {
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({ rows: [], total: 0 }),
    command: async () => ({}),
    on: () => () => {},
    locale: lang,
    t: (_catalog: unknown, key: string) => translate(lang, key),
  };
}

type Table = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown>; open(p?: 'filters' | 'create'): void };
type Wc = HTMLElement & { shadowRoot: ShadowRoot; updateComplete: Promise<unknown> };

async function settle(el: { updateComplete: Promise<unknown> }): Promise<void> {
  await el.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await el.updateComplete;
}

/** An ion-button is named by its text (the icon is decorative) unless an aria-label overrides it. */
const accessibleName = (btn: HTMLElement): string => (btn.getAttribute('aria-label') ?? btn.textContent ?? '').trim();

/** Mounts a screen and opens the «New» panel of every addable table: the moment all buttons coexist. */
async function mountWithPanelsOpen(tag: string, load: () => Promise<unknown>): Promise<Wc> {
  await load();
  const el = document.createElement(tag) as Wc;
  document.body.appendChild(el);
  await settle(el);
  for (const table of Array.from(el.shadowRoot.querySelectorAll('ok-data-table')) as Table[]) {
    if (!(table as unknown as { addable?: boolean }).addable) continue;
    table.open('create');
    await settle(table);
  }
  return el;
}

function button(root: ParentNode, testid: string): HTMLElement {
  const btn = root.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
  expect(btn, testid).toBeTruthy();
  return btn!;
}

const tableRoot = (el: Wc, testid: string): ShadowRoot =>
  (el.shadowRoot.querySelector(`ok-data-table[testid="${testid}"]`) as Table).shadowRoot;

interface Screen {
  name: string;
  tag: string;
  load: () => Promise<unknown>;
  /** testid → expected accessible name per language, for every create button of the screen. */
  buttons: (el: Wc) => Record<string, HTMLElement>;
  expected: Record<'en' | 'es', Record<string, string>>;
}

const SCREENS: Screen[] = [
  {
    name: 'Availability',
    tag: 'erp-reservations-availability',
    load: () => import('../components/erp-reservations-availability/erp-reservations-availability'),
    buttons: (el) => ({
      slotsBar: button(tableRoot(el, 'reservations-availability-slots-table'), 'reservations-availability-slots-table-add'),
      slotSubmit: button(el.shadowRoot, 'reservations-availability-slot-submit'),
      blockedBar: button(tableRoot(el, 'reservations-availability-blocked-table'), 'reservations-availability-blocked-table-add'),
      blockedSubmit: button(el.shadowRoot, 'reservations-availability-blocked-submit'),
    }),
    expected: {
      en: { slotsBar: 'Add slot', slotSubmit: 'Create slot', blockedBar: 'Add blocked date', blockedSubmit: 'Block date' },
      es: { slotsBar: 'Añadir franja', slotSubmit: 'Crear franja', blockedBar: 'Añadir fecha bloqueada', blockedSubmit: 'Bloquear fecha' },
    },
  },
  {
    name: 'Waitlist',
    tag: 'erp-reservations-waitlist',
    load: () => import('../components/erp-reservations-waitlist/erp-reservations-waitlist'),
    buttons: (el) => ({
      bar: button(tableRoot(el, 'reservations-waitlist-table'), 'reservations-waitlist-table-add'),
      submit: button(el.shadowRoot, 'reservations-waitlist-submit'),
    }),
    expected: {
      en: { bar: 'Add guest', submit: 'Add to waitlist' },
      es: { bar: 'Añadir cliente', submit: 'Añadir a la lista de espera' },
    },
  },
];

const GENERIC = { en: 'Add', es: 'Añadir' } as const;

describe('every create button says what it creates, and no two share a name (reservations#75)', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  for (const screen of SCREENS) {
    for (const lang of ['en', 'es'] as const) {
      for (const mobile of [false, true]) {
        const vp = mobile ? 'phone' : 'desktop';

        it(`${screen.name} · ${lang} · ${vp}: each button carries its own name`, async () => {
          viewport(mobile);
          sdk(lang);
          document.documentElement.lang = lang;
          const el = await mountWithPanelsOpen(screen.tag, screen.load);
          const names = Object.fromEntries(Object.entries(screen.buttons(el)).map(([k, b]) => [k, accessibleName(b)]));
          expect(names).toEqual(screen.expected[lang]);
        });

        it(`${screen.name} · ${lang} · ${vp}: no two buttons share a name, and none is the bare «${GENERIC[lang]}»`, async () => {
          viewport(mobile);
          sdk(lang);
          document.documentElement.lang = lang;
          const el = await mountWithPanelsOpen(screen.tag, screen.load);
          const names = Object.values(screen.buttons(el)).map(accessibleName);
          expect(new Set(names).size, names.join(' | ')).toBe(names.length);
          expect(names).not.toContain(GENERIC[lang]);
        });
      }
    }
  }
});
