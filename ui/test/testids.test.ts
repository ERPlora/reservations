// A screen the QA robot cannot name is a screen nobody tests (reservations#61, out of hub#1756).
//
// The hub's QA drives the module with Playwright, and Playwright addresses by `data-testid`: it is
// the only hook that survives a copy change, the `en`↔`es` translation (ADR-0055/0199) and the
// Shadow DOM of a Web Component. When a control has none, the spec falls back to a selector by
// text or by `nth` — and both break on their own. That is how 12 points of this module were left
// unverified in the restaurant QA walk of 2026-09-09.
//
// This is the guard of the PATTERN, not a patch over one screen. The hub's twin lives in
// `apps/web/src/form-testids.test.ts`; the convention both obey is written once, in
// `architecture/hub/apps/testids.md`: `<surface>-<field|action|state>`, kebab-case, and the rows of
// a list carry their identity at the end (`reservations-row-${id}`), never their index.
//
// Two things are NOT copied from the hub's guard, because this repo is not Vue:
//
//   · The surfaces are Lit components (`html` tagged templates inside `.ts`), so there is no
//     `<template>` block to cut: the whole source is the template.
//   · A hook Lit builds at render time is written `data-testid=${`reservations-row-${id}`}`, not
//     `:data-testid` — that Vue spelling would reach the DOM as an attribute literally called
//     `:data-testid`, which `getByTestId` never resolves. So here it is DENIED, not read.
//
// And one thing this repo has and the shell does not: `<ok-data-table>`. Its whole chrome — add,
// search, CSV, row actions, pager — is named from ONE attribute, `testid="<prefix>-table"`
// (outfitkit#143/#145). Without it the table paints no hook at all, so a table with no `testid` is
// the biggest unnameable surface there is, and the rules below demand it like any other control.
//
// Five rules, because they stop five different things:
//
//   · COVERAGE — in a registered surface no control and no action is left without a hook. It is
//     what makes the field somebody adds next month born addressable.
//   · CONTRACT — the names the QA writes in its specs are declared here, and the declared set is
//     EXACTLY the one in the file. Renaming a hook has to break THIS test first, here, where it is
//     seen — not the QA suite, days later and in another repo.
//   · ATTRIBUTE — nothing writes `data-test` or any other variant: Playwright resolves
//     `getByTestId` against `data-testid` and nothing else.
//   · SPELLING — a hook is written `data-testid="…"` or `data-testid=${…}`, and nothing else. The
//     rules above read those two shapes, so any third spelling is a hook that reaches the browser
//     and never reaches this file.
//   · RATCHET — every surface with a control, an action or a table is classified: covered, or
//     pending with its issue. A new component cannot slip in unclassified, and the pending list
//     only shrinks.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** `ui/` — the whole UI tree of the module, components and helpers alike. */
const UI = join(__dirname, '..');

/** This file: the one exclusion of the attribute rule, which has to spell out what it forbids. */
const SELF = 'test/testids.test.ts';

/**
 * Covered surface: `prefix` is the namespace that belongs to it, `contract` is the EXACT set of
 * literal `data-testid` the file declares today, and `tables` the EXACT set of `<ok-data-table>`
 * namespaces it hands out.
 *
 * To get in here a surface needs both halves: every control, action and table hooked (the coverage
 * rule) and its contract written down (the contract rule). Adding a field to one of these forces a
 * change to this list — on purpose: that is the moment somebody decides what that field is going to
 * be called for the rest of the world.
 */
