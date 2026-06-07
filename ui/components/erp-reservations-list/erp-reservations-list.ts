import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';

interface ErploraClientLike extends ListClient {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  queryPage<R = unknown>(name: string, params: ListParams): Promise<ListPage<R>>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
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

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pendiente',
  confirmed: 'Confirmada',
  seated: 'Sentada',
  completed: 'Completada',
  cancelled: 'Cancelada',
  no_show: 'No-show',
};

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ErpReservationsList extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
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

  private columns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha', sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'time', header: 'Hora', sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_name', header: 'Cliente', sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_phone', header: 'Teléfono', sortable: true, filterable: true, filterType: 'text' },
    { key: 'party_size', header: 'Pax', align: 'right', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'status',
      header: 'Estado',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label })),
      format: (r) => STATUS_LABELS[r.status as string] ?? (r.status as string),
    },
  ];

  private actions = [
    { id: 'confirm', label: 'Confirmar', icon: 'checkmark-outline', color: 'primary' },
    { id: 'seat', label: 'Sentar', icon: 'restaurant-outline', color: 'success' },
    { id: 'complete', label: 'Completar', icon: 'checkmark-done-outline', color: 'medium' },
    { id: 'cancel', label: 'Cancelar', icon: 'close-outline', color: 'danger' },
  ];

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
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
    super.disconnectedCallback();
    this.unsub?.();
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
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear la reserva';
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
      this.formError = e instanceof Error ? e.message : 'No se pudo cambiar el estado';
    }
  }

  render() {
    return html`<div>
        <header>
          <h2>Reservas</h2>
        </header>
        <form class="form" @submit=${(e) => this.createReservation(e)}>
          <ion-input placeholder="Cliente" .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
          <ion-input placeholder="Teléfono" .value=${this.newPhone} @ionInput=${(e: any) => (this.newPhone = e.target.value)}></ion-input>
          <ion-input type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
          <ion-input type="time" .value=${this.newTime} @ionInput=${(e: any) => (this.newTime = e.target.value)}></ion-input>
          <ion-input type="number" min="1" placeholder="Pax" .value=${this.newParty} @ionInput=${(e: any) => (this.newParty = e.target.value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newName || !this.newDate || !this.newTime}>${this.saving ? 'Guardando…' : 'Reservar'}</ion-button>
        </form>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${"Buscar cliente, teléfono o fecha…"} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? 'Cargando…' : 'Sin reservas.'} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-reservations-list', ErpReservationsList);
