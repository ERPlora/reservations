// Contrato de la BARRA de la lista de reservas.
//
// El alta de una reserva vive DENTRO de `ok-data-table`, detrás del «+» de su barra (panel
// `slot="create"`), igual que /employees del core y que el CRUD de productos de `inventory`.
// Fuera de la tabla no puede quedar NINGÚN control de alta suelto, y el título de la vista lo
// pinta el topbar del shell (aquí no hay <h2>).
//
// Los filtros van dentro de la tabla (embudo) y el estado de la reserva —dominio cerrado
// (pending|confirmed|seated|completed|cancelled|no_show)— se filtra con un `select`, no
// tecleando texto libre. El servidor lo soporta: `reservations.reservations.list` declara
// `filters.status = { op: eq }` en su bloque `list` del module.json.
import { beforeEach, describe, expect, it } from 'vitest';

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

beforeEach(() => {
  comandos.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({
      rows: [
        {
          id: 'r1',
          guest_name: 'Ana',
          guest_phone: '600',
          guest_email: '',
          date: '2026-07-13',
          time: '20:00:00',
          party_size: 2,
          duration_minutes: 120,
          table_id: null,
          status: 'pending',
          notes: '',
        },
      ],
      total: 1,
    }),
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
  await import('./erp-reservations-list');
  const el = document.createElement('erp-reservations-list');
  document.body.appendChild(el);
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete;
  return el as HTMLElement & { shadowRoot: ShadowRoot };
}

type Tabla = HTMLElement & { addable: boolean; fill: boolean; panel: string; open: (p?: 'filters' | 'create') => void };
const tabla = (el: HTMLElement & { shadowRoot: ShadowRoot }) => el.shadowRoot.querySelector('ok-data-table') as Tabla | null;

describe('el alta vive DENTRO de la tabla (paridad con /employees e inventory)', () => {
  it('la tabla declara `addable` → pinta el «+» en su barra', async () => {
    const el = await montar();
    expect(tabla(el)?.addable, 'sin `addable` no hay «+» en la barra de la tabla').toBe(true);
  });

  it('la tabla llena el alto de la vista (`fill`)', async () => {
    const el = await montar();
    expect(tabla(el)?.fill, 'sin `fill` la tabla no ocupa el alto: sin scroll interno ni pie fijo').toBe(true);
  });

  it('el formulario de alta se proyecta en el panel `create` de la tabla', async () => {
    const el = await montar();
    const form = el.shadowRoot.querySelector('form[slot="create"]');
    expect(form, 'el formulario de alta no está en el slot `create`').toBeTruthy();
    expect(form?.closest('ok-data-table'), 'el formulario de alta cuelga fuera de la tabla').toBeTruthy();
  });

  it('no queda NINGÚN control de alta suelto fuera de la tabla', async () => {
    const el = await montar();
    const sueltos = [...el.shadowRoot.querySelectorAll('form, ion-input, ion-select, ion-button')].filter(
      (n) => !n.closest('ok-data-table'),
    );
    expect(sueltos.map((n) => n.tagName.toLowerCase()), 'hay controles de alta fuera de la tabla').toEqual([]);
  });

  it('la vista no pinta su propio título (lo pone el topbar del shell)', async () => {
    const el = await montar();
    expect(el.shadowRoot.querySelector('h2'), 'el título duplicado: ya lo pinta el topbar').toBeNull();
  });
});

describe('los filtros van en la tabla, y el estado (dominio cerrado) es un `select`', () => {
  it('el estado se filtra con un select con los 6 estados de la máquina', async () => {
    const el = await montar();
    const cols = (el as unknown as { columns: { key: string; filterType?: string; options?: { value: string }[] }[] }).columns;
    const estado = cols.find((c) => c.key === 'status');
    expect(estado?.filterType, 'el estado se filtra tecleando texto libre').toBe('select');
    expect(estado?.options?.map((o) => o.value)).toEqual([
      'pending',
      'confirmed',
      'seated',
      'completed',
      'cancelled',
      'no_show',
    ]);
  });
});

describe('el alta sigue funcionando desde el panel', () => {
  it('crear una reserva manda reservations.reservations.create y CIERRA el panel', async () => {
    const el = await montar();
    tabla(el)?.open('create');
    const wc = el as unknown as {
      newName: string;
      newPhone: string;
      newDate: string;
      newTime: string;
      newParty: string;
      createReservation: (ev: Event) => Promise<void>;
    };
    wc.newName = 'Ana';
    wc.newPhone = '600123123';
    wc.newDate = '2026-07-13';
    wc.newTime = '20:00';
    wc.newParty = '4';
    await wc.createReservation(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'reservations.reservations.create');
    expect(alta, 'no se mandó el alta de la reserva').toBeTruthy();
    expect(alta!.payload.guest_name).toBe('Ana');
    expect(alta!.payload.date).toBe('2026-07-13');
    expect(alta!.payload.time).toBe('20:00:00');
    expect(alta!.payload.party_size).toBe(4);
    expect(tabla(el)?.panel, 'el panel de alta se queda abierto tras crear').toBe('none');
  });
});

// ── reservations#34: la lista pinta fecha y hora como las lee un humano ─────────────────────
//
// Las columnas venían crudas de la query: la fecha en ISO («2026-07-13») y la hora con
// segundos («20:00:00»). El resto del hub formatea con Intl según el idioma activo
// (appointments: `fmtTime`); aquí es hora de pared guardada como texto, así que se parsea
// como local (sin Z) para que el día pintado sea el día guardado.
describe('la fecha y la hora se pintan con Intl, no en ISO crudo', () => {
  type Col = { key: string; format?: (r: Record<string, unknown>) => unknown };
  const cols = async (): Promise<Col[]> =>
    ((await montar()) as unknown as { columns: Col[] }).columns;

  it('la fecha ISO se pinta en el formato del idioma activo', async () => {
    const date = (await cols()).find((c) => c.key === 'date');
    expect(date?.format, 'la columna date no tiene format').toBeTruthy();
    expect(date!.format({ date: '2026-07-13' })).toBe('13/7/2026');
  });

  it('la hora pierde los segundos', async () => {
    const time = (await cols()).find((c) => c.key === 'time');
    expect(time?.format, 'la columna time no tiene format').toBeTruthy();
    expect(time!.format({ time: '20:00:00' })).toBe('20:00');
  });

  it('un valor que no es hora/fecha se pinta tal cual (fila corrupta, no pantalla rota)', async () => {
    const colsNow = await cols();
    const date = colsNow.find((c) => c.key === 'date')!;
    const time = colsNow.find((c) => c.key === 'time')!;
    expect(date.format({ date: '' })).toBe('');
    expect(time.format({ time: 'garbage' })).toBe('garbage');
  });
});
