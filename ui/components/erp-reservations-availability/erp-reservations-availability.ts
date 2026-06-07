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

const DAYS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ErpReservationsAvailability extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    h2 { margin:1rem 0 .5rem; font-size:1.15rem; }
    h3 { margin:1.25rem 0 .5rem; font-size:1rem; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:7rem; }
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

  private slotColumns: DataTableColumn[] = [
    {
      key: 'day_of_week',
      header: 'Día',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: DAYS.map((label, i) => ({ value: String(i), label })),
      format: (r) => DAYS[r.day_of_week as number] ?? '?',
    },
    { key: 'start_time', header: 'Desde', sortable: true, filterable: true, filterType: 'text' },
    { key: 'end_time', header: 'Hasta', sortable: true, filterable: true, filterType: 'text' },
    { key: 'max_reservations', header: 'Máx', align: 'right', sortable: true, filterable: true, filterType: 'range' },
  ];

  private blockColumns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha', sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'reason', header: 'Motivo', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'is_full_day',
      header: 'Día completo',
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: [
        { value: '1', label: 'Sí' },
        { value: '0', label: 'No' },
      ],
      format: (r) => (r.is_full_day ? 'Sí' : 'No'),
    },
  ];

  private rowActions = [{ id: 'remove', label: 'Quitar', icon: 'trash-outline', color: 'danger' }];

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  async connectedCallback() {
    super.connectedCallback();
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
    super.disconnectedCallback();
    this.unsub?.();
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
      await this.slotsCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo crear la franja';
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
      await this.blockedCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo bloquear la fecha';
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
      this.formError = e instanceof Error ? e.message : 'No se pudo borrar la franja';
    }
  }

  private async onBlockedAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    try {
      await erplora().command('reservations.blocked_dates.delete', { blocked_date_id: ev.detail.row.id as string });
      await this.blockedCtrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : 'No se pudo borrar la fecha';
    }
  }

  render() {
    return html`<div>
        <h2>Disponibilidad</h2>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.slotsCtrl?.error ? html`<p class="err">${this.slotsCtrl.error}</p>` : nothing}
        ${this.blockedCtrl?.error ? html`<p class="err">${this.blockedCtrl.error}</p>` : nothing}
        <h3>Franjas horarias</h3>
        <form class="form" @submit=${(e) => this.createSlot(e)}>
          <ion-select .value=${this.slotDay} @ionChange=${(e: any) => (this.slotDay = e.target.value)}>${DAYS.map((d, i) => html`<ion-select-option .value=${String(i)}>${d}</ion-select-option>`)}</ion-select>
          <ion-input type="time" .value=${this.slotStart} @ionInput=${(e: any) => (this.slotStart = e.target.value)}></ion-input>
          <ion-input type="time" .value=${this.slotEnd} @ionInput=${(e: any) => (this.slotEnd = e.target.value)}></ion-input>
          <ion-input type="number" min="1" placeholder="Máx" .value=${this.slotMax} @ionInput=${(e: any) => (this.slotMax = e.target.value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.slotStart || !this.slotEnd}>Añadir franja</ion-button>
        </form>
        <ok-data-table .serverSide=${true} .columns=${this.slotColumns} .rows=${this.slotsCtrl?.rows ?? []} .total=${this.slotsCtrl?.total ?? 0} .page=${this.slotsCtrl?.state.page ?? 0} .pageSize=${this.slotsCtrl?.state.pageSize ?? 50} .sort=${this.slotsCtrl?.state.sort} .sortDir=${this.slotsCtrl?.state.dir ?? 'asc'} .searchable=${true} .actions=${this.rowActions} .emptyMessage=${this.slotsCtrl?.loading ? 'Cargando…' : 'Sin franjas horarias.'} @rowAction=${(e: CustomEvent) => this.onSlotAction(e)} @pageChange=${(e: CustomEvent<number>) => this.slotsCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.slotsCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.slotsCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.slotsCtrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
        <h3>Fechas bloqueadas</h3>
        <form class="form" @submit=${(e) => this.createBlocked(e)}>
          <ion-input type="date" .value=${this.blockDate} @ionInput=${(e: any) => (this.blockDate = e.target.value)}></ion-input>
          <ion-input placeholder="Motivo" .value=${this.blockReason} @ionInput=${(e: any) => (this.blockReason = e.target.value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.blockDate}>Bloquear fecha</ion-button>
        </form>
        <ok-data-table .serverSide=${true} .columns=${this.blockColumns} .rows=${this.blockedCtrl?.rows ?? []} .total=${this.blockedCtrl?.total ?? 0} .page=${this.blockedCtrl?.state.page ?? 0} .pageSize=${this.blockedCtrl?.state.pageSize ?? 50} .sort=${this.blockedCtrl?.state.sort} .sortDir=${this.blockedCtrl?.state.dir ?? 'asc'} .searchable=${true} .actions=${this.rowActions} .emptyMessage=${this.blockedCtrl?.loading ? 'Cargando…' : 'Sin fechas bloqueadas.'} @rowAction=${(e: CustomEvent) => this.onBlockedAction(e)} @pageChange=${(e: CustomEvent<number>) => this.blockedCtrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.blockedCtrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.blockedCtrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.blockedCtrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-reservations-availability', ErpReservationsAvailability);
