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

export class ErpReservationsWaitlist extends LitElement {
  static styles = css`
    :host { display:block; font-family: system-ui, sans-serif; color: var(--ink, #1c1b18); }
    header { display:flex; gap:.5rem; align-items:center; margin-bottom:.75rem; }
    h2 { margin:0; font-size:1.15rem; flex:1; }
    .form { display:flex; gap:.75rem; flex-wrap:wrap; align-items:end; margin:.5rem 0 1rem; }
    .form ion-input { flex:1 1 11rem; min-width:9rem; }
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

  private ctrl!: ListController<WaitlistEntry>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render → los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange' },
    { key: 'preferred_time', header: t('ui.colPreferredTime'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_name', header: t('ui.colGuestName'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_phone', header: t('ui.colGuestPhone'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'party_size', header: t('ui.colPartySize'), align: 'right', sortable: true, filterable: true, filterType: 'text' },
    {
      key: 'is_contacted',
      header: t('ui.colContacted'),
      sortable: true,
      filterable: true,
      filterType: 'select',
      options: [
        { value: '1', label: t('ui.yes') },
        { value: '0', label: t('ui.no') },
      ],
      format: (r) => (r.is_contacted ? t('ui.yes') : t('ui.no')),
    },
    ];
  }

  private get actions() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
      { id: 'contact', label: t('ui.actionContact'), icon: 'call-outline', color: 'primary' },
      { id: 'convert', label: t('ui.actionConvert'), icon: 'checkmark-done-outline', color: 'success' },
      { id: 'remove', label: t('ui.actionRemove'), icon: 'trash-outline', color: 'danger' },
    ];
  }

  // TODO-LIT: componentWillLoad → connectedCallback. Recuerda: connectedCallback se dispara
  // en CADA reconexión al DOM (no solo en el primer montaje). Si la init debe correr una
  // sola vez tras el primer render, considera firstUpdated() en su lugar.
  private readonly onLocaleChange = (): void => this.requestUpdate();

  async connectedCallback() {
    super.connectedCallback();
    window.addEventListener('erplora:locale-changed', this.onLocaleChange);
    this.ctrl = createListController<WaitlistEntry>(erplora(), 'reservations.waitlist.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'id',
      dir: 'asc',
    });
    await this.ctrl.load();
    try {
      const offs = [
        erplora().on('reservations.waitlist.created', () => this.ctrl.load()),
        erplora().on('reservations.waitlist.updated', () => this.ctrl.load()),
        erplora().on('reservations.waitlist.deleted', () => this.ctrl.load()),
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

  private async createEntry(ev: Event) {
    ev.preventDefault();
    if (!this.newName.trim() || !this.newPhone.trim() || !this.newDate || !this.newTime) return;
    this.saving = true;
    this.formError = '';
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
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errAddWaitlist');
    } finally {
      this.saving = false;
    }
  }

  private async onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    const { actionId, row } = ev.detail;
    this.formError = '';
    try {
      if (actionId === 'remove') {
        await erplora().command('reservations.waitlist.delete', { entry_id: row.id as string });
      } else if (actionId === 'contact') {
        await erplora().command('reservations.waitlist.update', { entry_id: row.id as string, is_contacted: true });
      } else if (actionId === 'convert') {
        await erplora().command('reservations.waitlist.update', { entry_id: row.id as string, is_converted: true });
      }
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errUpdateWaitlist');
    }
  }

  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div>
        <header>
          <h2>${t('ui.titleWaitlist')}</h2>
        </header>
        <form class="form" @submit=${(e) => this.createEntry(e)}>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.phGuestName')} .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.phGuestPhone')} .value=${this.newPhone} @ionInput=${(e: any) => (this.newPhone = e.target.value)}></ion-input>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.colTime')} type="time" .value=${this.newTime} @ionInput=${(e: any) => (this.newTime = e.target.value)}></ion-input>
          <ion-input fill="outline" label-placement="floating" label=${t('ui.phPartySize')} type="number" min="1" .value=${this.newParty} @ionInput=${(e: any) => (this.newParty = e.target.value)}></ion-input>
          <ion-button type="submit" size="small" ?disabled=${this.saving || !this.newName || !this.newPhone || !this.newDate || !this.newTime}>${this.saving ? t('ui.btnSaving') : t('ui.btnAdd')}</ion-button>
        </form>
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err">${this.ctrl.error}</p>` : nothing}
        <ok-data-table .serverSide=${true} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyWaitlist')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}></ok-data-table>
      </div>`;
  }
}

define('erp-reservations-waitlist', ErpReservationsWaitlist);