const COVERED: Record<string, { prefix: string; contract: string[]; tables?: string[] }> = {
  // The dining room's reservation book (`/m/reservations/list`): one table and, behind its «New
  // reservation», the side panel that books a party. Those five fields and their submit are what a
  // QA journey drives to get a booking into the hub, and the four state hooks are what it waits on
  // — the screen paints loading, error with retry, first-run empty and «no results» apart
  // (reservations#41), and a spec that cannot tell them apart asserts on the wrong one.
  //
  // The hooks of `data-action` / `data-state` / `data-empty` that were already there STAY: the
  // component's own specs address by them. `data-testid` is added next to them, for the QA that
  // drives the module from outside, through the Shadow DOM.
  'components/erp-reservations-list/erp-reservations-list.ts': {
    prefix: 'reservations-',
    contract: [
      'reservations-clear-filters',
      'reservations-create',
      'reservations-date',
      'reservations-empty',
      'reservations-form',
      'reservations-form-error',
      'reservations-guest-name',
      'reservations-guest-phone',
      'reservations-load-error',
      'reservations-loading',
      'reservations-no-results',
      'reservations-party-size',
      'reservations-retry',
      'reservations-submit',
      'reservations-time',
    ],
    tables: ['reservations-table'],
  },

  // When the restaurant is open and how full it is (`/m/reservations/availability`): three stacked
  // tables — today's occupancy, the weekly time slots and the blocked dates — each with its own
  // create form in its own drawer.
  //
  // The three tables are named APART because `ok-data-table` derives EVERY chrome hook from that
  // one name (`-add`, `-search`, `-row-<id>`, `-page-next`…). Sharing it, `getByTestId` would pick
  // at random between the row of a time slot and the row of a blocked date.
  //
  // The seven `<ion-select-option>` of the weekday select carry no hook of their own on purpose:
  // Ionic does not render them, it builds an alert of its own from them when the select opens, so
  // a hook written there never reaches the element the robot clicks. The spec picks the day by its
  // value on the select.
  'components/erp-reservations-availability/erp-reservations-availability.ts': {
    prefix: 'reservations-availability-',
    contract: [
      'reservations-availability-blocked-date',
      'reservations-availability-blocked-error',
      'reservations-availability-blocked-form',
      'reservations-availability-blocked-reason',
      'reservations-availability-blocked-submit',
      'reservations-availability-form-error',
      'reservations-availability-occupancy-date',
      'reservations-availability-occupancy-error',
      'reservations-availability-slot-day',
      'reservations-availability-slot-end',
      'reservations-availability-slot-form',
      'reservations-availability-slot-max',
      'reservations-availability-slot-start',
      'reservations-availability-slot-submit',
      'reservations-availability-slots-error',
    ],
    tables: [
      'reservations-availability-blocked-table',
      'reservations-availability-occupancy-table',
      'reservations-availability-slots-table',
    ],
  },

  // The queue for a table that is not free yet (`/m/reservations/waitlist`): one table and the
  // drawer that adds a party to the queue. Its fields carry the SAME concepts as the reservation
  // form — guest, phone, date, time, party size — under a namespace of their own, because a spec
  // that fills «the name field» has to say WHICH of the two books it is writing in.
  'components/erp-reservations-waitlist/erp-reservations-waitlist.ts': {
    prefix: 'reservations-waitlist-',
    contract: [
      'reservations-waitlist-date',
      'reservations-waitlist-form',
      'reservations-waitlist-form-error',
      'reservations-waitlist-guest-name',
      'reservations-waitlist-guest-phone',
      'reservations-waitlist-load-error',
      'reservations-waitlist-party-size',
      'reservations-waitlist-submit',
      'reservations-waitlist-time',
    ],
    tables: ['reservations-waitlist-table'],
  },
};

/** Pending surfaces, each with the REAL issue that covers it (`repo#N`). */
const NOT_YET_COVERED: Record<string, string> = {};

/**
 * How many surfaces are pending TODAY. This number ONLY GOES DOWN. Without it the pending list is a
 * list of excuses: a new component walks in with a decorative issue number and the guard stays
 * green. With the count nailed down, adding one forces raising it by hand, on a line whose comment
 * says it is not raised.
 */
const PENDING_TODAY = 0;

/**
 * What a person fills in — and the `<form>` itself, which is the handle a spec submits and waits
 * on. Buttons are not here: actions have their own list below.
 */
const CONTROL_TAGS = [
  'ion-input',
  'ion-select',
  'ion-textarea',
  'ion-toggle',
  'ion-checkbox',
  'ion-searchbar',
  'ion-segment',
  'ion-radio-group',
  'ion-datetime',
  'ion-range',
  'form',
  'input',
  'select',
  'textarea',
] as const;

