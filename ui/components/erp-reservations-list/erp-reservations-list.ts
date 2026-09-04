import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-empty-state';
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

// ── reservations#34: wall-clock text painted for humans ────────────────────────────────────
// The rows carry date/time as ISO TEXT (ADR-0007) and the table showed them raw: «2026-07-13»
// and «20:00:00». The rest of the hub formats with Intl in the active language (appointments'
// `fmtTime`); these are WALL CLOCK values saved as text, so they parse as LOCAL (no Z) — the
// day painted is the day saved, whatever the browser's timezone is.

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

/** The `errors` catalog of `locales/{en,es}.json`, resolved by the active language.
 *
 *  It is NOT reachable through `erplora().t()`: that helper splits the key on dots to walk the
 *  catalog, and this module's `errors` block is FLAT — the whole namespaced code is ONE key
 *  (`"reservations.no_capacity"`), the same shape `appointments` and `customers` ship. */
function catalogError(code: string): string {
  for (const lang of [erplora().locale, 'en']) {
    const dict = (CATALOG[lang] as { errors?: Record<string, string> } | undefined)?.errors;
    const text = dict?.[code];
    if (typeof text === 'string' && text) return text;
  }
  return '';
}

/** A business refusal (hub#139) travels as a stable `code` plus the handler's English fallback
 *  sentence: paint the code's TRANSLATION, and keep the sentence for codes the catalog has not
 *  learned yet — same idea as `appointments` (`erp-appointments-list.ts::domainErrorText`).
 *
 *  reservations#31: until the create pre-check existed, EVERY rejection surfaced as the raw
 *  `reservations__gate` CHECK constraint — full slot, day without service and an oversized
 *  party were the same unreadable sentence. */
