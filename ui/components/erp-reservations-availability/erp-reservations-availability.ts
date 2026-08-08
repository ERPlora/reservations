import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
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
  is_full_day: number;
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
  `;

  @state() saving = false;

  @state() formError = '';

  @state() tick = 0;

  @state() slotDay = '0';

  @state() slotStart = '';

  @state() slotEnd = '';

  @state() slotMax = '10';

  @state() blockDate = '';

  @state() blockReason = '';

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
    { key: 'start_time', header: t('ui.colStart'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'end_time', header: t('ui.colEnd'), sortable: true, filterable: true, filterType: 'text' },
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
      options: [
        { value: '1', label: t('ui.yes') },
        { value: '0', label: t('ui.no') },
      ],
      format: (r) => (r.is_full_day ? t('ui.yes') : t('ui.no')),
    },
    ];
  }

  private get rowActions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [{ id: 'remove', label: t('ui.actionRemove'), icon: 'trash-outline', color: 'danger' }];
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
    await Promise.all([this.slotsCtrl.load(), this.blockedCtrl.load()]);
    try {
      const offs = [
        erplora().on('reservations.timeslot.created', () => this.slotsCtrl.load()),
        erplora().on('reservations.timeslot.deleted', () => this.slotsCtrl.load()),
        erplora().on('reservations.blocked_date.created', () => this.blockedCtrl.load()),
        erplora().on('reservations.blocked_date.deleted', () => this.blockedCtrl.load()),
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
    if (!this.slotStart || !this.slotEnd) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('reservations.timeslots.create', {
        day_of_week: Number(this.slotDay),
        start_time: this.slotStart.length === 5 ? `${this.slotStart}:00` : this.slotStart,
        end_time: this.slotEnd.length === 5 ? `${this.slotEnd}:00` : this.slotEnd,
        max_reservations: Number(this.slotMax) || 10,
      });
      this.slotStart = '';
      this.slotEnd = '';
      this.slotMax = '10';
      this.dataTable('slots')?.close(); // si no, el panel se queda abierto tapando la franja creada
      await this.slotsCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errCreateSlot');
    } finally {
      this.saving = false;
    }
  }

  private async createBlocked(ev: Event) {
    ev.preventDefault();
    if (!this.blockDate) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('reservations.blocked_dates.create', {
        date: this.blockDate,
        reason: this.blockReason.trim(),
        is_full_day: true,
      });
      this.blockDate = '';
      this.blockReason = '';
      this.dataTable('blocked')?.close(); // si no, el panel se queda abierto tapando la fecha creada
      await this.blockedCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errBlockDate');
    } finally {
      this.saving = false;
    }
  }

  private async onSlotAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    try {
      await erplora().command('reservations.timeslots.delete', { time_slot_id: ev.detail.row.id as string });
      await this.slotsCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errDeleteSlot');
    }
  }

  private async onBlockedAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    try {
      await erplora().command('reservations.blocked_dates.delete', { blocked_date_id: ev.detail.row.id as string });
      await this.blockedCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errDeleteBlocked');
    }
  }

  // Dos CRUD apilados: cada `<form slot="create">` da de alta UNA FILA de la tabla que lo contiene.
  // El título de la vista lo pinta el topbar del shell; los <h3> se quedan porque rotulan cada tabla.
  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.slotsCtrl?.error ? html`<p class="err">${this.slotsCtrl.error}</p>` : nothing}
        ${this.blockedCtrl?.error ? html`<p class="err">${this.blockedCtrl.error}</p>` : nothing}
        <h3>${t('ui.sectionTimeSlots')}</h3>
        <ok-data-table id="slots" .serverSide=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => `${DAY_KEYS[Number(row.day_of_week)] ? t(DAY_KEYS[Number(row.day_of_week)]) : '—'} · ${String(row.start_time ?? '')}`} .columns=${this.slotColumns} .rows=${this.slotsCtrl?.rows ?? []} .total=${this.slotsCtrl?.total ?? 0} .page=${this.slotsCtrl?.state.page ?? 0} .pageSize=${this.slotsCtrl?.state.pageSize ?? 50} .sort=${this.slotsCtrl?.state.sort} .sortDir=${this.slotsCtrl?.state.dir ?? 'asc'} .searchable=${true} .actions=${this.rowActions} .emptyMessage=${this.slotsCtrl?.loading ? t('ui.loading') : t('ui.emptyTimeSlots')} @rowAction=${(e: CustomEvent) => this.onSlotAction(e)} @pageChange=${(e: CustomEvent<number>) => this.slotsCtrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.slotsCtrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.slotsCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.slotsCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.slotsCtrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Se proyecta SIEMPRE (aunque el panel esté cerrado): si no, el «+» abriría un panel vacío. -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createSlot(e)}>
            <ion-select fill="outline" label-placement="floating" label=${t('ui.colDay')} .value=${this.slotDay} @ionChange=${(e: any) => (this.slotDay = e.target.value)}>${DAY_KEYS.map((key, i) => html`<ion-select-option .value=${String(i)}>${t(key)}</ion-select-option>`)}</ion-select>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colStart')} type="time" .value=${this.slotStart} @ionInput=${(e: any) => (this.slotStart = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colEnd')} type="time" .value=${this.slotEnd} @ionInput=${(e: any) => (this.slotEnd = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phMax')} type="number" min="1" .value=${this.slotMax} @ionInput=${(e: any) => (this.slotMax = e.target.value)}></ion-input>
            <ion-button type="submit" ?disabled=${this.saving || !this.slotStart || !this.slotEnd}>${t('ui.btnAddSlot')}</ion-button>
          </form>
        </ok-data-table>
        <h3>${t('ui.sectionBlockedDates')}</h3>
        <ok-data-table id="blocked" .serverSide=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.date ?? row.reason ?? '—')} .columns=${this.blockColumns} .rows=${this.blockedCtrl?.rows ?? []} .total=${this.blockedCtrl?.total ?? 0} .page=${this.blockedCtrl?.state.page ?? 0} .pageSize=${this.blockedCtrl?.state.pageSize ?? 50} .sort=${this.blockedCtrl?.state.sort} .sortDir=${this.blockedCtrl?.state.dir ?? 'asc'} .searchable=${true} .actions=${this.rowActions} .emptyMessage=${this.blockedCtrl?.loading ? t('ui.loading') : t('ui.emptyBlockedDates')} @rowAction=${(e: CustomEvent) => this.onBlockedAction(e)} @pageChange=${(e: CustomEvent<number>) => this.blockedCtrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.blockedCtrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.blockedCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.blockedCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.blockedCtrl.setFilter(e.detail.col, e.detail.value)}>
          <form slot="create" class="form" @submit=${(e: Event) => this.createBlocked(e)}>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.blockDate} @ionInput=${(e: any) => (this.blockDate = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phReason')} .value=${this.blockReason} @ionInput=${(e: any) => (this.blockReason = e.target.value)}></ion-input>
            <ion-button type="submit" ?disabled=${this.saving || !this.blockDate}>${t('ui.btnBlockDate')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-reservations-availability', ErpReservationsAvailability);