/**
 * What a person presses. The tag list alone would miss the taps written on a plain element — a
 * dismissable banner, a clickable card — so anything carrying `@click` counts as well.
 */
const ACTION_TAGS = ['ion-button', 'button', 'ion-fab-button', 'ion-segment-button'] as const;

/** The table whose entire chrome hangs off a single `testid` (outfitkit#143). */
const TABLE_TAG = 'ok-data-table';

const ANY_TAG = /<([a-z][a-z0-9-]*)(?=[\s/>])/g;

/**
 * The `>` that closes the opening tag, skipping the ones that are not markup: those inside quotes
 * and those inside an interpolation.
 *
 * In a Lit template an attribute value is JavaScript, and this component's JavaScript is full of
 * `>`: every arrow of a handler (`@ionInput=${(e: any) => …}`) and every generic
 * (`CustomEvent<number>`). Stopping at the first one reads a quarter of the tag and drops the rest
 * of the attributes — silently, because a tag that looks hookless is reported and a tag whose
 * `@click` was never read is not reported at all.
 */
function openTag(source: string, start: number): string {
  let quote: string | null = null;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '$' && source[i + 1] === '{') {
      const body = braced(source, i);
      if (body !== undefined) {
        i += body.length + 2; // `${` + body + the `}` the loop's own step walks past
        continue;
      }
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/**
 * Prose out. The comments in these components talk ABOUT the markup — they name controls and quote
 * old names. Read as markup, a sentence like that is an action with no hook, and the coverage rule
 * would report a button that does not exist.
 *
 * A block comment is only cut when its opening starts the line, which is how every comment in this
 * repo is written. Matching one mid-line would risk swallowing live template, and a swallowed chunk
 * is not a loud failure: it is a control nobody checks.
 */
function withoutComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '')
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

/** A hook as it is written: literal (`"reservations-submit"`) or computed (`` ${`reservations-row-${id}`} ``). */
type Hook = { literal?: string; head?: string };

/**
 * Every `data-testid` of a source, in the shapes Lit writes one: `="name"`, `=${`head-${x}`}` and
 * `="${x}"`. For a computed one what is kept is its STATIC HEAD — the part before the first
 * interpolation — which is what the namespace rule can hold on to and what QA predicts.
 */
function hooks(source: string): Hook[] {
  const found: Hook[] = [];
  const re = /(?<![:\w-])data-testid\s*=\s*/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const at = m.index + m[0].length;
    const raw = source[at] === '"' || source[at] === "'" ? quoted(source, at) : braced(source, at);
    if (raw === undefined) continue;
    const cut = raw.indexOf('${');
    if (cut === -1 && !raw.startsWith('`')) found.push({ literal: raw });
    else found.push({ head: staticHead(raw) });
  }
  return found;
}

/** The body of `"…"`, without the quotes. */
function quoted(source: string, at: number): string | undefined {
  const end = source.indexOf(source[at], at + 1);
  return end === -1 ? undefined : source.slice(at + 1, end);
}

/** The body of `${…}`, with nested braces balanced so a `${}` inside a template literal survives. */
function braced(source: string, at: number): string | undefined {
  if (source[at] !== '$' || source[at + 1] !== '{') return undefined;
  let depth = 0;
  for (let i = at + 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(at + 2, i);
  }
  return undefined;
}

