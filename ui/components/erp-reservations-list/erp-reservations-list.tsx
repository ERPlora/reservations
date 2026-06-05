import { Component, State, h } from '@stencil/core';
// Importa el DataTable compartido (Stencil) para que se auto-registre y esbuild lo
// empaquete dentro del bundle del módulo. El shell provee los `ion-*`.
import '../../../../_shared/ui/components/data-table/data-table';
import type { DataTableColumn } from '../../../../_shared/ui/components/data-table/data-table';

// Web Component del módulo `reservations` (vista lista). Mini-app: listado de reservas
// con buscador + alta rápida + acciones por fila (confirmar / sentar / completar / cancelar).
// NO toca la BD: todo va por el SDK (erplora.query/command/on). La validación de la máquina
// de estados y el motor de disponibilidad viven en el handler WASM (ver WASM-TODO.md).

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
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

@Component({
  tag: 'erp-reservations-list',
  shadow: true,
  styles: `
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input, .form ion-select { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
    .filters { display:flex; gap:.5rem; align-items:center; margin-bottom:.5rem; }
    .err { color:#d9480f; font-weight:600; }
  `,
})
export class ErpReservationsList {
  @State() items: Reservation[] = [];
  @State() loading = true;
  @State() saving = false;
  @State() error = '';
  @State() filterStatus = '';

  // Form de alta rápida
  @State() newName = '';
  @State() newPhone = '';
  @State() newDate = '';
  @State() newTime = '';
  @State() newParty = '2';

  private unsub?: () => void;

  private columns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha' },
    { key: 'time', header: 'Hora' },
    { key: 'guest_name', header: 'Cliente' },
    { key: 'guest_phone', header: 'Teléfono' },
    { key: 'party_size', header: 'Pax', align: 'right' },
    { key: 'status', header: 'Estado', format: (r) => STATUS_LABELS[r.status as string] ?? (r.status as string) },
  ];

  private actions = [
    { id: 'confirm', label: 'Confirmar', icon: 'checkmark-outline', color: 'primary' },
    { id: 'seat', label: 'Sentar', icon: 'restaurant-outline', color: 'success' },
    { id: 'complete', label: 'Completar', icon: 'checkmark-done-outline', color: 'medium' },
    { id: 'cancel', label: 'Cancelar', icon: 'close-outline', color: 'danger' },
  ];

  async componentWillLoad() {
    await this.refresh();
    try {
      const offs = [
        erplora().on('reservations.reservation.created', () => this.refresh()),
        erplora().on('reservations.reservation.updated', () => this.refresh()),
        erplora().on('reservations.reservation.status_changed', () => this.refresh()),
        erplora().on('reservations.reservation.deleted', () => this.refresh()),
      ];
      this.unsub = () => offs.forEach((o) => o());
    } catch {
      /* sin SDK (preview) → sin reactividad en vivo */
    }
  }

  disconnectedCallback() {
    this.unsub?.();
  }

  private async refresh() {
    this.loading = true;
    this.error = '';
    try {
      const rows = await erplora().query<Reservation[]>('reservations.reservations.list', {
        status: this.filterStatus,
        date: '',
        limit: 200,
      });
      this.items = rows ?? [];
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error cargando reservas';
    } finally {
      this.loading = false;
    }
  }

  private async createReservation(ev: Event) {
    ev.preventDefault();
    if (!this.newName.trim() || !this.newDate || !this.newTime) return;
    this.saving = true;
    this.error = '';
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
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo crear la reserva';
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
    this.error = '';
    try {
      await erplora().command('reservations.reservations.set_status', {
        reservation_id: row.id as string,
        status,
      });
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo cambiar el estado';
    }
  }

  render() {
    return (
      <div>
        <header>
          <h2>Reservas</h2>
        </header>

        <form class="form" onSubmit={(e) => this.createReservation(e)}>
          <ion-input
            placeholder="Cliente"
            value={this.newName}
            onIonInput={(e: any) => (this.newName = e.target.value)}
          />
          <ion-input
            placeholder="Teléfono"
            value={this.newPhone}
            onIonInput={(e: any) => (this.newPhone = e.target.value)}
          />
          <ion-input
            type="date"
            value={this.newDate}
            onIonInput={(e: any) => (this.newDate = e.target.value)}
          />
          <ion-input
            type="time"
            value={this.newTime}
            onIonInput={(e: any) => (this.newTime = e.target.value)}
          />
          <ion-input
            type="number"
            min="1"
            placeholder="Pax"
            value={this.newParty}
            onIonInput={(e: any) => (this.newParty = e.target.value)}
          />
          <ion-button type="submit" size="small" disabled={this.saving || !this.newName || !this.newDate || !this.newTime}>
            {this.saving ? 'Guardando…' : 'Reservar'}
          </ion-button>
        </form>

        <div class="filters">
          <ion-select
            placeholder="Todos los estados"
            value={this.filterStatus}
            onIonChange={(e: any) => {
              this.filterStatus = e.target.value;
              this.refresh();
            }}
          >
            <ion-select-option value="">Todos</ion-select-option>
            <ion-select-option value="pending">Pendiente</ion-select-option>
            <ion-select-option value="confirmed">Confirmada</ion-select-option>
            <ion-select-option value="seated">Sentada</ion-select-option>
            <ion-select-option value="completed">Completada</ion-select-option>
            <ion-select-option value="cancelled">Cancelada</ion-select-option>
            <ion-select-option value="no_show">No-show</ion-select-option>
          </ion-select>
        </div>

        {this.error && <p class="err">{this.error}</p>}

        <data-table
          columns={this.columns}
          rows={this.items as unknown as Record<string, unknown>[]}
          searchKeys={['guest_name', 'guest_phone', 'date']}
          searchPlaceholder="Buscar cliente, teléfono o fecha…"
          actions={this.actions}
          onRowAction={(e: CustomEvent) => this.onRowAction(e)}
          emptyMessage={this.loading ? 'Cargando…' : 'Sin reservas.'}
        />
      </div>
    );
  }
}
