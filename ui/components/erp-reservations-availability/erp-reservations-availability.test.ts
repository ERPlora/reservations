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
import { beforeEach, describe, expect, it } from 'vitest';

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

beforeEach(() => {
  comandos.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async (name: string) =>
      name === 'reservations.timeslots.list'
        ? { rows: [{ id: 't1', day_of_week: 0, start_time: '13:00:00', end_time: '16:00:00', max_reservations: 10, is_active: 1 }], total: 1 }
        : { rows: [{ id: 'b1', date: '2026-12-25', reason: 'Navidad', is_full_day: 1 }], total: 1 },
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

type Tabla = HTMLElement & { addable: boolean; panel: string; open: (p?: 'filters' | 'create') => void };
const tablas = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  [...el.shadowRoot.querySelectorAll('ok-data-table')] as unknown as Tabla[];

describe('cada alta vive DENTRO de SU tabla (paridad con /employees e inventory)', () => {
  it('las dos tablas declaran `addable` → cada una pinta su «+»', async () => {
    const el = await montar();
    const [franjas, bloqueados] = tablas(el);
    expect(franjas?.addable, 'la tabla de franjas no tiene «+»').toBe(true);
    expect(bloqueados?.addable, 'la tabla de días bloqueados no tiene «+»').toBe(true);
  });

  it('cada formulario se proyecta en el panel `create` de la tabla que le corresponde', async () => {
    const el = await montar();
    const [franjas, bloqueados] = tablas(el);
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
    expect(el.shadowRoot.querySelectorAll('h3').length, 'sin rótulos no se sabe qué tabla es cuál').toBe(2);
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
    expect(full?.options?.map((o) => o.value)).toEqual(['1', '0']);
  });
});

describe('las altas siguen funcionando desde sus paneles', () => {
  it('crear una franja manda reservations.timeslots.create y CIERRA el panel de SU tabla', async () => {
    const el = await montar();
    const [franjas] = tablas(el);
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
    const [, bloqueados] = tablas(el);
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
