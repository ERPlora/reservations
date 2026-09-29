// Contrato de las DOS tablas de disponibilidad (franjas horarias y días bloqueados).
//
// Ojo con el nombre: esta vista NO es un buscador de huecos por fecha. Son dos CRUD: cada `<form>`
// da de alta UNA FILA de la tabla que tiene justo debajo (`reservations.timeslots.create` →
// tabla de franjas; `reservations.blocked_dates.create` → tabla de días bloqueados). Por eso cada
// alta vive DENTRO de SU tabla, detrás del «+» de su barra (panel `slot="create"`), igual que
// /employees del core y que el CRUD de productos de `inventory`.
//
// Como la vista apila DOS tablas, NO se usa `fill` (eso es para una tabla que llena el alto); las
// tablas mantienen su alto natural y la página scrollea. Los <h3> de cada sección se quedan: son
// los que nombran cada tabla. El <h2> de la vista no: ese título lo pinta el topbar del shell.
//
// Filtros: dentro de la tabla, y los de dominio cerrado con `select` (día de la semana 0..6, día
// completo sí/no). El servidor los soporta: `reservations.timeslots.list` declara
// `filters.day_of_week = { op: eq }` y `reservations.blocked_dates.list`
// `filters.is_full_day = { op: eq }` en sus bloques `list` del module.json.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ionTone } from '../../lib/ion-tone';

const comandos: { name: string; payload: Record<string, unknown> }[] = [];
const consultas: { name: string; params?: Record<string, unknown> }[] = [];

/** Una comida LLENA y una cena con hueco — lo que `reservations.slots.count_for` devuelve.
 * La primera es la fila que tiene que quedar marcada en claro (reservations#38). */
const OCUPACION = [
  { timeslot_id: 's-lunch', start_time: '13:00:00', end_time: '16:00:00', max_reservations: 2, reserved: 2, available: 0 },
  { timeslot_id: 's-dinner', start_time: '20:00:00', end_time: '23:30:00', max_reservations: 3, reserved: 1, available: 2 },
];

/** Today in UTC as YYYY-MM-DD: a hub that publishes no zone degrades to UTC, like the runtime
 * (`business-time.ts`), never to the device's zone (reservations#80). */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

