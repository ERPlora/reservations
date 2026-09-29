import { LitElement, html, css, nothing } from 'lit';
import type { PropertyValues } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
import { ionTone } from '../../lib/ion-tone';
import { WallTimeDrafts, formatWallTime } from '../../lib/wall-time';
import { CalendarDateDrafts } from '../../lib/calendar-date';
// Catálogo i18n del módulo (ADR-0055): esbuild inlinea estos JSON en el `dist` del WC. Los textos
// internos se resuelven con `erplora.t(CATALOG, 'ui.clave')` (idioma activo, fallback locale→en→clave).
import esLocale from '../../../locales/es.json';
import enLocale from '../../../locales/en.json';
const CATALOG: Record<string, unknown> = { es: esLocale, en: enLocale };

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
  /** i18n del módulo (ADR-0055): idioma activo + traducción del catálogo `ui`. */
  locale: string;
  t(catalog: Record<string, unknown>, key: string, params?: Record<string, unknown>): string;
}

interface TimeSlot {
  id: string;
  day_of_week: number;
  start_time: string;
  end_time: string;
  max_reservations: number;
  is_active: number;
}

interface BlockedDate {
  id: string;
  date: string;
  reason: string;
  is_full_day: boolean;
}

/** Una franja del día con su ocupación — lo que `reservations.slots.count_for` devuelve
 * (reservations#4): cuenta EXACTAMENTE lo que cuenta el gate anti-overbooking. */
interface SlotOccupancy {
  timeslot_id: string;
  start_time: string;
  end_time: string;
  max_reservations: number;
  reserved: number;
  available: number;
}

// Índice (day_of_week, 0=lunes) → clave i18n del nombre del día.
const DAY_KEYS = [
  'ui.dayMonday',
  'ui.dayTuesday',
  'ui.dayWednesday',
  'ui.dayThursday',
  'ui.dayFriday',
  'ui.daySaturday',
  'ui.daySunday',
];

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

/** Today as `YYYY-MM-DD` in the TERMINAL's local time (the dining room asks about "tonight",
 * not about UTC): `toISOString()` would shift the day around midnight and timezones. */