function domainErrorText(e: unknown, fallbackKey: string): string {
  const code = (e as { code?: unknown } | null)?.code;
  const message = e instanceof Error ? e.message : '';
  if (typeof code === 'string' && code.startsWith('reservations.')) {
    const text = catalogError(code);
    if (text) return text;
  }
  return message || erplora().t(CATALOG, fallbackKey);
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
    /* reservations#41 — la tabla se aparta cuando no tiene NADA que enseñar (primera vez,
       cargando, error): el vacío de un listado es una pantalla, no una fila gris. */
    ok-data-table[hidden] { display:none; }
    .state { flex:1 1 auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:.6rem; padding:2.5rem 1.25rem; text-align:center; }
    .state p { margin:0; max-width:38ch; color:var(--ion-color-medium, #92949c); }
    .hint { margin:.25rem 0 0; font-size:.85rem; color:var(--ion-color-medium, #92949c); max-width:38ch; }
    /* «Sin resultados» NO oculta la tabla: su buscador es la herramienta para corregir la
       consulta, así que la acción de limpiar va en una barra fina debajo. */
    .noresults { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; justify-content:center; gap:.75rem; padding:.75rem 1rem; text-align:center; }
    .noresults p { margin:0; color:var(--ion-color-medium, #92949c); }
  `;

  @state() saving = false;

  /** El panel de alta está abierto. Espeja el `panel` de la tabla para poder enseñar el estado
   *  vacío SIN perder el formulario, que vive en el panel lateral de la propia tabla. */
  @state() creating = false;

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
    { key: 'date', header: t('ui.colDate'), sortable: true, filterable: true, filterType: 'daterange', format: (r) => fmtDate(r.date as string) },
    { key: 'time', header: t('ui.colTime'), sortable: true, filterable: true, filterType: 'text', format: (r) => fmtTime(r.time as string) },
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

  /** ¿El vacío lo ha provocado el usuario al buscar/filtrar, o es que no hay ninguna reserva?
   *  Son dos pantallas distintas: a un restaurante con 300 reservas que filtra mal no se le
   *  puede decir «todavía no tienes reservas». */
  private get hasQuery(): boolean {
    const s = this.ctrl?.state;
    if (!s) return false;
    return s.search.trim() !== '' || Object.keys(s.filters).length > 0;
  }

  /** La tabla abre y cierra su panel por su cuenta (también con la «X») y no emite ningún
   *  evento al hacerlo; el click sí burbujea hasta el host, así que aquí se relee el estado
   *  real en vez de suponerlo. */
  private readonly syncPanel = (): void => {
    const open = (this.dataTable() as { panel?: string } | null)?.panel === 'create';
    if (open !== this.creating) this.creating = open;
  };

  /** Acción primaria: la misma alta desde el estado vacío y desde la barra. */
  private openCreate(): void {
    this.creating = true;
    this.dataTable()?.open('create');
  }

  /** Deshace la búsqueda y los filtros en una sola recarga.
   *
   *  El buscador de la tabla es NO controlado en modo `serverSide` (pinta sin `.value`), así que
   *  limpiar solo el estado dejaría el texto escrito en pantalla contradiciendo a la lista: se
   *  vacía también el `ion-searchbar`. Que la tabla acepte el valor desde fuera es cosa de
   *  outfitkit, no de este módulo. */
  private clearQuery(): void {
    const s = this.ctrl.state;
    s.search = '';
    for (const col of Object.keys(s.filters)) delete s.filters[col];
    s.page = 0;
    const bar = (this.dataTable() as { shadowRoot?: ShadowRoot } | null)?.shadowRoot?.querySelector(
      'ion-searchbar',
    ) as { value?: string } | null;
    if (bar) bar.value = '';
    void this.ctrl.load();
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
      this.creating = false;
      await this.ctrl.load();
    } catch (e) {
      this.formError = domainErrorText(e, 'ui.errCreateReservation');
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
      this.formError = domainErrorText(e, 'ui.errSetStatus');
    }
  }

  // El título de la vista lo pinta el topbar del shell: repetirlo aquí lo duplicaba en pantalla.
  //
  // reservations#41 — los cuatro estados de la pantalla se pintan, ninguno se deja en una tabla
  // gris: CARGANDO, ERROR (con reintento), VACÍO DE PRIMERA VEZ (cabecera + explicación + acción
  // primaria rotulada, patrón `help` de Odoo y EmptyState de Polaris) y VACÍO POR BÚSQUEDA (que
  // conserva el buscador y ofrece limpiar). La acción primaria va SIEMPRE con texto: el «+» de
  // `addable` era el cuarto icono de cuatro iguales.
  render() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const loading = this.ctrl?.loading ?? false;
    const error = this.ctrl?.error ?? '';
    const total = this.ctrl?.total ?? 0;
    // "Bare": no rows, no create panel open, no search or filter — nothing to show and no tool in
    // use. ONLY then does the table step aside and one full block (loading / error / first-run
    // empty state) takes the screen. With the create panel open the table stays: the form lives in
    // its drawer. With a search or filter active it stays EVEN while loading: the searchbar is what
    // the person is using, and hiding the table (display:none) dropped the focus on every key
    // (review of #44). With rows it never steps aside, and no loading block is stacked above it.
    const bare = total === 0 && !this.creating && !this.hasQuery;
    const firstRun = bare && !loading && !error;
    const noResults = total === 0 && !error && this.hasQuery;
    const showLoading = loading && bare;
    const hideTable = bare;

    const createButton = (slot?: string) => html`
      <ion-button
        slot=${slot ?? nothing}
        size="small"
        data-action="create"
        @click=${() => this.openCreate()}
      >${t('ui.emptyCta')}</ion-button>
    `;

    return html`<div class="page">
        ${this.formError ? html`<p class="err">${this.formError}</p>` : nothing}
        ${error
          ? html`<div class="state" data-state="error">
              <p class="err">${error}</p>
              <ion-button size="small" data-action="retry" @click=${() => void this.ctrl.load()}>${t('ui.btnRetry')}</ion-button>
            </div>`
          : nothing}
        ${showLoading
          ? html`<div class="state" data-state="loading">
              <ion-spinner></ion-spinner>
              <p>${t('ui.loading')}</p>
            </div>`
          : nothing}
        ${firstRun
          ? html`<ok-empty-state
              class="state"
              data-empty="first-run"
              icon="calendar-outline"
              .heading=${t('ui.emptyTitle')}
              .message=${t('ui.emptyBody')}
            >
              <p class="hint">${t('ui.emptyHint')}</p>
              ${createButton('action')}
            </ok-empty-state>`
          : nothing}
        <ok-data-table ?hidden=${hideTable} @click=${this.syncPanel} .serverSide=${true} .fill=${true} .addable=${false} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.guest_name ?? row.id ?? '—')} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${loading ? t('ui.loading') : this.hasQuery ? t('ui.noResultsTitle') : t('ui.emptyTitle')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.ctrl.setSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Acción primaria ROTULADA en la barra (reservations#41). Se proyecta dentro de la
               tabla, así que sigue sin haber ningún control de alta suelto fuera de ella. -->
          ${createButton('toolbar')}
          <!-- Alta de reserva: se proyecta SIEMPRE (aunque el panel esté cerrado); si se renderizara
               solo con el panel abierto, la acción primaria abriría un panel vacío. -->
          <form slot="create" class="form" @submit=${(e: Event) => this.createReservation(e)}>
            <ion-input label-placement="floating" label=${t('ui.phGuestName')} .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.phGuestPhone')} .value=${this.newPhone} @ionInput=${(e: any) => (this.newPhone = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.colDate')} type="date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.colTime')} type="time" .value=${this.newTime} @ionInput=${(e: any) => (this.newTime = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.phPartySize')} type="number" min="1" .value=${this.newParty} @ionInput=${(e: any) => (this.newParty = e.target.value)}></ion-input>
            <ion-button type="submit" ?disabled=${this.saving || !this.newName || !this.newDate || !this.newTime}>${this.saving ? t('ui.btnSaving') : t('ui.btnReserve')}</ion-button>
          </form>
        </ok-data-table>
        ${noResults
          ? html`<div class="noresults" data-empty="no-results">
              <p>${t('ui.noResultsBody')}</p>
              <ion-button size="small" fill="clear" data-action="clear-filters" @click=${() => this.clearQuery()}>${t('ui.btnClearFilters')}</ion-button>
            </div>`
          : nothing}
      </div>`;
  }
}

define('erp-reservations-list', ErpReservationsList);