/** The static text a computed hook starts with: `` `reservations-row-${id}` `` → `reservations-row-`. */
function staticHead(raw: string): string {
  const body = raw.trim().startsWith('`') ? raw.trim().slice(1) : raw;
  const cut = body.search(/\$\{|`/);
  return cut === -1 ? '' : body.slice(0, cut);
}

/** Carries a hook, literal or computed. */
const hasHook = (open: string): boolean => /(?<![:\w-])data-testid\s*=/.test(open);

/** The namespace an `<ok-data-table>` hands to its chrome, written literally. */
const TABLE_TESTID = /(?<![\w-])testid\s*=\s*"([^"]*)"/;

type Element = { tag: string; line: number; open: string };

function elements(source: string): Element[] {
  const clean = withoutComments(source);
  const found: Element[] = [];
  ANY_TAG.lastIndex = 0;
  for (let m = ANY_TAG.exec(clean); m; m = ANY_TAG.exec(clean)) {
    found.push({
      tag: m[1],
      line: clean.slice(0, m.index).split('\n').length,
      open: openTag(clean, m.index),
    });
  }
  return found;
}

const isControl = (el: Element): boolean => (CONTROL_TAGS as readonly string[]).includes(el.tag);

const isAction = (el: Element): boolean =>
  (ACTION_TAGS as readonly string[]).includes(el.tag) || /@click\s*=/.test(el.open);

/**
 * What the QA has to fill in or press on a surface.
 *
 * `<ok-data-table>` is NOT here even when it carries a `@click` of its own: its whole chrome is
 * named from `testid`, not from `data-testid`, and the rule right below demands that one on EVERY
 * surface — covered or not, which is stricter than this one. Asking it for a `data-testid` too
 * would add a second name for the same element that nobody addresses, next to the one that does
 * paint a dozen hooks.
 */
const addressable = (source: string): Element[] =>
  elements(source).filter((el) => el.tag !== TABLE_TAG && (isControl(el) || isAction(el)));

const dataTables = (source: string): Element[] =>
  elements(source).filter((el) => el.tag === TABLE_TAG);

const unhooked = (source: string): string[] =>
  addressable(source)
    .filter((el) => !hasHook(el.open))
    .map((el) => `<${el.tag}> line ${el.line}`);

/** A table with no namespace: `ok-data-table` then paints not one hook of its own chrome. */
const unnamedTables = (source: string): string[] =>
  dataTables(source)
    .filter((el) => !TABLE_TESTID.test(el.open))
    .map((el) => `<${el.tag}> line ${el.line}`);

/** Kebab-case: lowercase and digits separated by a single hyphen. */
const KEBAB = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/**
 * Any `data-test…` attribute, so the guard can tell the hook from the variants that look like one
 * and are not. Playwright resolves `getByTestId` against `data-testid` and nothing else, so
 * `data-test="x"` is a hook the robot cannot reach — and the spec that reads it asserts on nothing
 * for ever.
 */
const TEST_ATTR = /(?<![\w-])(data-test[\w-]*)\s*=\s*("[^"]*"|'[^']*')?/g;

/**
 * How a hook is WRITTEN. Every rule above reads exactly two spellings — `data-testid="…"` and
 * `data-testid=${…}` — so any other way of writing the SAME attribute is a hook Lit renders, QA
 * cannot address or this file cannot see. `:data-testid` and `v-bind:data-testid` are the Vue
 * spellings: in Lit they reach the DOM as an attribute whose NAME starts with a colon, which
 * `getByTestId` never resolves. A single-quoted value is read by nobody here.
 */
const TESTID_SPELLING = /(?<![\w-])(v-bind:data-testid|:data-testid|data-testid)\s*=\s*("|'|\$\{|[^\s>])/g;

function tsFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) tsFiles(full, found);
    else if (entry.endsWith('.ts')) found.push(full);
  }
  return found;
}

/** The surfaces: every non-test source of `ui/`, named by its path relative to `ui/`. */
const SURFACES: Array<{ name: string; source: string }> = tsFiles(UI)
  .filter((full) => !full.endsWith('.test.ts'))
  .map((full) => ({ name: relative(UI, full), source: readFileSync(full, 'utf8') }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * The whole tree, tests included, for the attribute rule: a spec that keeps reading
 * `[data-test="…"]` after the surface stopped writing it asserts `false` for ever, which is how a
 * rule that never fires disguises itself as a rule that passes.
 */
const ALL_SOURCES: Array<{ name: string; source: string }> = tsFiles(UI)
  .map((full) => ({ name: relative(UI, full), source: readFileSync(full, 'utf8') }))
  .filter(({ name }) => name !== SELF)
  .sort((a, b) => a.name.localeCompare(b.name));

const sourceOf = (name: string): string => SURFACES.find((s) => s.name === name)?.source ?? '';

const literalsOf = (name: string): string[] =>
  hooks(withoutComments(sourceOf(name)))
    .map((h) => h.literal)
    .filter((v): v is string => v !== undefined);

const headsOf = (name: string): string[] =>
  hooks(withoutComments(sourceOf(name)))
    .map((h) => h.head)
    .filter((v): v is string => v !== undefined);

const tableIdsOf = (name: string): string[] =>
  dataTables(sourceOf(name))
    .map((el) => el.open.match(TABLE_TESTID)?.[1])
    .filter((v): v is string => v !== undefined);

/** Every fixed name a surface hands out: its own hooks plus the namespaces it gives its tables. */
const namesOf = (name: string): string[] => [...literalsOf(name), ...tableIdsOf(name)];

describe('data-testid — the module UI convention (reservations#61)', () => {
  it('every fixed name is kebab-case', () => {
    const offenders: string[] = [];
    for (const { name } of SURFACES) {
      for (const value of namesOf(name)) {
        if (!KEBAB.test(value)) offenders.push(`${name}: "${value}"`);
      }
    }
    expect(offenders, 'a name that is not kebab-case breaks what the QA can predict').toEqual([]);
  });

  it('no fixed name is repeated in two surfaces', () => {
    const owners = new Map<string, string[]>();
    for (const { name } of SURFACES) {
      for (const value of new Set(namesOf(name))) {
        owners.set(value, [...(owners.get(value) ?? []), name]);
      }
    }
    const shared = [...owners]
      .filter(([, files]) => files.length > 1)
      .map(([value, files]) => `"${value}" in ${files.join(' + ')}`);
    expect(shared, 'getByTestId would return two elements and the spec would pick at random').toEqual([]);
  });

  it('a covered surface leaves no control and no action without a hook', () => {
    const offenders: string[] = [];
    for (const name of Object.keys(COVERED)) {
      expect(SURFACES.some((s) => s.name === name), `${name} is in COVERED but does not exist`).toBe(true);
      for (const el of unhooked(sourceOf(name))) offenders.push(`${name}: ${el}`);
    }
    expect(offenders, 'Playwright cannot fill in or press what has no data-testid').toEqual([]);
  });

  it('every ok-data-table hands its chrome a namespace', () => {
    // Without `testid` the table paints NOT ONE hook: no add, no search, no row, no pager
    // (outfitkit#143). It is the single most unnameable element this module can put on screen.
    const offenders: string[] = [];
    for (const { name, source } of SURFACES) {
      for (const el of unnamedTables(source)) offenders.push(`${name}: ${el}`);
    }
    expect(
      offenders,
      'give it testid="<prefix>-table": every hook of its chrome derives from that one name',
    ).toEqual([]);
  });

  it('the declared contract is EXACTLY the one in the surface', () => {
    const drift: string[] = [];
    for (const [name, spec] of Object.entries(COVERED)) {
      const found = [...new Set(literalsOf(name))].sort();
      const declared = [...spec.contract].sort();
      for (const missing of declared.filter((v) => !found.includes(v))) {
        drift.push(`${name}: the contract declares "${missing}" and the surface no longer has it`);
      }
      for (const extra of found.filter((v) => !declared.includes(v))) {
        drift.push(`${name}: the surface has "${extra}" and the contract does not declare it`);
      }
    }
    expect(drift, 'renaming a data-testid breaks the QA suite: declare it here').toEqual([]);
  });

  it('the declared table namespaces are EXACTLY the ones in the surface', () => {
    const drift: string[] = [];
    for (const [name, spec] of Object.entries(COVERED)) {
      const found = [...new Set(tableIdsOf(name))].sort();
      const declared = [...(spec.tables ?? [])].sort();
      for (const missing of declared.filter((v) => !found.includes(v))) {
        drift.push(`${name}: the contract declares the table "${missing}" and the surface has no such table`);
      }
      for (const extra of found.filter((v) => !declared.includes(v))) {
        drift.push(`${name}: the surface hands out "${extra}" and the contract does not declare it`);
      }
    }
    expect(drift, 'a table namespace is the root of a dozen QA hooks: declare it here').toEqual([]);
  });

  it('every fixed name lives in its surface namespace', () => {
    const offenders: string[] = [];
    for (const [name, spec] of Object.entries(COVERED)) {
      if (!spec.prefix) continue;
      for (const value of new Set(namesOf(name))) {
        if (!value.startsWith(spec.prefix)) offenders.push(`${name}: "${value}" ≠ ${spec.prefix}*`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a COMPUTED data-testid also lives in its namespace and keeps its identity at the end', () => {
    // A row is addressed as «fixed head + the row's identity», so the head is the contract just the
    // same. Reading only the literals is the hole hub#1828 documents in the shell: renaming a
    // computed hook stayed green there and broke the specs days later, in another repo.
    const offenders: string[] = [];
    for (const [name, spec] of Object.entries(COVERED)) {
      for (const head of headsOf(name)) {
        if (head === '') {
          offenders.push(`${name}: a data-testid with no static head cannot be predicted by a spec`);
        } else if (spec.prefix && !head.startsWith(spec.prefix)) {
          offenders.push(`${name}: "${head}\${…}" ≠ ${spec.prefix}*`);
        } else if (!head.endsWith('-')) {
          offenders.push(`${name}: "${head}\${…}" glues the identity onto the name: end it with "-"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('nothing in the module writes data-test: Playwright only resolves data-testid', () => {
    const offenders: string[] = [];
    for (const { name, source } of ALL_SOURCES) {
      TEST_ATTR.lastIndex = 0;
      for (let m = TEST_ATTR.exec(source); m; m = TEST_ATTR.exec(source)) {
        if (m[1] !== 'data-testid') offenders.push(`${name}: ${m[1]}=${m[2] ?? ''}`);
      }
    }
    expect(
      offenders,
      'getByTestId does not resolve it: write data-testid, prefixed with its surface',
    ).toEqual([]);
  });

  it('a hook is spelled data-testid="…" or data-testid=${…}, and nothing else', () => {
    const offenders: string[] = [];
    for (const { name, source } of ALL_SOURCES) {
      TESTID_SPELLING.lastIndex = 0;
      for (let m = TESTID_SPELLING.exec(source); m; m = TESTID_SPELLING.exec(source)) {
        if (m[1] !== 'data-testid' || (m[2] !== '"' && m[2] !== '$')) {
          offenders.push(`${name}: ${m[1]}=${m[2]}`);
        }
      }
    }
    expect(
      offenders,
      'the rules above read one spelling: any other is a hook with no contract',
    ).toEqual([]);
  });

  it('every surface with a control, an action or a table is classified: covered, or with its issue', () => {
    const unclassified = SURFACES.filter(
      ({ name, source }) =>
        (addressable(source).length > 0 || dataTables(source).length > 0) &&
        !(name in COVERED) &&
        !(name in NOT_YET_COVERED),
    ).map(({ name }) => name);
    expect(
      unclassified,
      'a new component is born with data-testid — or enters NOT_YET_COVERED with its issue',
    ).toEqual([]);
  });

  it('a pending surface that is already complete does not stay in the pending list', () => {
    const stale = Object.keys(NOT_YET_COVERED).filter(
      (name) =>
        SURFACES.some((s) => s.name === name) &&
        unhooked(sourceOf(name)).length === 0 &&
        unnamedTables(sourceOf(name)).length === 0,
    );
    expect(stale, 'it already has every hook: move it to COVERED with its contract').toEqual([]);
  });

  it('the pending list only shrinks: a new surface is born covered, not pending', () => {
    const pending = Object.keys(NOT_YET_COVERED).length;
    expect(
      pending,
      pending > PENDING_TODAY
        ? 'a new surface does not enter NOT_YET_COVERED: hook it up and move it to COVERED'
        : `a pending surface left the list: lower PENDING_TODAY to ${pending}`,
    ).toBe(PENDING_TODAY);
  });

  it('the pending list does not name surfaces that no longer exist', () => {
    const ghosts = Object.keys(NOT_YET_COVERED).filter(
      (name) => !SURFACES.some((s) => s.name === name),
    );
    expect(ghosts).toEqual([]);
  });

  it('every pending surface cites a real issue, not a placeholder', () => {
    // A pending surface with no issue is a pending surface nobody does: the register above reads
    // like a plan, and a `repo#PENDING-something` turns it into a list of good intentions that
    // never reaches the board. Exact shape `repo#N` so it can be opened from here.
    const placeholders = Object.entries(NOT_YET_COVERED)
      .filter(([, issue]) => !/^[a-z][a-z0-9_-]*#\d+$/.test(issue))
      .map(([name, issue]) => `${name}: "${issue}"`);
    expect(placeholders, 'open the issue and put its number: the board does not pick up a hole').toEqual([]);
  });
});

describe('the guard reads a Lit open tag, not a JavaScript one (reservations#61)', () => {
  // The rules above are only worth what the reader underneath them sees. In a Lit template an
  // attribute value is JavaScript — `@ionInput=${(e: any) => …}`, `@sortChange=${(e: CustomEvent<{
  // sort: string }>) => …}` — and that JavaScript is FULL of `>`: every arrow, every generic. A
  // reader that closes the tag at the first `>` stops inside the first handler and never sees the
  // rest of the attributes.
  //
  // That cuts both ways, and one of the two is silent: an element whose `@click` comes after
  // another interpolated attribute is not recognised as an action at all, so the coverage rule
  // never demands a hook for it — a button nobody has to name, reported by nobody. These sources
  // are synthetic on purpose: a guard that only works on the shapes that exist today is a guard
  // that breaks on the next component.

  it('sees an @click that comes after another interpolated handler', () => {
    const source = `html\`<div class="err" @wheel=\${(e: WheelEvent) => this.spin(e)} @click=\${() => { this.formError = ''; }}></div>\``;
    expect(
      addressable(source).map((el) => el.tag),
      'the arrow of the first handler is not the end of the tag: that div is a tap',
    ).toEqual(['div']);
  });

  it('sees an @click that comes after an attribute holding a generic', () => {
    const source = `html\`<div @sortChange=\${(e: CustomEvent<{ sort: string }>) => this.sort(e)} @click=\${() => this.focus()}></div>\``;
    expect(
      addressable(source).map((el) => el.tag),
      'the `>` closing a generic is not the `>` closing the tag',
    ).toEqual(['div']);
  });

  it('sees a data-testid that comes after the handler', () => {
    const source = `html\`<ion-button @click=\${() => this.save()} data-testid="reservations-submit"></ion-button>\``;
    expect(
      unhooked(source),
      'the hook is there: reporting it as missing sends the author to add a second one',
    ).toEqual([]);
  });

  it('still closes the tag at its own `>`, not at a later one', () => {
    const source = `html\`<ion-input data-testid="reservations-date"></ion-input><ion-button @click=\${() => this.go()}></ion-button>\``;
    expect(
      unhooked(source),
      'the input is hooked and the button is not: bleeding past the tag would hide one of the two',
    ).toEqual(['<ion-button> line 1']);
  });

  it('sees the testid of a table written after an interpolated property', () => {
    const source = `html\`<ok-data-table .rows=\${this.rows} testid="reservations-table" .columns=\${this.cols}></ok-data-table>\``;
    expect(unnamedTables(source), 'the namespace is there, after the first `${…}`').toEqual([]);
  });

  it('does not take the data-testid of a control for the testid of a table', () => {
    const source = `html\`<ok-data-table data-testid="reservations-table" .rows=\${this.rows}></ok-data-table>\``;
    expect(
      unnamedTables(source),
      'ok-data-table reads `testid`, not `data-testid`: with the wrong one its chrome stays unnamed',
    ).toEqual(['<ok-data-table> line 1']);
  });
});