beforeEach(() => {
  comandos.length = 0;
  consultas.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async (name: string, params?: Record<string, unknown>) => {
      consultas.push({ name, params });
      return name === 'reservations.slots.count_for' ? OCUPACION : [];
    },
    queryPage: async (name: string) =>
      name === 'reservations.timeslots.list'
        ? { rows: [{ id: 't1', day_of_week: 0, start_time: '13:00:00', end_time: '16:00:00', max_reservations: 10, is_active: 1 }], total: 1 }
        : { rows: [{ id: 'b1', date: '2026-12-25', reason: 'Navidad', is_full_day: true }], total: 1 },
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

async function montar() {
  await import('./erp-reservations-availability');
  const el = document.createElement('erp-reservations-availability');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as HTMLElement & { shadowRoot: ShadowRoot };
}

type Tabla = HTMLElement & { addable: boolean; panel: string; open: (p?: 'filters' | 'create') => void; id: string };
/** Desde reservations#38 la vista apila TRES tablas (ocupación + franjas + bloqueados): se busca
 * POR ID, nunca por posición. */
const tabla = (el: HTMLElement & { shadowRoot: ShadowRoot }, id: string): Tabla =>
  el.shadowRoot.querySelector(`ok-data-table#${id}`) as unknown as Tabla;

describe('cada alta vive DENTRO de SU tabla (paridad con /employees e inventory)', () => {
  it('las dos tablas de configuración declaran `addable` → cada una pinta su «+»', async () => {
    const el = await montar();
    expect(tabla(el, 'slots')?.addable, 'la tabla de franjas no tiene «+»').toBe(true);
    expect(tabla(el, 'blocked')?.addable, 'la tabla de días bloqueados no tiene «+»').toBe(true);
  });

  it('cada formulario se proyecta en el panel `create` de la tabla que le corresponde', async () => {
    const el = await montar();
    const franjas = tabla(el, 'slots');
    const bloqueados = tabla(el, 'blocked');
    const forms = [...el.shadowRoot.querySelectorAll('form[slot="create"]')];
    expect(forms.length, 'faltan formularios en los paneles `create` de las tablas').toBe(2);
    expect(forms[0].closest('ok-data-table'), 'el alta de franja no cuelga de la tabla de franjas').toBe(franjas);
    expect(forms[1].closest('ok-data-table'), 'el alta de día bloqueado no cuelga de su tabla').toBe(bloqueados);
  });

  it('no queda NINGÚN control de alta suelto fuera de las tablas', async () => {
    const el = await montar();
    const sueltos = [...el.shadowRoot.querySelectorAll('form, ion-input, ion-select, ion-button')].filter(
      (n) => !n.closest('ok-data-table'),
    );
    expect(sueltos.map((n) => n.tagName.toLowerCase()), 'hay controles de alta fuera de las tablas').toEqual([]);
  });

  it('la vista no pinta su propio título (lo pone el topbar), pero SÍ los rótulos de cada tabla', async () => {
    const el = await montar();
    expect(el.shadowRoot.querySelector('h2'), 'el título duplicado: ya lo pinta el topbar').toBeNull();
    // reservations#38 añadió la TERCERA tabla (ocupación): un rótulo por tabla.
    expect(el.shadowRoot.querySelectorAll('h3').length, 'sin rótulos no se sabe qué tabla es cuál').toBe(3);
  });
});

describe('los filtros de dominio cerrado son `select`', () => {
  it('el día de la semana se filtra con un select de los 7 días', async () => {
    const el = await montar();
    const cols = (el as unknown as { slotColumns: { key: string; filterType?: string; options?: unknown[] }[] }).slotColumns;
    const dia = cols.find((c) => c.key === 'day_of_week');
    expect(dia?.filterType).toBe('select');
    expect(dia?.options?.length).toBe(7);
  });

  it('«día completo» se filtra con un select sí/no', async () => {
    const el = await montar();
    const cols = (el as unknown as { blockColumns: { key: string; filterType?: string; options?: { value: string }[] }[] }).blockColumns;
    const full = cols.find((c) => c.key === 'is_full_day');
    expect(full?.filterType).toBe('select');
    // reservations#54: la query responde este flag como booleano JSON y el motor de listas compara
    // el filtro como TEXTO (`CAST(sub.<col> AS TEXT) = CAST(:f_<col> AS TEXT)`), donde un booleano
    // se escribe `'true'`/`'false'`. Este test pedía `['1', '0']`, que era el dominio correcto
    // mientras la columna salía como INTEGER cruda; con la proyección de hoy no casaría ninguna
    // fila y la tabla saldría vacía en vez de filtrada (hub#1182). Lo comprueba contra un Postgres
    // real tests/flag_round_trip.pg.test.py, capa 3.
    expect(full?.options?.map((o) => o.value)).toEqual(['true', 'false']);
  });
});

describe('las altas siguen funcionando desde sus paneles', () => {
  it('crear una franja manda reservations.timeslots.create y CIERRA el panel de SU tabla', async () => {
    const el = await montar();
    const franjas = tabla(el, 'slots');
    franjas.open('create');
    const wc = el as unknown as { slotDay: string; slotStart: string; slotEnd: string; slotMax: string; createSlot: (ev: Event) => Promise<void> };
    wc.slotDay = '2';
    wc.slotStart = '13:00';
    wc.slotEnd = '16:00';
    wc.slotMax = '12';
    await wc.createSlot(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'reservations.timeslots.create');
    expect(alta, 'no se mandó el alta de la franja').toBeTruthy();
    expect(alta!.payload.day_of_week).toBe(2);
    expect(alta!.payload.start_time).toBe('13:00:00');
    expect(alta!.payload.max_reservations).toBe(12);
    expect(franjas.panel, 'el panel de alta de franjas se queda abierto tras crear').toBe('none');
  });

  it('bloquear una fecha manda reservations.blocked_dates.create y CIERRA el panel de SU tabla', async () => {
    const el = await montar();
    const bloqueados = tabla(el, 'blocked');
    bloqueados.open('create');
    const wc = el as unknown as { blockDate: string; blockReason: string; createBlocked: (ev: Event) => Promise<void> };
    wc.blockDate = '2026-12-25';
    wc.blockReason = 'Navidad';
    await wc.createBlocked(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'reservations.blocked_dates.create');
    expect(alta, 'no se mandó el bloqueo de la fecha').toBeTruthy();
    expect(alta!.payload.date).toBe('2026-12-25');
    expect(alta!.payload.reason).toBe('Navidad');
    expect(bloqueados.panel, 'el panel de alta de días bloqueados se queda abierto tras crear').toBe('none');
  });
});

// ── reservations#38: la tabla de ocupación — «¿cuánto queda esta noche?» ────────────────────
//
// La pestaña solo pintaba CONFIGURACIÓN (franjas y bloqueos); nadie contestaba la pregunta del
// jefe de sala. La query existía desde #4 (`reservations.slots.count_for`, cuenta EXACTAMENTE lo
// que cuenta el gate anti-overbooking) pero nadie la pintaba. La ocupación es lo PRIMERO de la
// pestaña, para una fecha elegible con default HOY; la fila agotada se marca en claro («Lleno» +
// atenuada), patrón de mercado (OpenTable/Resy muestran el slot lleno visible y no accionable,
// nunca lo esconden). Se reutiliza el datatable del módulo (ADR-0133), no un componente nuevo.
describe('ocupación: ¿cuánto queda esta noche? (reservations#38)', () => {
  it('la tabla de ocupación es lo PRIMERO de la pestaña y pregunta por HOY sin tocar nada', async () => {
    const el = await montar();
    const primera = el.shadowRoot.querySelector('ok-data-table');
    expect(primera?.id, 'la ocupación va delante de la configuración: es la pregunta de cada noche').toBe('occupancy');
    const q = consultas.find((c) => c.name === 'reservations.slots.count_for');
    expect(q, 'nadie llamó a reservations.slots.count_for al montar').toBeTruthy();
    expect(q!.params?.date, 'la fecha por defecto es HOY (del negocio; sin zona, UTC)').toBe(todayUtc());
  });

  it('una fila por franja: rango legible, reservadas, máximo y disponibles', async () => {
    const el = await montar();
    const occ = tabla(el, 'occupancy') as unknown as {
      rows: Record<string, unknown>[];
      columns: { key: string; header: string; align?: string }[];
    };
    expect(occ.rows.length, 'deben pintarse las franjas del día').toBe(2);
    expect(occ.columns.map((c) => c.key)).toEqual(['slot', 'reserved', 'max', 'available']);
    const texto = tabla(el, 'occupancy').shadowRoot?.textContent ?? '';
    expect(texto, 'la franja se lee como rango sin segundos').toContain('13:00–16:00');
    expect(texto, 'la cena con hueco enseña sus plazas libres').toContain('2');
  });

  it('la fila agotada queda marcada en claro: «Lleno» y atenuada, nunca escondida', async () => {
    const el = await montar();
    const texto = tabla(el, 'occupancy').shadowRoot?.textContent ?? '';
    expect(texto, 'el slot lleno debe verse LLENO (marcado), no desaparecer').toContain('ui.full');
    // La atenuación: las celdas de la fila llena se envuelven con opacidad reducida.
    const celdas = tabla(el, 'occupancy').shadowRoot?.querySelectorAll('span[style*="opacity"]') ?? [];
    expect(celdas.length, 'la fila llena debe quedar atenuada').toBeGreaterThan(0);
  });

  // pm#392: `color="danger"` paints nothing here — the cell lives in ok-data-table's shadow root,
  // out of reach of Ionic's global `.ion-color-*` rule — so the badge came out white on white.
  it('the «Full» badge carries the solid danger tone inline, not color=', async () => {
    const el = await montar();
    const badge = tabla(el, 'occupancy').shadowRoot?.querySelector('ion-badge');
    expect(badge, 'the sold-out slot shows its «Full» badge').toBeTruthy();
    expect(badge!.hasAttribute('color')).toBe(false);
    expect(badge!.getAttribute('style') ?? '').toContain(ionTone('solid', 'danger'));
  });

  it('cambiar la fecha vuelve a preguntar por la nueva fecha', async () => {
    const el = await montar();
    const wc = el as unknown as { occDate: string; loadOccupancy: () => Promise<void> };
    wc.occDate = '2026-12-25';
    await wc.loadOccupancy();
    const ultima = consultas.filter((c) => c.name === 'reservations.slots.count_for').pop();
    expect(ultima?.params?.date, 'la re-consulta usa la fecha elegida').toBe('2026-12-25');
  });

  it('la vista se refresca cuando cambia una reserva (la ocupación es viva durante el servicio)', async () => {
    const el = await montar();
    const antes = consultas.filter((c) => c.name === 'reservations.slots.count_for').length;
    const wc = el as unknown as { loadOccupancy: () => Promise<void> };
    await wc.loadOccupancy();
    expect(consultas.filter((c) => c.name === 'reservations.slots.count_for').length).toBe(antes + 1);
  });

  it('las cadenas nuevas van traducidas en+es (ADR-0055: nada hardcodeado)', async () => {
    const ROOT = join(__dirname, '../../..');
    const en = JSON.parse(readFileSync(join(ROOT, 'locales/en.json'), 'utf8'));
    const es = JSON.parse(readFileSync(join(ROOT, 'locales/es.json'), 'utf8'));
    for (const key of ['sectionOccupancy', 'colSlot', 'colReserved', 'colAvailable', 'full', 'emptyOccupancy']) {
      expect(en.ui?.[key], `falta la cadena en para ui.${key}`).toBeTruthy();
      expect(es.ui?.[key], `falta la cadena es para ui.${key}`).toBeTruthy();
    }
    expect(es.ui.full, '«Lleno» es la palabra de sala').toBe('Lleno');
  });

  it('la fecha se elige desde la BARRA de la tabla de ocupación (táctil, dentro de la tabla)', async () => {
    const el = await montar();
    const input = el.shadowRoot.querySelector('ok-data-table#occupancy [slot="toolbar"] ion-input[type="date"]');
    expect(input, 'el selector de fecha vive en la toolbar de la tabla de ocupación').toBeTruthy();
    expect((input as HTMLElement).closest('ok-data-table')?.id).toBe('occupancy');
  });
});

// reservations#80: «tonight» is the RESTAURANT's tonight. The occupancy opened on the DEVICE's
// today (`new Date().getDate()`), so a tablet left on another zone showed another day's room.
// The authority is the core's `erplora.timezone` (hub#731/hub#1022), the same `todayISO()` the
// book already opens on (reservations#45). The device zone is forced to differ from the business.
describe('occupancy opens on the restaurant today, not the device one (reservations#80)', () => {
  const previousTZ = process.env.TZ;

  afterEach(() => {
    vi.useRealTimers();
    process.env.TZ = previousTZ;
  });

  async function occupancyDateAt(now: string, deviceZone: string, businessZone: string): Promise<unknown> {
    process.env.TZ = deviceZone;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(now));
    (globalThis as { erplora: Record<string, unknown> }).erplora.timezone = businessZone;
    const el = await montar();
    const q = consultas.find((c) => c.name === 'reservations.slots.count_for');
    const input = el.shadowRoot.querySelector('[data-testid="reservations-availability-occupancy-date"]') as unknown as { value: string } | null;
    expect(input?.value, 'the date field does not show the day being asked about').toBe(q?.params?.date);
    return q?.params?.date;
  }

  it('a device already on tomorrow (Auckland) still asks about today in Madrid', async () => {
    // 18:10 in Madrid on the 25th = 05:10 on the 26th in Auckland.
    expect(await occupancyDateAt('2026-09-25T16:10:00Z', 'Pacific/Auckland', 'Europe/Madrid')).toBe('2026-09-25');
  });

  it('a device still on yesterday (Canarias) past midnight in Madrid asks about the new day', async () => {
    // 00:30 in Madrid on the 26th = 23:30 on the 25th in Canarias.
    expect(await occupancyDateAt('2026-09-25T22:30:00Z', 'Atlantic/Canary', 'Europe/Madrid')).toBe('2026-09-26');
  });

  it('the zone is the one the hub publishes, whatever it is: a Canarias restaurant on a Madrid device', async () => {
    // 23:30 in Canarias on the 25th = 00:30 on the 26th in Madrid.
    expect(await occupancyDateAt('2026-09-25T22:30:00Z', 'Europe/Madrid', 'Atlantic/Canary')).toBe('2026-09-25');
  });
});
