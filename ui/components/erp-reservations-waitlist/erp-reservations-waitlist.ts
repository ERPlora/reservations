import { LitElement, html, css, nothing } from 'lit';
import type { PropertyValues } from 'lit';
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
  is_contacted: boolean;
  is_converted: boolean;
}

// ── reservations#34: wall-clock text painted for humans ────────────────────────────────────
// Same rule as the reservations list: `date`/`preferred_time` are ISO TEXT (ADR-0007) and the
// table showed them raw. `preferred_time` can even be a legacy `HH:MM` (the schema always
// accepted it) — both shapes paint as the locale's hour without seconds.

/** `YYYY-MM-DD` → the locale's date. Anything else (empty, malformed) paints verbatim. */
function fmtDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return new Date(`${iso}T00:00:00`).toLocaleDateString(erplora().locale || 'es');
}

/** `HH:MM[:SS]` → the hour the dining room reads, without the seconds. */
function fmtTime(time: string): string {
  if (!/^\d{2}:\d{2}(:\d{2})?$/.test(time)) return time;
  const wide = time.length === 5 ? `${time}:00` : time;
  return new Date(`2000-01-01T${wide}`).toLocaleTimeString(erplora().locale || 'es', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function erplora(): ErploraClientLike {
  const c = (globalThis as { erplora?: ErploraClientLike }).erplora;
  if (!c) throw new Error('erplora SDK no inicializado por el shell');
  return c;
}

export class ErpReservationsWaitlist extends LitElement {
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

  /** What the create panel's form was refused. Painted INSIDE the form (pm#513). */
  @state() formError = '';

  /** What went wrong in a ROW action (contact, convert, remove): no panel is open then, so it is
   *  painted on the page (pm#513). */
  @state() pageError = '';

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
    { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => fmtDate(r.date as string) },
    { key: 'preferred_time', header: t('ui.colPreferredTime'), sortable: true, filterable: true, filterType: 'text', format: (r) => fmtTime(r.preferred_time as string) },
    { key: 'guest_name', header: t('ui.colGuestName'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_phone', header: t('ui.colGuestPhone'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'party_size', header: t('ui.colPartySize'), align: 'right', sortable: true, filterable: true, filterType: 'range' },
    {
      key: 'is_contacted',
      header: t('ui.colContacted'),
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

  // Referencia al ok-data-table para cerrar su panel lateral (drawer) tras el alta.
  private dataTable(): { open(p?: 'filters' | 'create'): void; close(): void } | null {
    return this.renderRoot.querySelector('ok-data-table') as
      | { open(p?: 'filters' | 'create'): void; close(): void }
      | null;
  }

  private async createEntry(ev: Event) {
    ev.preventDefault();
    if (!this.newName.trim() || !this.newPhone.trim() || !this.newDate || !this.newTime) return;
    this.saving = true;
    this.formError = '';
    this.pageError = ''; // a save is the next thing the person did: an older row refusal is stale
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
      this.dataTable()?.close(); // si no, el panel se queda abierto tapando la entrada recién creada
      await this.ctrl.load();
    } catch (e) {
      this.formError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errAddWaitlist');
    } finally {
      this.saving = false;
    }
  }

  private async onRowAction(ev: CustomEvent<{ actionId: string; row: Record<string, unknown> }>) {
    const { actionId, row } = ev.detail;
    this.pageError = '';
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
      this.pageError = e instanceof Error ? e.message : erplora().t(CATALOG, 'ui.errUpdateWaitlist');
    }
  }

  /** pm#513: the refusal appears ABOVE the button that was pressed, at the foot of the form — on a
   *  phone that can leave it off the sheet. `updated` runs once it has painted itself: scrolled
   *  before, the banner would still measure 0 px and end up under the tab bar. */
  updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has('formError') && this.formError) this.revealFormError();
  }

  private revealFormError(): void {
    this.renderRoot.querySelector<HTMLElement>('[data-testid="reservations-waitlist-form-error"]')?.scrollIntoView?.({ block: 'center' });
  }

  // El título de la vista lo pinta el topbar del shell: repetirlo aquí lo duplicaba en pantalla.
  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return html`<div class="page">
        ${this.pageError ? html`<p class="err" data-testid="reservations-waitlist-page-error">${this.pageError}</p>` : nothing}
        ${this.ctrl?.error ? html`<p class="err" data-testid="reservations-waitlist-load-error">${this.ctrl.error}</p>` : nothing}
        <ok-data-table testid="reservations-waitlist-table" .labels=${{ add: t('ui.btnAddGuest') }} .serverSide=${true} .fill=${true} .addable=${true} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.guest_name ?? row.id ?? '—')} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${this.ctrl?.loading ? t('ui.loading') : t('ui.emptyWaitlist')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Alta en la lista de espera: se proyecta SIEMPRE (aunque el panel esté cerrado); si se
               renderizara solo con el panel abierto, el «+» de la barra abriría un panel vacío. -->
          <form slot="create" class="form" data-testid="reservations-waitlist-form" @submit=${(e: Event) => this.createEntry(e)}>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phGuestName')} data-testid="reservations-waitlist-guest-name" .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phGuestPhone')} data-testid="reservations-waitlist-guest-phone" .value=${this.newPhone} @ionInput=${(e: any) => (this.newPhone = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colDate')} type="date" data-testid="reservations-waitlist-date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.colTime')} type="time" data-testid="reservations-waitlist-time" .value=${this.newTime} @ionInput=${(e: any) => (this.newTime = e.target.value)}></ion-input>
            <ion-input fill="outline" label-placement="floating" label=${t('ui.phPartySize')} type="number" min="1" data-testid="reservations-waitlist-party-size" .value=${this.newParty} @ionInput=${(e: any) => (this.newParty = e.target.value)}></ion-input>
            <!-- pm#513: the refusal travels WITH the form — on a phone the panel is a full-screen
                 sheet and a banner on the page underneath it is never seen. -->
            ${this.formError ? html`<p class="err" data-testid="reservations-waitlist-form-error">${this.formError}</p>` : nothing}
            <ion-button type="submit" data-testid="reservations-waitlist-submit" ?disabled=${this.saving || !this.newName || !this.newPhone || !this.newDate || !this.newTime}>${this.saving ? t('ui.btnSaving') : t('ui.btnAddToWaitlist')}</ion-button>
          </form>
        </ok-data-table>
      </div>`;
  }
}

define('erp-reservations-waitlist', ErpReservationsWaitlist);
