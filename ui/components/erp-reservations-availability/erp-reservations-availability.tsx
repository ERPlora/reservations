import { Component, State, h } from '@stencil/core';
import '../../../../_shared/ui/components/data-table/data-table';
import type { DataTableColumn } from '../../../../_shared/ui/components/data-table/data-table';

// Web Component del módulo `reservations` (vista disponibilidad). Mini-app: gestiona las
// ventanas horarias (timeslots) y las fechas bloqueadas (blocked dates) en dos tablas.
// NO toca la BD: todo va por el SDK. El motor de disponibilidad real (cruce de slots,
// capacidad, ventana de antelación) vive en WASM (ver WASM-TODO.md): aquí solo es CRUD.

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
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

@Component({
  tag: 'erp-reservations-availability',
  shadow: true,
  styles: `
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    h2 { margin:1rem 0 .5rem; font-size:1.15rem; }
    h3 { margin:1.25rem 0 .5rem; font-size:1rem; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:7rem; }
    .err { color:#d9480f; font-weight:600; }
  `,
})
export class ErpReservationsAvailability {
  @State() slots: TimeSlot[] = [];
  @State() blocked: BlockedDate[] = [];
  @State() loading = true;
  @State() saving = false;
  @State() error = '';

  // Form slot
  @State() slotDay = '0';
  @State() slotStart = '';
  @State() slotEnd = '';
  @State() slotMax = '10';

  // Form blocked date
  @State() blockDate = '';
  @State() blockReason = '';

  private unsub?: () => void;

  private slotColumns: DataTableColumn[] = [
    { key: 'day_of_week', header: 'Día', format: (r) => DAYS[r.day_of_week as number] ?? '?' },
    { key: 'start_time', header: 'Desde' },
    { key: 'end_time', header: 'Hasta' },
    { key: 'max_reservations', header: 'Máx', align: 'right' },
  ];

  private blockColumns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha' },
    { key: 'reason', header: 'Motivo' },
    { key: 'is_full_day', header: 'Día completo', format: (r) => (r.is_full_day ? 'Sí' : 'No') },
  ];

  private rowActions = [{ id: 'remove', label: 'Quitar', icon: 'trash-outline', color: 'danger' }];

  async componentWillLoad() {
    await this.refresh();
    try {
      const offs = [
        erplora().on('reservations.timeslot.created', () => this.refresh()),
        erplora().on('reservations.timeslot.deleted', () => this.refresh()),
        erplora().on('reservations.blocked_date.created', () => this.refresh()),
        erplora().on('reservations.blocked_date.deleted', () => this.refresh()),
      ];
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) */
    }
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private async refresh() {
    this.loading = true;
    this.error = '';
    try {
      const [slots, blocked] = await Promise.all([
        erplora().query<TimeSlot[]>('reservations.timeslots.list'),
        erplora().query<BlockedDate[]>('reservations.blocked_dates.list', { date_from: '', date_to: '', limit: 200 }),
      ]);
      this.slots = slots ?? [];
      this.blocked = blocked ?? [];
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error cargando disponibilidad';
    } finally {
      this.loading = false;
    }
  }

  private async createSlot(ev: Event) {
    ev.preventDefault();
    if (!this.slotStart || !this.slotEnd) return;
    this.saving = true;
    this.error = '';
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
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo crear la franja';
    } finally {
      this.saving = false;
    }
  }

  private async createBlocked(ev: Event) {
    ev.preventDefault();
    if (!this.blockDate) return;
    this.saving = true;
    this.error = '';
    try {
      await erplora().command('reservations.blocked_dates.create', {
        date: this.blockDate,
        reason: this.blockReason.trim(),
        is_full_day: true,
      });
      this.blockDate = '';
      this.blockReason = '';
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo bloquear la fecha';
    } finally {
      this.saving = false;
    }
  }

  private async onSlotAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    try {
      await erplora().command('reservations.timeslots.delete', { time_slot_id: ev.detail.row.id as string });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo borrar la franja';
    }
  }

  private async onBlockedAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    if (ev.detail.actionId !== 'remove') return;
    try {
      await erplora().command('reservations.blocked_dates.delete', { blocked_date_id: ev.detail.row.id as string });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo borrar la fecha';
    }
  }

  render() {
    return (
      <div>
        <h2>Disponibilidad</h2>
        {this.error && <p class="err">{this.error}</p>}

        <h3>Franjas horarias</h3>
        <form class="form" onSubmit={(e) => this.createSlot(e)}>
          <ion-select value={this.slotDay} onIonChange={(e: any) => (this.slotDay = e.target.value)}>
            {DAYS.map((d, i) => (
              <ion-select-option value={String(i)} key={i}>
                {d}
              </ion-select-option>
            ))}
          </ion-select>
          <ion-input type="time" value={this.slotStart} onIonInput={(e: any) => (this.slotStart = e.target.value)} />
          <ion-input type="time" value={this.slotEnd} onIonInput={(e: any) => (this.slotEnd = e.target.value)} />
          <ion-input type="number" min="1" placeholder="Máx" value={this.slotMax} onIonInput={(e: any) => (this.slotMax = e.target.value)} />
          <ion-button type="submit" size="small" disabled={this.saving || !this.slotStart || !this.slotEnd}>
            Añadir franja
          </ion-button>
        </form>
        <data-table
          columns={this.slotColumns}
          rows={this.slots as unknown as Record<string, unknown>[]}
          actions={this.rowActions}
          onRowAction={(e: CustomEvent) => this.onSlotAction(e)}
          emptyMessage={this.loading ? 'Cargando…' : 'Sin franjas horarias.'}
        />

        <h3>Fechas bloqueadas</h3>
        <form class="form" onSubmit={(e) => this.createBlocked(e)}>
          <ion-input type="date" value={this.blockDate} onIonInput={(e: any) => (this.blockDate = e.target.value)} />
          <ion-input placeholder="Motivo" value={this.blockReason} onIonInput={(e: any) => (this.blockReason = e.target.value)} />
          <ion-button type="submit" size="small" disabled={this.saving || !this.blockDate}>
            Bloquear fecha
          </ion-button>
        </form>
        <data-table
          columns={this.blockColumns}
          rows={this.blocked as unknown as Record<string, unknown>[]}
          searchKeys={['date', 'reason']}
          actions={this.rowActions}
          onRowAction={(e: CustomEvent) => this.onBlockedAction(e)}
          emptyMessage={this.loading ? 'Cargando…' : 'Sin fechas bloqueadas.'}
        />
      </div>
    );
  }
}
