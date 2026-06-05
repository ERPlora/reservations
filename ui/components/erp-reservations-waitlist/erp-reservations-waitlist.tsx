import { Component, State, h } from '@stencil/core';
import '../../../../_shared/ui/components/data-table/data-table';
import type { DataTableColumn } from '../../../../_shared/ui/components/data-table/data-table';

// Web Component del módulo `reservations` (vista lista de espera). Mini-app: listado de la
// waitlist con alta rápida + acciones por fila (marcar contactado / convertido / quitar).
// NO toca la BD: todo va por el SDK. La promoción atómica waitlist→reserva vive en WASM
// (ver WASM-TODO.md); aquí solo se marca el flag is_converted.

interface ErploraClientLike {
  query<T = unknown>(name: string, params?: Record<string, unknown>): Promise<T>;
  command<T = unknown>(name: string, payload?: Record<string, unknown>): Promise<T>;
  on(event: string, cb: (payload: unknown) => void): () => void;
}

interface WaitlistEntry {
  id: string;
  guest_name: string;
  guest_phone: string;
  date: string;
  preferred_time: string;
  party_size: number;
  is_contacted: number;
  is_converted: number;
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

@Component({
  tag: 'erp-reservations-waitlist',
  shadow: true,
  styles: `
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.5rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input { --background:var(--surface-2,#f7f4ec); border:1px solid var(--line,#e7e2d6); border-radius:8px; min-width:8rem; }
    .err { color:#d9480f; font-weight:600; }
  `,
})
export class ErpReservationsWaitlist {
  @State() items: WaitlistEntry[] = [];
  @State() loading = true;
  @State() saving = false;
  @State() error = '';

  @State() newName = '';
  @State() newPhone = '';
  @State() newDate = '';
  @State() newTime = '';
  @State() newParty = '2';

  private unsub?: () => void;

  private columns: DataTableColumn[] = [
    { key: 'date', header: 'Fecha' },
    { key: 'preferred_time', header: 'Hora pref.' },
    { key: 'guest_name', header: 'Cliente' },
    { key: 'guest_phone', header: 'Teléfono' },
    { key: 'party_size', header: 'Pax', align: 'right' },
    { key: 'is_contacted', header: 'Contactado', format: (r) => (r.is_contacted ? 'Sí' : 'No') },
  ];

  private actions = [
    { id: 'contact', label: 'Contactado', icon: 'call-outline', color: 'primary' },
    { id: 'convert', label: 'Convertir', icon: 'checkmark-done-outline', color: 'success' },
    { id: 'remove', label: 'Quitar', icon: 'trash-outline', color: 'danger' },
  ];

  async componentWillLoad() {
    await this.refresh();
    try {
      const offs = [
        erplora().on('reservations.waitlist.created', () => this.refresh()),
        erplora().on('reservations.waitlist.updated', () => this.refresh()),
        erplora().on('reservations.waitlist.deleted', () => this.refresh()),
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
      const rows = await erplora().query<WaitlistEntry[]>('reservations.waitlist.list', {
        date_from: '',
        date_to: '',
        include_converted: 0,
        limit: 200,
      });
      this.items = rows ?? [];
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'Error cargando la lista de espera';
    } finally {
      this.loading = false;
    }
  }

  private async createEntry(ev: Event) {
    ev.preventDefault();
    if (!this.newName.trim() || !this.newPhone.trim() || !this.newDate || !this.newTime) return;
    this.saving = true;
    this.error = '';
    try {
      await erplora().command('reservations.waitlist.create', {
        guest_name: this.newName.trim(),
        guest_phone: this.newPhone.trim(),
        date: this.newDate,
        preferred_time: this.newTime.length === 5 ? `${this.newTime}:00` : this.newTime,
        party_size: Number(this.newParty) || 2,
      });
      this.newName = '';
      this.newPhone = '';
      this.newDate = '';
      this.newTime = '';
      this.newParty = '2';
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo añadir a la lista de espera';
    } finally {
      this.saving = false;
    }
  }

  private async onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    const { actionId, row } = ev.detail;
    this.error = '';
    try {
      if (actionId === 'remove') {
        await erplora().command('reservations.waitlist.delete', { entry_id: row.id as string });
      } else if (actionId === 'contact') {
        await erplora().command('reservations.waitlist.update', { entry_id: row.id as string, is_contacted: true });
      } else if (actionId === 'convert') {
        await erplora().command('reservations.waitlist.update', { entry_id: row.id as string, is_converted: true });
      }
      await this.refresh();
    } catch (e) {
      this.error = e instanceof Error ? e.message : 'No se pudo actualizar la entrada';
    }
  }

  render() {
    return (
      <div>
        <header>
          <h2>Lista de espera</h2>
        </header>

        <form class="form" onSubmit={(e) => this.createEntry(e)}>
          <ion-input placeholder="Cliente" value={this.newName} onIonInput={(e: any) => (this.newName = e.target.value)} />
          <ion-input placeholder="Teléfono" value={this.newPhone} onIonInput={(e: any) => (this.newPhone = e.target.value)} />
          <ion-input type="date" value={this.newDate} onIonInput={(e: any) => (this.newDate = e.target.value)} />
          <ion-input type="time" value={this.newTime} onIonInput={(e: any) => (this.newTime = e.target.value)} />
          <ion-input type="number" min="1" placeholder="Pax" value={this.newParty} onIonInput={(e: any) => (this.newParty = e.target.value)} />
          <ion-button type="submit" size="small" disabled={this.saving || !this.newName || !this.newPhone || !this.newDate || !this.newTime}>
            {this.saving ? 'Guardando…' : 'Añadir'}
          </ion-button>
        </form>

        {this.error && <p class="err">{this.error}</p>}

        <data-table
          columns={this.columns}
          rows={this.items as unknown as Record<string, unknown>[]}
          searchKeys={['guest_name', 'guest_phone', 'date']}
          searchPlaceholder="Buscar cliente, teléfono o fecha…"
          actions={this.actions}
          onRowAction={(e: CustomEvent) => this.onRowAction(e)}
          emptyMessage={this.loading ? 'Cargando…' : 'Lista de espera vacía.'}
        />
      </div>
    );
  }
}
