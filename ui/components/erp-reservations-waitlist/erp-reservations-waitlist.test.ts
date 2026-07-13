// Contrato de la BARRA de la lista de espera.
//
// El alta de una entrada de la lista de espera vive DENTRO de `ok-data-table`, detrás del «+» de
// su barra (panel `slot="create"`), igual que /employees del core y que el CRUD de productos de
// `inventory`. Fuera de la tabla no queda ningún control de alta suelto, y el título lo pinta el
// topbar del shell.
//
// Los filtros van dentro de la tabla (embudo) y «contactado» —dominio cerrado (0|1)— se filtra con
// un `select`. El servidor lo soporta: `reservations.waitlist.list` declara
// `filters.is_contacted = { op: eq }` en su bloque `list` del module.json.
import { beforeEach, describe, expect, it } from 'vitest';

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

beforeEach(() => {
  comandos.length = 0;
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => ({
      rows: [
        {
          id: 'w1',
          guest_name: 'Luis',
          guest_phone: '600',
          date: '2026-07-13',
          preferred_time: '21:00:00',
          party_size: 2,
          is_contacted: 0,
          is_converted: 0,
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
  await import('./erp-reservations-waitlist');
  const el = document.createElement('erp-reservations-waitlist');
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

describe('los filtros van en la tabla, y «contactado» (dominio cerrado) es un `select`', () => {
  it('contactado se filtra con un select sí/no, no con texto libre', async () => {
    const el = await montar();
    const cols = (el as unknown as { columns: { key: string; filterType?: string; options?: { value: string }[] }[] }).columns;
    const contactado = cols.find((c) => c.key === 'is_contacted');
    expect(contactado?.filterType).toBe('select');
    expect(contactado?.options?.map((o) => o.value)).toEqual(['1', '0']);
  });
});

describe('el alta sigue funcionando desde el panel', () => {
  it('crear una entrada manda reservations.waitlist.create y CIERRA el panel', async () => {
    const el = await montar();
    tabla(el)?.open('create');
    const wc = el as unknown as {
      newName: string;
      newPhone: string;
      newDate: string;
      newTime: string;
      newParty: string;
      createEntry: (ev: Event) => Promise<void>;
    };
    wc.newName = 'Luis';
    wc.newPhone = '600123123';
    wc.newDate = '2026-07-13';
    wc.newTime = '21:00';
    wc.newParty = '3';
    await wc.createEntry(new Event('submit'));

    const alta = comandos.find((c) => c.name === 'reservations.waitlist.create');
    expect(alta, 'no se mandó el alta en la lista de espera').toBeTruthy();
    expect(alta!.payload.guest_name).toBe('Luis');
    expect(alta!.payload.preferred_time).toBe('21:00:00');
    expect(alta!.payload.party_size).toBe(3);
    expect(tabla(el)?.panel, 'el panel de alta se queda abierto tras crear').toBe('none');
  });
});