function todayLocal(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** `HH:MM[:SS]` → the hour the dining room reads, in the hub's clock and without the seconds
 *  (reservations#77: the same reading as the time fields of the form). */
function fmtTime(time: string): string {
  return formatWallTime(time, erplora().locale || 'es');
}

export class ErpReservationsAvailability extends LitElement {
  // Sin `fill`: la vista apila DOS tablas, así que cada una mantiene su alto natural y scrollea la
  // página. `fill` es para la tabla ÚNICA que llena el alto de la vista.
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    h3 { margin:1.25rem 0 .5rem; font-size:1rem; }
    /* El alta vive en el panel lateral de su tabla (estrecho) → campos en columna, no en fila. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .err { color:#d9480f; font-weight:600; }
    /* El selector de fecha de la ocupación: táctil (44px, ADR de usabilidad del shell) y sin
       robar ancho a la barra — la fecha es un filtro, no un alta. */
    .occ-date { display:flex; align-items:center; padding:0 .25rem; }
    .occ-date ion-input { --min-height:44px; min-height:44px; font-size:.9rem; }
  `;

  @state() saving = false;

  /** What each create panel's form was refused — one per table, since each form lives in its own
   *  table's panel. Painted INSIDE that form (pm#513). */
  @state() slotFormError = '';

  @state() blockedFormError = '';

  /** What went wrong in a ROW action (remove a slot or a blocked date): no panel is open then, so it
   *  is painted on the page (pm#513). */
  @state() pageError = '';

  @state() tick = 0;

  @state() slotDay = '0';

  @state() slotStart = '';

  /** reservations#77 — the text typed into the start/end fields, kept apart from the stored hours. */
  private timeDrafts = new WallTimeDrafts<'start' | 'end'>(() => this.requestUpdate());
  /** reservations#78 — the typed text of the occupancy date and of a new blocked date. */
  private dateDrafts = new CalendarDateDrafts<'occupancy' | 'blocked'>(() => this.requestUpdate());

  @state() slotEnd = '';

  @state() slotMax = '10';

  @state() blockDate = '';

  @state() blockReason = '';

  // ── reservations#38: the occupancy table — «how much is left tonight?» ────────────────────
  // The date the floor manager is looking at (default: today, local). One row per active slot
  // of that day's weekday, counted exactly like the anti-overbooking gate counts.

  @state() occDate = todayLocal();

  @state() occRows: SlotOccupancy[] = [];

  @state() occLoading = false;

  @state() occError = '';

  private slotsCtrl!: ListController<TimeSlot>;

  private blockedCtrl!: ListController<BlockedDate>;

  private unsub?: () => void;

  // Getters (no campos): se re-evalúan en cada render → los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get slotColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    {
      key: 'day_of_week',
      header: t('ui.colDay'),
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: DAY_KEYS.map((key, i) => ({ value: String(i), label: t(key) })),
      format: (r) => (DAY_KEYS[r.day_of_week as number] ? t(DAY_KEYS[r.day_of_week as number]) : '?'),
    },
    { key: 'start_time', header: t('ui.colStart'), sortable: true, filterable: true, filterType: 'text', format: (r) => fmtTime(String(r.start_time ?? '')) },
    { key: 'end_time', header: t('ui.colEnd'), sortable: true, filterable: true, filterType: 'text', format: (r) => fmtTime(String(r.end_time ?? '')) },
    { key: 'max_reservations', header: t('ui.colMax'), align: 'right', sortable: true, filterable: true, filterType: 'range' },
    ];
  }

  private get blockColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'reason', header: t('ui.colReason'), sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'is_full_day',
      header: t('ui.colFullDay'),
      sortable: true,
      filterable: true,
      filterType: 'select',
      // reservations#54: the query answers this flag as a JSON boolean, and the list engine
      // compares a filter as TEXT (`CAST(sub.<col> AS TEXT) = CAST(:f_<col> AS TEXT)`), where a
      // boolean renders `'true'`/`'false'`. Offering `'1'`/`'0'` here would match nothing and the
      // table would look empty instead of filtered (hub#1182).
      options: [
        { value: 'true', label: t('ui.yes') },
        { value: 'false', label: t('ui.no') },
      ],
      format: (r) => (r.is_full_day ? t('ui.yes') : t('ui.no')),
    },
    ];
  }

  private get rowActions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [{ id: 'remove', label: t('ui.actionRemove'), icon: 'trash-outline', color: 'danger' }];
  }

  // A slot with no room left: the row stays VISIBLE but dimmed and stamped «Full» — the market
  // pattern (OpenTable/Resy show the sold-out slot unselectable, they do not hide it; hiding
  // leaves the reader wondering whether the slot exists at all).
  private occIsFull(row: Record<string, unknown>): boolean {
    return Number(row.available ?? 0) <= 0;
  }

  /** Full-row attenuation, cell by cell (ok-data-table has no per-row class hook): the whole
   *  full row reads faded, the «Full» badge carries the meaning. */
  private occCell(row: Record<string, unknown>, content: unknown): unknown {
    return this.occIsFull(row) ? html`<span style="opacity:.55">${content}</span>` : content;
  }

  private get occColumns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      {
        key: 'slot',
        header: t('ui.colSlot'),
        format: (r) => `${fmtTime(String(r.start_time ?? ''))}–${fmtTime(String(r.end_time ?? ''))}`,
        render: (r) => this.occCell(r, `${fmtTime(String(r.start_time ?? ''))}–${fmtTime(String(r.end_time ?? ''))}`),
      },
      {
        key: 'reserved',
        header: t('ui.colReserved'),
        align: 'right',
        render: (r) => this.occCell(r, String(r.reserved ?? 0)),
      },
      {
        key: 'max',
        header: t('ui.colMax'),
        align: 'right',
        render: (r) => this.occCell(r, String(r.max_reservations ?? 0)),
      },
      {
        key: 'available',
        header: t('ui.colAvailable'),
        align: 'right',
        render: (r) =>
          this.occIsFull(r)
            ? html`<ion-badge style=${ionTone('solid', 'danger')}>${t('ui.full')}</ion-badge>`
            : html`<strong>${String(r.available ?? 0)}</strong>`,
      },
    ];
  }

  /** reservations#78 — the occupancy follows the date field only once it reads a whole date: a
   *  half-typed «29/09» keeps the day on screen instead of querying an empty one. */
  private onOccupancyDateInput(text: string): void {
    const date = this.dateDrafts.input('occupancy', text, erplora().locale);
    if (!date || date === this.occDate) return;
    this.occDate = date;
    void this.loadOccupancy();
  }

  /** The occupancy of the chosen date, straight from the gate's read side (#4). Plain counts —
   *  thousands separators are the hub's CLDR helper's business (hub#1090), not this module's. */
  async loadOccupancy(): Promise<void> {
    this.occLoading = true;
    this.occError = '';
    try {
      this.occRows = (await erplora().query<SlotOccupancy[]>('reservations.slots.count_for', {
        date: this.occDate,
      })) ?? [];
    } catch (e) {
      this.occRows = [];
      this.occError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errOccupancy');
    } finally {
      this.occLoading = false;
      this.requestUpdate();
    }
  }

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.slotsCtrl = createListController<TimeSlot>(erplora(), 'reservations.timeslots.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    this.blockedCtrl = createListController<BlockedDate>(erplora(), 'reservations.blocked_dates.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    await Promise.all([this.slotsCtrl.load(), this.blockedCtrl.load(), this.loadOccupancy()]);
    try {
      const offs = [
        erplora().on('reservations.timeslot.created', () => this.slotsCtrl.load()),
        erplora().on('reservations.timeslot.deleted', () => this.slotsCtrl.load()),
        erplora().on('reservations.blocked_date.created', () => this.blockedCtrl.load()),
        erplora().on('reservations.blocked_date.deleted', () => this.blockedCtrl.load()),
        // The occupancy is LIVE during service: every booking that lands (or moves, or is
        // cancelled — `status_changed` carries the cancellation) changes what is left tonight.
        erplora().on('reservations.reservation.created', () => this.loadOccupancy()),
        erplora().on('reservations.reservation.updated', () => this.loadOccupancy()),
        erplora().on('reservations.reservation.status_changed', () => this.loadOccupancy()),
        erplora().on('reservations.reservation.deleted', () => this.loadOccupancy()),
      ];
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) */
    }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    this.unsub?.();
    super.disconnectedCallback();
  }

  // Cada tabla tiene SU panel lateral: hay que cerrar el de la tabla del alta, no «el» de la vista.
  private dataTable(id: 'slots' | 'blocked'): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector(`ok-data-table#${id}`) as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  private async createSlot(ev: Event) {
    ev.preventDefault();
    if (this.timeDrafts.unreadable('start', 'end')) {
      this.slotFormError = erplora().t(CATALOG, 'ui.valTimeUnreadable');
      return;
    }
    if (!this.slotStart || !this.slotEnd) return;
    this.saving = true;
    this.slotFormError = '';
    this.pageError = ''; // a save is the next thing the person did: an older row refusal is stale
    try {
      await erplora().command('reservations.timeslots.create', {
        day_of_week: Number(this.slotDay),
        start_time: this.slotStart.length === 5 ? `${this.slotStart}:00` : this.slotStart,
        end_time: this.slotEnd.length === 5 ? `${this.slotEnd}:00` : this.slotEnd,
        max_reservations: Number(this.slotMax) || 10,
      });
      this.slotStart = '';
      this.slotEnd = '';
      this.timeDrafts.clear();
      this.slotMax = '10';
      this.dataTable('slots')?.close(); // si no, el panel se queda abierto tapando la franja creada
      await this.slotsCtrl.load();
    } catch (e) {
      this.slotFormError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errCreateSlot');
    } finally {
      this.saving = false;
    }
  }

  private async createBlocked(ev: Event) {
    ev.preventDefault();
    if (this.dateDrafts.unreadable(erplora().locale, 'blocked')) {
      this.blockedFormError = erplora().t(CATALOG, 'ui.valDateUnreadable');
      return;
    }
    if (!this.blockDate) return;
    this.saving = true;
    this.blockedFormError = '';
    this.pageError = ''; // a save is the next thing the person did: an older row refusal is stale
    try {
      await erplora().command('reservations.blocked_dates.create', {
        date: this.blockDate,
        reason: this.blockReason.trim(),
        is_full_day: true,
      });
      this.blockDate = '';
      this.dateDrafts.forget('blocked');
      this.blockReason = '';
      this.dataTable('blocked')?.close(); // si no, el panel se queda abierto tapando la fecha creada
      await this.blockedCtrl.load();
    } catch (e) {
      this.blockedFormError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errBlockDate');
    } finally {
      this.saving = false;
    }
  }

  private async onSlotAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    this.pageError = '';
    try {
      await erplora().command('reservations.timeslots.delete', { time_slot_id: ev.detail.row.id as string });
      await this.slotsCtrl.load();
    } catch (e) {
      this.pageError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errDeleteSlot');
    }
  }

  private async onBlockedAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    this.pageError = '';
    try {
      await erplora().command('reservations.blocked_dates.delete', { blocked_date_id: ev.detail.row.id as string });
      await this.blockedCtrl.load();
    } catch (e) {
      this.pageError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errDeleteBlocked');
    }
  }

  /** pm#513: the refusal appears ABOVE the button that was pressed, at the foot of the form — on a
   *  phone that can leave it off the sheet. `updated` runs once it has painted itself: scrolled
   *  before, the banner would still measure 0 px and end up under the tab bar. */
  updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has('slotFormError') && this.slotFormError) this.revealFormError('slot');
    if (changed.has('blockedFormError') && this.blockedFormError) this.revealFormError('blocked');
  }

  private revealFormError(form: 'slot' | 'blocked'): void {
    this.renderRoot
      .querySelector<HTMLElement>(
        form === 'slot'
          ? '[data-testid="reservations-availability-slot-form-error"]'
          : '[data-testid="reservations-availability-blocked-form-error"]',
      )
      ?.scrollIntoView?.({ block: 'center' });
  }

  // Dos CRUD apilados: cada `<form slot="create">` da de alta UNA FILA de la tabla que lo contiene.
  // El título de la vista lo pinta el topbar del shell; los <h3> se quedan porque rotulan cada tabla.
  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
        ${this.pageError ? html`<p class="err" data-testid="reservations-availability-page-error">${this.pageError}</p>` : nothing}
        ${this.occError ? html`<p class="err" data-testid="reservations-availability-occupancy-error">${this.occError}</p>` : nothing}
        ${this.slotsCtrl?.error ? html`<p class="err" data-testid="reservations-availability-slots-error">${this.slotsCtrl.error}</p>` : nothing}
        ${this.blockedCtrl?.error ? html`<p class="err" data-testid="reservations-availability-blocked-error">${this.blockedCtrl.error}</p>` : nothing}
        <h3>${t('ui.sectionOccupancy')}</h3>
        <ok-data-table id="occupancy" testid="reservations-availability-occupancy-table" .columns=${this.occColumns} .rows=${this.occRows} .rowKeyField=${'timeslot_id'} .pageSize=${50} .emptyMessage=${this.occLoading ? t('ui.loading') : t('ui.emptyOccupancy')}>
          <!-- The date being looked at lives in THIS table's toolbar (no loose controls outside
               the tables) — touch-sized: the floor manager picks it with a thumb. -->
          <div slot="toolbar" class="occ-date">
            <!-- reservations#78: text in the hub's day/month order, not the native date input (browser order). -->
            <ion-input mode="md" fill="outline" label-placement="floating" label=${t('ui.colDate')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.datePlaceholder')} data-testid="reservations-availability-occupancy-date" .value=${this.dateDrafts.shown('occupancy', this.occDate, erplora().locale)} @ionInput=${(e: CustomEvent) => this.onOccupancyDateInput(String((e.target as HTMLInputElement).value ?? ''))} @ionChange=${() => this.dateDrafts.forget('occupancy')}></ion-input>
          </div>
        </ok-data-table>
        <h3>${t('ui.sectionTimeSlots')}</h3>
        <ok-data-table id="slots" testid="reservations-availability-slots-table" .labels=${{ add: t('ui.btnAddSlot') }} .serverSide=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => `${DAY_KEYS[Number(row.day_of_week)] ? t(DAY_KEYS[Number(row.day_of_week)]) : '—'} · ${fmtTime(String(row.start_time ?? ''))}`} .columns=${this.slotColumns} .rows=${this.slotsCtrl?.rows ?? []} .total=${this.slotsCtrl?.total ?? 0} .page=${this.slotsCtrl?.state.page ?? 0} .pageSize=${this.slotsCtrl?.state.pageSize ?? 50} .sort=${this.slotsCtrl?.state.sort} .sortDir=${this.slotsCtrl?.state.dir ?? 'asc'} .searchable=${true} .actions=${this.rowActions} .emptyMessage=${this.slotsCtrl?.loading ? t('ui.loading') : t('ui.emptyTimeSlots')} @rowAction=${(e: CustomEvent) => this.onSlotAction(e)} @pageChange=${(e: CustomEvent<number>) => this.slotsCtrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.slotsCtrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.slotsCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.slotsCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.slotsCtrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Se proyecta SIEMPRE (aunque el panel esté cerrado): si no, el «+» abriría un panel vacío. -->
          <form slot="create" class="form" data-testid="reservations-availability-slot-form" @submit=${(e: Event) => this.createSlot(e)}>
            <ion-select fill="outline" label-placement="floating" label=${t('ui.colDay')} data-testid="reservations-availability-slot-day" .value=${this.slotDay} @ionChange=${(e: any) => (this.slotDay = e.target.value)}>${DAY_KEYS.map((key, i) => html`<ion-select-option .value=${String(i)}>${t(key)}</ion-select-option>`)}</ion-select>
            <!-- reservations#77: TEXT time fields painted in the hub's clock, never type="time": the
                 browser paints a native time field with its own (operating system) clock. -->
            <ion-input fill="outline" mode="md" label-placement="floating" label=${t('ui.colStart')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.timePlaceholder')} data-testid="reservations-availability-slot-start" .value=${this.timeDrafts.shown('start', this.slotStart, erplora().locale)} @ionInput=${(e: any) => (this.slotStart = this.timeDrafts.input('start', String(e.target.value ?? '')))} @ionChange=${() => this.timeDrafts.leave('start')} @paste=${(e: Event) => { const time = this.timeDrafts.paste('start', e); if (time) this.slotStart = time; }}></ion-input>
            <ion-input fill="outline" mode="md" label-placement="floating" label=${t('ui.colEnd')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.timePlaceholder')} data-testid="reservations-availability-slot-end" .value=${this.timeDrafts.shown('end', this.slotEnd, erplora().locale)} @ionInput=${(e: any) => (this.slotEnd = this.timeDrafts.input('end', String(e.target.value ?? '')))} @ionChange=${() => this.timeDrafts.leave('end')} @paste=${(e: Event) => { const time = this.timeDrafts.paste('end', e); if (time) this.slotEnd = time; }}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phMax')} type="number" min="1" data-testid="reservations-availability-slot-max" .value=${this.slotMax} @ionInput=${(e: any) => (this.slotMax = e.target.value)}></ion-input>
            <!-- pm#513: the refusal travels WITH the form — on a phone the panel is a full-screen
                 sheet and a banner on the page underneath it is never seen. -->
            ${this.slotFormError ? html`<p class="err" data-testid="reservations-availability-slot-form-error">${this.slotFormError}</p>` : nothing}
            <ion-button type="submit" data-testid="reservations-availability-slot-submit" ?disabled=${this.saving || ((!this.slotStart || !this.slotEnd) && !this.timeDrafts.unreadable('start', 'end'))}>${t('ui.btnCreateSlot')}</ion-button>
          </form>
        </ok-data-table>
        <h3>${t('ui.sectionBlockedDates')}</h3>
        <ok-data-table id="blocked" testid="reservations-availability-blocked-table" .labels=${{ add: t('ui.btnAddBlockedDate') }} .serverSide=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.date ?? row.reason ?? '—')} .columns=${this.blockColumns} .rows=${this.blockedCtrl?.rows ?? []} .total=${this.blockedCtrl?.total ?? 0} .page=${this.blockedCtrl?.state.page ?? 0} .pageSize=${this.blockedCtrl?.state.pageSize ?? 50} .sort=${this.blockedCtrl?.state.sort} .sortDir=${this.blockedCtrl?.state.dir ?? 'asc'} .searchable=${true} .actions=${this.rowActions} .emptyMessage=${this.blockedCtrl?.loading ? t('ui.loading') : t('ui.emptyBlockedDates')} @rowAction=${(e: CustomEvent) => this.onBlockedAction(e)} @pageChange=${(e: CustomEvent<number>) => this.blockedCtrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.blockedCtrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.blockedCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.blockedCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.blockedCtrl.setFilter(e.detail.col, e.detail.value)}>
          <form slot="create" class="form" data-testid="reservations-availability-blocked-form" @submit=${(e: Event) => this.createBlocked(e)}>
            <!-- reservations#78: text in the hub's day/month order, not the native date input (browser order). -->
            <ion-input fill="outline" mode="md" label-placement="floating" label=${t('ui.colDate')} type="text" inputmode="numeric" autocomplete="off" placeholder=${t('ui.datePlaceholder')} data-testid="reservations-availability-blocked-date" .value=${this.dateDrafts.shown('blocked', this.blockDate, erplora().locale)} @ionInput=${(e: any) => (this.blockDate = this.dateDrafts.input('blocked', String(e.target.value ?? ''), erplora().locale))} @ionChange=${() => this.dateDrafts.leave('blocked', erplora().locale)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phReason')} data-testid="reservations-availability-blocked-reason" .value=${this.blockReason} @ionInput=${(e: any) => (this.blockReason = e.target.value)}></ion-input>
            ${this.blockedFormError ? html`<p class="err" data-testid="reservations-availability-blocked-form-error">${this.blockedFormError}</p>` : nothing}
            <ion-button type="submit" data-testid="reservations-availability-blocked-submit" ?disabled=${this.saving || (!this.blockDate && !this.dateDrafts.unreadable(erplora().locale, 'blocked'))}>${t('ui.btnBlockDate')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-reservations-availability', ErpReservationsAvailability);
