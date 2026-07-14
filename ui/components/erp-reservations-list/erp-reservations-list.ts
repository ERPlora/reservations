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

interface Reservation {
  id: string;
  guest_name: string;
  guest_phone: string;
  guest_email: string;
  date: string;
  time: string;
  party_size: number;
  duration_minutes: number;
  table_id: string | null;
  status: string;
  notes: string;
}

// Mapa estado → clave i18n. El valor (`value=`/enum) NO se traduce; la etiqueta visible sí.
const STATUS_KEYS: Record<string, string> = {
  pending: 'ui.statusPending',
  confirmed: 'ui.statusConfirmed',
  seated: 'ui.statusSeated',
  completed: 'ui.statusCompleted',
  cancelled: 'ui.statusCancelled',
  no_show: 'ui.statusNoShow',
};

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ErpReservationsList extends LitElement {
  static styles = css`
    :host { display:flex; flex-direction:column; height:100%; min-height:0; font-family: system-ui, sans-serif; color: var(--ion-text-color, #1c1b18); }
    /* La vista llena el alto: el data-table ocupa todo (scroll interno, pie fijo). */
    .page { display:flex; flex-direction:column; min-height:0; flex:1 1 auto; }
    .page > ok-data-table { flex:1 1 auto; min-height:0; }
    /* El alta vive en el panel lateral de la tabla (estrecho) → campos en columna, no en fila. */
    .form { display:flex; flex-direction:column; gap:.7rem; }
    .form ion-button { align-self:flex-end; }
    .err { color:#d9480f; font-weight:600; }
  `;

  @state() saving = false;

  @state() formError = '';

  @state() tick = 0;

  @state() newName = '';

  @state() newPhone = '';

  @state() newDate = '';

  @state() newTime = '';

  @state() newParty = '2';

  private ctrl!: ListController<Reservation>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render → los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'time', header: t('ui.colTime'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_name', header: t('ui.colGuestName'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_phone', header: t('ui.colGuestPhone'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'party_size', header: t('ui.colPartySize'), align: 'right', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'status',
      header: t('ui.colStatus'),
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: Object.entries(STATUS_KEYS).map(([value, key]) => ({ value, label: t(key) })),
      format: (r) => (STATUS_KEYS[r.status as string] ? t(STATUS_KEYS[r.status as string]) : (r.status as string)),
    },
    ];
  }

  private get actions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { id: 'confirm', label: t('ui.actionConfirm'), icon: 'checkmark-outline', color: 'primary' },
      { id: 'seat', label: t('ui.actionSeat'), icon: 'restaurant-outline', color: 'success' },
      { id: 'complete', label: t('ui.actionComplete'), icon: 'checkmark-done-outline', color: 'medium' },
      { id: 'cancel', label: t('ui.actionCancel'), icon: 'close-outline', color: 'danger' },
    ];
  }

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.ctrl = createListController<Reservation>(erplora(), 'reservations.reservations.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    await this.ctrl.load();
    try {
      const offs = [
        erplora().on('reservations.reservation.created', () => this.ctrl.load()),
        erplora().on('reservations.reservation.updated', () => this.ctrl.load()),
        erplora().on('reservations.reservation.status_changed', () => this.ctrl.load()),
        erplora().on('reservations.reservation.deleted', () => this.ctrl.load()),
      ];
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    window.removeEventListener('erplora:locale-changed', this.onLocaleChange);
    this.unsub?.();
    super.disconnectedCallback();
  }

  // Referencia al ok-data-table para cerrar su panel lateral (drawer) tras el alta.
  private dataTable(): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector('ok-data-table') as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  private async createReservation(ev: Event) {
    ev.preventDefault();
    if (!this.newName.trim() || !this.newDate || !this.newTime) return;
    this.saving = true;
    this.formError = '';
    try {
      await erplora().command('reservations.reservations.create', {
        guest_name: this.newName.trim(),
        guest_phone: this.newPhone.trim(),
        date: this.newDate,
        time: this.newTime.length === 5 ? `${this.newTime}:00` : this.newTime,
        party_size: Number(this.newParty) || 2,
      });
      this.newName = '';
      this.newPhone = '';
      this.newDate = '';
      this.newTime = '';
      this.newParty = '2';
      this.dataTable()?.close(); // si no, el panel se queda abierto tapando la reserva recién creada
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errCreateReservation');
    } finally {
      this.saving = false;
    }
  }

  private async onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    const { actionId, row } = ev.detail;
    const statusMap: Record<string, string> = {
      confirm: 'confirmed',
      seat: 'seated',
      complete: 'completed',
      cancel: 'cancelled',
    };
    const status = statusMap[actionId];
    if (!status) return;
    this.formError = '';
    try {
      await erplora().command('reservations.reservations.set_status', {
        reservation_id: row.id as string,
        status,
      });
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errSetStatus');
    }
  }

  // El título de la vista lo pinta el topbar del shell: repetirlo aquí lo duplicaba en pantalla.
  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div class="page">
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .fill=${true} .addable=${true} .columns=${this.columns} .views=${true} .cardTitle=${(r: Record<string, unknown>) => String(r.guest_name ?? '—')} .cardIcon=${() => 'calendar-outline'} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyReservations')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Alta de reserva: se proyecta SIEMPRE (aunque el panel esté cerrado); si se renderizara
               solo con el panel abierto, el «+» de la barra abriría un panel vacío. -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createReservation(e)}>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phGuestName')} .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phGuestPhone')} .value=${this.newPhone} @ionInput=${(e: any) => (this.newPhone = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colTime')} type="time" .value=${this.newTime} @ionInput=${(e: any) => (this.newTime = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phPartySize')} type="number" min="1" .value=${this.newParty} @ionInput=${(e: any) => (this.newParty = e.target.value)}></ion-input>
            <ion-button type="submit" ?disabled=${this.saving || !this.newName || !this.newDate || !this.newTime}>${this.saving ? t('ui.btnSaving') : t('ui.btnReserve')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-reservations-list', ErpReservationsList);
