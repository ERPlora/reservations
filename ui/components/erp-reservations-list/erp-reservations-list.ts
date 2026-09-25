import { LitElement, html, css, nothing } from 'lit';
import { state } from 'lit/decorators.js';
import { define } from '@erplora/outfitkit/define';
import '@erplora/outfitkit/ok-data-table';
import '@erplora/outfitkit/ok-empty-state';
import type { DataTableColumn } from '@erplora/outfitkit';
import { createListController } from '@erplora/module-sdk';
import type { ListController, ListClient, ListParams, ListPage } from '@erplora/module-sdk';
import { addDaysISO, nowWallTime, todayISO } from '../../lib/business-time';
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

/** `YYYY-MM-DD` → the long day the header reads («viernes, 25 de septiembre»). Parsed and printed
 *  in UTC on purpose: it is a calendar date, not an instant, and no zone may shift it. */
function fmtLongDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const text = new Date(`${iso}T00:00:00Z`).toLocaleDateString(erplora().locale || 'es', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  // Sentence case, not CSS `capitalize`: that one turns «25 de septiembre» into «25 De Septiembre».
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/** A query answers an array of rows or `{ rows }`, depending on the runtime path. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** One slot of the day with its room, as `reservations.slots.count_for` answers it. */
interface SlotLoad {
  start_time: string;
  end_time: string;
  available: number;
}

/** What the header says about the next slot (reservations#45). `open`/`full` carry the slot. */
type NextSlot =
  | { state: 'open' | 'full'; slot: SlotLoad }
  | { state: 'over' | 'no-service' | 'closed' };

/** The slot the manager has to watch on `day`: on today, the first one that has not ENDED yet (a
 *  slot in progress still takes walk-ins and late bookings); on any other day, its first slot.
 *  A day blocked whole is closed whatever its slots say — the create gate refuses it too. */
function nextSlotOf(
  slots: SlotLoad[],
  closed: boolean,
  isToday: boolean,
  now: string,
): NextSlot {
  if (closed) return { state: 'closed' };
  if (slots.length === 0) return { state: 'no-service' };
  const ordered = [...slots].sort((a, b) => a.start_time.localeCompare(b.start_time));
  const slot = isToday ? ordered.find((s) => s.end_time > now) : ordered[0];
  if (!slot) return { state: 'over' };
  return { state: Number(slot.available) > 0 ? 'open' : 'full', slot };
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
    /* reservations#45 — the day bar: which day, and the three figures of its service. It sits
       OUTSIDE the table so it stays on screen when the day is empty and the table steps aside. */
    .daybar { flex:0 0 auto; display:flex; flex-wrap:wrap; align-items:center; gap:.5rem 1.25rem; padding:.5rem .75rem; border-bottom:1px solid var(--ion-color-step-150, #e0e0e0); }
    .daynav { display:flex; align-items:center; gap:.15rem; min-width:0; }
    .daynav ion-input { min-width:6.5rem; max-width:11rem; }
    .daynav ion-button.step { flex:0 0 auto; height:44px; width:44px; --padding-start:.25rem; --padding-end:.25rem; margin:0; }
    .dayname { margin:0; font-weight:600; }
    .figures { display:flex; flex-wrap:wrap; gap:.5rem 1.5rem; align-items:baseline; }
    .figure { display:flex; flex-direction:column; min-width:4.5rem; }
    .figure strong { font-size:1.35rem; line-height:1.2; font-variant-numeric:tabular-nums; }
    .figure span { font-size:.8rem; color:var(--ion-color-medium, #92949c); }
    .figure .full { color:var(--ion-color-danger, #eb445a); font-weight:600; }
    .figures ion-skeleton-text { width:9rem; height:1.35rem; }
    @media (max-width: 575px) {
      .daybar { padding:.4rem .5rem; }
      .daynav ion-button.step { width:40px; }
      .figures { gap:.4rem 1rem; }
    }
  `;

  @state() saving = false;

  /** reservations#45 — the service day the book is anchored to (restaurant calendar). */
  @state() day = todayISO();

  /** The figures of `day`: `null` while they load. */
  @state() private summary: { reservations: number; covers: number } | null = null;

  @state() private summaryError = '';

  @state() private daySlots: SlotLoad[] = [];

  @state() private dayClosed = false;

  /** Drops a summary answer that arrives after the day already moved on. */
  private summarySeq = 0;

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

  /** Los filtros que ESTE módulo le declara a la tabla (contrato `filterValues`, outfitkit#106).
   *
   *  La tabla reasigna su espejo de filtros solo cuando el objeto enlazado cambia de IDENTIDAD
   *  (Lit compara por identidad, y una mutación in-situ no llega a su `updated`). Eso es justo lo
   *  que hace falta: mientras siga siendo el mismo objeto, los filtros que la persona elija en el
   *  panel son suyos y nadie se los pisa; al limpiar se asigna uno NUEVO y la tabla se entera. */
  @state() private filterMirror: Record<string, unknown> = {};

  private ctrl!: ListController<Reservation>;

  private unsub?: () => void;

  // Getter (no campo): se re-evalúa en cada render → los textos cambian con el idioma activo
  // (ADR-0055). `connectedCallback` re-renderiza al recibir `erplora:locale-changed`.
  private get columns(): DataTableColumn[] {
    const t = (k: string): string => erplora().t(CATALOG, k);
    return [
    // No filter box on the date: the day bar owns it (reservations#45). A second control for the
    // same thing would fight the first one over which day is on screen.
    { key: 'date', header: t('ui.colDate'), sortable: true, format: (r) => fmtDate(r.date as string) },
    { key: 'time', header: t('ui.colTime'), sortable: true, filterable: true, filterType: 'text', format: (r) => fmtTime(r.time as string) },
    { key: 'guest_name', header: t('ui.colGuestName'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'guest_phone', header: t('ui.colGuestPhone'), sortable: true, filterable: true, filterType: 'text' },
    { key: 'party_size', header: t('ui.colPartySize'), align: 'right', sortable: true, filterable: true, filterType: 'range' },
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

  private labelsCache?: { locale: string; labels: Record<string, string> };

  /** Las etiquetas que este módulo le impone a la barra de la tabla.
   *
   *  El alta se llama «Nueva reserva», no «Añadir»: la acción principal de un listado NOMBRA su
   *  objeto —Odoo «New», Shopify «Add product», Fresha «Add booking»—, que es la misma decisión de
   *  mercado de reservations#41. Heredar el alta de la tabla (`addable`) no puede costar el
   *  rótulo; solo el botón hecho a mano.
   *
   *  Memoizado por idioma: un objeto literal nuevo en cada render marcaría `labels` como cambiada
   *  y le costaría a la tabla un ciclo de actualización por cada render de esta vista. */
  private get tableLabels(): Record<string, string> {
    const locale = erplora().locale;
    if (this.labelsCache?.locale !== locale) {
      this.labelsCache = { locale, labels: { add: erplora().t(CATALOG, 'ui.emptyCta') } };
    }
    return this.labelsCache.labels;
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
    // reservations#45: the book opens on today's service, in the order it happens.
    this.ctrl = createListController<Reservation>(erplora(), 'reservations.reservations.list', () => this.requestUpdate(), {
      pageSize: 50,
      sort: 'time',
      dir: 'asc',
      filters: { date: { from: this.day, to: this.day } },
    });
    await Promise.all([this.ctrl.load(), this.loadSummary()]);
    const reload = (): void => {
      void this.ctrl.load();
      void this.loadSummary();
    };
    try {
      const offs = [
        erplora().on('reservations.reservation.created', reload),
        erplora().on('reservations.reservation.updated', reload),
        erplora().on('reservations.reservation.status_changed', reload),
        erplora().on('reservations.reservation.deleted', reload),
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

  /** Did the person cause the emptiness by searching/filtering, or is the day simply empty?
   *  Two different screens: a restaurant with 300 bookings that filters badly must not read
   *  «no reservations». The day anchor is NOT a query the person typed: it is the view itself. */
  private get hasQuery(): boolean {
    const s = this.ctrl?.state;
    if (!s) return false;
    return s.search.trim() !== '' || Object.keys(s.filters).some((col) => col !== 'date');
  }

  /** Pins the list to `day` — unless a search is on: a name is looked up in the WHOLE book, the
   *  guest who booked next Friday has to be found from today (reservations#45).
   *  Across days the hour alone mixes them, so the matches go in calendar order (`starts_at`,
   *  date + time); back on one day, the hour is the service order again (reservations#67). A
   *  column the person sorted by on purpose is left alone. */
  private anchorDay(): void {
    const s = this.ctrl.state;
    if (s.search.trim()) {
      delete s.filters.date;
      if (s.sort === 'time') s.sort = 'starts_at';
    } else {
      s.filters.date = { from: this.day, to: this.day };
      if (s.sort === 'starts_at') s.sort = 'time';
    }
    s.page = 0;
  }

  /** Moves the book (list AND figures) to another service day. */
  private setDay(day: string): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day ?? '') || day === this.day) return;
    this.day = day;
    this.anchorDay();
    void this.ctrl.load();
    void this.loadSummary();
  }

  private onSearch(search: string): void {
    this.ctrl.state.search = search;
    this.anchorDay();
    void this.ctrl.load();
  }

  /** The figures of the day: covers + bookings (`reservations.day.summary`), the room per slot
   *  (`reservations.slots.count_for`, the gate's own count) and whether the day is blocked whole. */
  private async loadSummary(): Promise<void> {
    const day = this.day;
    const seq = ++this.summarySeq;
    this.summaryError = '';
    try {
      const [summary, slots, blocked] = await Promise.all([
        erplora().query('reservations.day.summary', { date: day }),
        erplora().query('reservations.slots.count_for', { date: day }),
        erplora().query('reservations.blocked_dates.on_date', { date: day }),
      ]);
      if (seq !== this.summarySeq) return;
      const row = rowsOf<{ reservations?: unknown; covers?: unknown }>(summary)[0] ?? {};
      this.summary = { reservations: Number(row.reservations ?? 0), covers: Number(row.covers ?? 0) };
      this.daySlots = rowsOf<SlotLoad>(slots);
      this.dayClosed = rowsOf<{ is_full_day?: unknown }>(blocked).some(
        (b) => b.is_full_day === true || Number(b.is_full_day) === 1,
      );
    } catch (e) {
      if (seq !== this.summarySeq) return;
      this.summary = null;
      this.summaryError = e instanceof Error && e.message ? e.message : erplora().t(CATALOG, 'ui.errDaySummary');
    }
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
   *  Las dos mitades viajan por el CONTRATO de la tabla —`search` (outfitkit#112) y `filterValues`
   *  (outfitkit#106)—: quien es dueño de la consulta declara lo que la persona está viendo, no solo
   *  lo lee. Antes esto se hacía a mano, alcanzando el `ion-searchbar` DENTRO del shadow root de la
   *  tabla para borrarle el texto; funcionaba, pero dejaba a la tabla creyendo que la búsqueda
   *  seguía puesta, y el día que ese nodo cambiara de nombre el `querySelector` devolvería `null`
   *  sin fallar: el buscador se quedaría escrito sin que nadie avisara. De los filtros, además, no
   *  se ocupaba nadie: el embudo seguía marcando uno que la lista ya no aplicaba. */
  private clearQuery(): void {
    const s = this.ctrl.state;
    s.search = '';
    for (const col of Object.keys(s.filters)) delete s.filters[col];
    this.anchorDay(); // the filters go, the day the book is on stays
    this.filterMirror = {};
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

  /** reservations#45 — the three questions of the shift: which day, how many covers, next slot.
   *  The day steps like this hub's agenda (appointments#93): previous · date · next, plus «Today»
   *  when the book is away from it. */
  private renderDayBar() {
    const t = (k: string): string => erplora().t(CATALOG, k);
    const today = todayISO();
    const isToday = this.day === today;
    const next = nextSlotOf(this.daySlots, this.dayClosed, isToday, nowWallTime());
    const nextText = (): unknown => {
      if (next.state === 'open' || next.state === 'full') {
        const range = `${fmtTime(next.slot.start_time)}–${fmtTime(next.slot.end_time)}`;
        return html`<strong>${range}</strong>
          ${next.state === 'full'
            ? html`<span class="full">${t('ui.full')}</span>`
            : html`<span>${next.slot.available} ${t('ui.slotLeft')}</span>`}`;
      }
      const key = { over: 'ui.noMoreServiceToday', 'no-service': 'ui.noServiceDay', closed: 'ui.closedDay' }[next.state];
      return html`<strong>—</strong><span>${t(key)}</span>`;
    };
    const figures = this.summaryError
      ? html`<p class="err" data-testid="reservations-summary-error">${this.summaryError}</p>`
      : !this.summary
        ? html`<ion-skeleton-text animated data-testid="reservations-summary-loading"></ion-skeleton-text>`
        : html`<div class="figure" data-testid="reservations-covers" data-value=${String(this.summary.covers)}>
              <strong>${this.summary.covers}</strong><span>${t('ui.covers')}</span>
            </div>
            <div class="figure" data-testid="reservations-bookings" data-value=${String(this.summary.reservations)}>
              <strong>${this.summary.reservations}</strong><span>${t('ui.bookings')}</span>
            </div>
            <div
              class="figure"
              data-testid="reservations-next-slot"
              data-state=${next.state}
              data-start=${next.state === 'open' || next.state === 'full' ? next.slot.start_time : nothing}
              data-available=${next.state === 'open' || next.state === 'full' ? String(next.slot.available) : nothing}
            >
              ${nextText()}<span>${t('ui.nextSlot')}</span>
            </div>`;
    return html`<div class="daybar" data-testid="reservations-day" data-day=${this.day}>
      <div class="daynav">
        <ion-button class="step" fill="clear" data-testid="reservations-prev-day" aria-label=${t('ui.prevDay')} @click=${() => this.setDay(addDaysISO(this.day, -1))}>
          <ion-icon slot="icon-only" name="chevron-back-outline"></ion-icon>
        </ion-button>
        <ion-input type="date" data-testid="reservations-day-input" aria-label=${t('ui.colDate')} .value=${this.day} @ionInput=${(e: any) => this.setDay(e.target.value)}></ion-input>
        <ion-button class="step" fill="clear" data-testid="reservations-next-day" aria-label=${t('ui.nextDay')} @click=${() => this.setDay(addDaysISO(this.day, 1))}>
          <ion-icon slot="icon-only" name="chevron-forward-outline"></ion-icon>
        </ion-button>
        ${isToday
          ? nothing
          : html`<ion-button size="small" fill="clear" data-testid="reservations-today" @click=${() => this.setDay(today)}>${t('ui.today')}</ion-button>`}
      </div>
      <p class="dayname">${fmtLongDate(this.day)}</p>
      <div class="figures">${figures}</div>
    </div>`;
  }

  // El título de la vista lo pinta el topbar del shell: repetirlo aquí lo duplicaba en pantalla.
  //
  // reservations#41 — los cuatro estados de la pantalla se pintan, ninguno se deja en una tabla
  // gris: CARGANDO, ERROR (con reintento), VACÍO DE PRIMERA VEZ (cabecera + explicación + acción
  // primaria rotulada, patrón `help` de Odoo y EmptyState de Polaris) y VACÍO POR BÚSQUEDA (que
  // conserva el buscador y ofrece limpiar). La acción primaria va SIEMPRE con texto — y desde
  // reservations#47 eso lo cumple la propia tabla: outfitkit#113 rotula `addable` también en
  // escritorio, donde antes era un «+» de 36 px, el cuarto de cuatro iconos iguales.
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

    // Solo para el vacío de primera vez: ahí la barra de la tabla no se ve (la tabla se aparta),
    // así que la acción primaria la pone el propio bloque vacío. Con filas, el alta la pinta la
    // tabla (`addable`).
    const createButton = () => html`
      <ion-button slot="action" size="small" data-action="create" data-testid="reservations-create" @click=${() => this.openCreate()}
        >${t('ui.emptyCta')}</ion-button
      >
    `;

    return html`<div class="page">
        ${this.renderDayBar()}
        ${this.formError ? html`<p class="err" data-testid="reservations-form-error">${this.formError}</p>` : nothing}
        ${error
          ? html`<div class="state" data-state="error" data-testid="reservations-load-error">
              <p class="err">${error}</p>
              <ion-button size="small" data-action="retry" data-testid="reservations-retry" @click=${() => void this.ctrl.load()}>${t('ui.btnRetry')}</ion-button>
            </div>`
          : nothing}
        ${showLoading
          ? html`<div class="state" data-state="loading" data-testid="reservations-loading">
              <ion-spinner></ion-spinner>
              <p>${t('ui.loading')}</p>
            </div>`
          : nothing}
        ${firstRun
          ? html`<ok-empty-state
              class="state"
              data-empty="first-run"
              data-testid="reservations-empty"
              icon="calendar-outline"
              .heading=${t('ui.emptyDayTitle')}
              .message=${t('ui.emptyBody')}
            >
              <p class="hint">${t('ui.emptyHint')}</p>
              ${createButton()}
            </ok-empty-state>`
          : nothing}
        <ok-data-table testid="reservations-table" ?hidden=${hideTable} @click=${this.syncPanel} .serverSide=${true} .fill=${true} .addable=${true} .labels=${this.tableLabels} .views=${true} .cardTitle=${(row: Record<string, unknown>) => String(row.guest_name ?? row.id ?? '—')} .columns=${this.columns} .rows=${this.ctrl?.rows ?? []} .total=${this.ctrl?.total ?? 0} .page=${this.ctrl?.state.page ?? 0} .pageSize=${this.ctrl?.state.pageSize ?? 50} .sort=${this.ctrl?.state.sort} .sortDir=${this.ctrl?.state.dir ?? 'asc'} .searchable=${true} .search=${this.ctrl?.state.search ?? ''} .filterValues=${this.filterMirror} .searchPlaceholder=${t('ui.searchPlaceholder')} .actions=${this.actions} .emptyMessage=${loading ? t('ui.loading') : this.hasQuery ? t('ui.noResultsTitle') : t('ui.emptyDayTitle')} @rowAction=${(e: CustomEvent) => this.onRowAction(e)} @pageChange=${(e: CustomEvent<number>) => this.ctrl.setPage(e.detail)} @pageSizeChange=${(e: CustomEvent<number>) => this.ctrl.setPageSize(e.detail)} @sortChange=${(e: CustomEvent<{ sort: string; dir: 'asc' | 'desc' }>) => this.ctrl.setSort(e.detail.sort, e.detail.dir)} @searchChange=${(e: CustomEvent<string>) => this.onSearch(e.detail)} @filterChange=${(e: CustomEvent<{ col: string; value: unknown }>) => this.ctrl.setFilter(e.detail.col, e.detail.value)}>
          <!-- Alta de reserva: se proyecta SIEMPRE (aunque el panel esté cerrado); si se renderizara
               solo con el panel abierto, la acción primaria abriría un panel vacío. -->
          <form slot="create" class="form" data-testid="reservations-form" @submit=${(e: Event) => this.createReservation(e)}>
            <ion-input label-placement="floating" label=${t('ui.phGuestName')} data-testid="reservations-guest-name" .value=${this.newName} @ionInput=${(e: any) => (this.newName = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.phGuestPhone')} data-testid="reservations-guest-phone" .value=${this.newPhone} @ionInput=${(e: any) => (this.newPhone = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.colDate')} type="date" data-testid="reservations-date" .value=${this.newDate} @ionInput=${(e: any) => (this.newDate = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.colTime')} type="time" data-testid="reservations-time" .value=${this.newTime} @ionInput=${(e: any) => (this.newTime = e.target.value)}></ion-input>
            <ion-input label-placement="floating" label=${t('ui.phPartySize')} type="number" min="1" data-testid="reservations-party-size" .value=${this.newParty} @ionInput=${(e: any) => (this.newParty = e.target.value)}></ion-input>
            <ion-button type="submit" data-testid="reservations-submit" ?disabled=${this.saving || !this.newName || !this.newDate || !this.newTime}>${this.saving ? t('ui.btnSaving') : t('ui.btnReserve')}</ion-button>
          </form>
        </ok-data-table>
        ${noResults
          ? html`<div class="noresults" data-empty="no-results" data-testid="reservations-no-results">
              <p>${t('ui.noResultsBody')}</p>
              <ion-button size="small" fill="clear" data-action="clear-filters" data-testid="reservations-clear-filters" @click=${() => this.clearQuery()}>${t('ui.btnClearFilters')}</ion-button>
            </div>`
          : nothing}
      </div>`;
  }
}

define('erp-reservations-list', ErpReservationsList);
