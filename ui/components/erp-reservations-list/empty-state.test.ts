// Contrato del ESTADO VACÍO y de la ACCIÓN PRIMARIA de la lista de reservas (reservations#41).
//
// Decisión de MERCADO (8 referencias + foros; la tabla va en el cuerpo de la PR). Un listado
// vacío no es una tabla gris: Odoo pinta el bloque `help` y mantiene rotulado el botón de alta
// del panel de control; Polaris (Shopify) exige cabecera + descripción + acción primaria;
// Business Central abre las listas vacías con un teaching tip y su acción «New» rotulada;
// WooCommerce Bookings, Lightspeed Restaurant y Fresha rotulan «Add booking» / «Add
// reservation» / «Add». Nadie deja la acción primaria como un icono suelto: NN/g reserva los
// botones sin rótulo para acciones universales (buscar, cerrar, reproducir).
//
// Lo que fija este fichero:
//  1. Vacío de PRIMERA VEZ (0 filas, sin búsqueda ni filtro): cabecera + explicación + botón
//     primario CON TEXTO que abre el alta.
//  2. Vacío por BÚSQUEDA/FILTRO: mensaje distinto y acción de limpiar. Un restaurante con 300
//     reservas que filtra mal no puede leer «todavía no tienes reservas».
//  3. La barra lleva la acción primaria ROTULADA, no el «+» anónimo de `addable`.
//  4. Cargando y error tienen su propio bloque visible (nada de pantalla muda).
//  5. Toda cadena nueva existe en `en` Y en `es` (ADR-0055) y ningún control de formulario
//     lleva `fill="outline"` (no-op en modo ios — ADR-0143).
//
// Los tests afirman sobre CLAVES i18n, nunca sobre la prosa: el doble de `t` devuelve la clave.
import { beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/** Raíz del módulo: `import.meta.url` no es una URL `file:` en este runner, así que se busca
 *  hacia arriba desde el cwd el directorio que tiene el `module.json`. */
function moduleRoot(): string {
  let dir = resolve(process.cwd());
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, 'module.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('no encuentro la raíz del módulo (module.json) desde ' + process.cwd());
}

const comandos: { name: string; payload: Record<string, unknown> }[] = [];

/** Página que devuelve el doble del servidor. Cada test la ajusta ANTES de montar. */
let page: { rows: Record<string, unknown>[]; total: number } = { rows: [], total: 0 };
/** Cuando es `true`, `queryPage` no resuelve nunca → el controlador se queda en `loading`. */
let pending = false;
/** Cuando trae texto, `queryPage` rechaza con ese mensaje → estado de error. */
let failWith = '';

const unaReserva = {
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
};

beforeEach(() => {
  comandos.length = 0;
  page = { rows: [], total: 0 };
  pending = false;
  failWith = '';
  document.body.innerHTML = '';
  (globalThis as Record<string, unknown>).erplora = {
    query: async () => [],
    queryPage: async () => {
      if (pending) return new Promise(() => {});
      if (failWith) throw new Error(failWith);
      return page;
    },
    command: async (name: string, payload: Record<string, unknown>) => {
      comandos.push({ name, payload });
      return {};
    },
    on: () => () => {},
    locale: 'es',
    t: (_catalog: unknown, key: string) => key,
  };
});

type Tabla = HTMLElement & {
  addable: boolean;
  panel: string;
  open: (p?: 'filters' | 'create') => void;
};

async function montar() {
  await import('./erp-reservations-list');
  const el = document.createElement('erp-reservations-list') as HTMLElement & { shadowRoot: ShadowRoot };
  document.body.appendChild(el);
  await settle(el);
  return el;
}

async function settle(el: HTMLElement) {
  const wc = el as unknown as { updateComplete: Promise<unknown> };
  await wc.updateComplete;
  await new Promise((r) => setTimeout(r, 0));
  await wc.updateComplete;
}

const root = (el: HTMLElement & { shadowRoot: ShadowRoot }) => el.shadowRoot;
const tabla = (el: HTMLElement & { shadowRoot: ShadowRoot }) =>
  root(el).querySelector('ok-data-table') as Tabla | null;
const texto = (n: Element | null) => (n?.textContent ?? '').trim();

describe('1 · el vacío de PRIMERA VEZ enseña y ofrece la acción (Odoo `help` + Polaris EmptyState)', () => {
  it('pinta cabecera, explicación y un botón primario CON TEXTO', async () => {
    const el = await montar();
    const vacio = root(el).querySelector('ok-empty-state[data-empty="first-run"]') as
      | (HTMLElement & { heading?: string; message?: string })
      | null;
    expect(vacio, 'sin bloque de vacío: la pantalla es una tabla gris sin salida').toBeTruthy();
    expect(vacio!.heading, 'el vacío no tiene cabecera').toBe('ui.emptyTitle');
    expect(vacio!.message, 'el vacío no explica qué es esto').toBe('ui.emptyBody');
    expect(texto(vacio!.querySelector('.hint')), 'el vacío no dice dónde se configuran los turnos').toBe(
      'ui.emptyHint',
    );

    const cta = vacio!.querySelector('[slot="action"][data-action="create"]');
    expect(cta, 'el vacío no ofrece la acción primaria').toBeTruthy();
    expect(texto(cta), 'la acción primaria del vacío no lleva TEXTO (es un icono)').toBe('ui.emptyCta');
  });

  it('el botón del vacío abre el panel de alta de la tabla (mismo alta, no un segundo formulario)', async () => {
    const el = await montar();
    const cta = root(el).querySelector('[data-action="create"]') as HTMLElement;
    cta.click();
    await settle(el);
    expect(tabla(el)?.panel, 'el botón del vacío no abre el panel `create`').toBe('create');
  });

  it('con reservas NO se pinta el vacío', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    expect(root(el).querySelector('[data-empty="first-run"]'), 'el vacío se pinta con filas').toBeNull();
  });
});

describe('2 · vacío por BÚSQUEDA/FILTRO ≠ vacío de primera vez', () => {
  it('con búsqueda activa pinta «sin resultados» y ofrece limpiar, no el alta de primera vez', async () => {
    const el = await montar();
    tabla(el)!.dispatchEvent(new CustomEvent('searchChange', { detail: 'zzzz' }));
    await settle(el);

    expect(
      root(el).querySelector('[data-empty="first-run"]'),
      'a quien filtra se le dice «todavía no tienes reservas»: miente',
    ).toBeNull();
    const sinRes = root(el).querySelector('[data-empty="no-results"]');
    expect(sinRes, 'no hay bloque de «sin resultados»').toBeTruthy();
    expect(texto(sinRes!.querySelector('[data-action="clear-filters"]'))).toBe('ui.btnClearFilters');
  });

  it('limpiar devuelve la búsqueda a vacío y vuelve el estado de primera vez', async () => {
    const el = await montar();
    tabla(el)!.dispatchEvent(new CustomEvent('searchChange', { detail: 'zzzz' }));
    await settle(el);
    (root(el).querySelector('[data-action="clear-filters"]') as HTMLElement).click();
    await settle(el);

    expect(root(el).querySelector('[data-empty="no-results"]')).toBeNull();
    expect(root(el).querySelector('[data-empty="first-run"]'), 'no vuelve el vacío de primera vez').toBeTruthy();
  });
});

describe('3 · la acción primaria de la barra va ROTULADA, no como «+» anónimo', () => {
  it('la tabla ya NO declara `addable` (el «+» era el cuarto icono de cuatro iguales)', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    expect(tabla(el)?.addable, 'sigue el «+» anónimo de `addable` en la barra').toBe(false);
  });

  it('la barra recibe un botón de alta CON TEXTO por el slot `toolbar`', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    const btn = root(el).querySelector('[slot="toolbar"][data-action="create"]');
    expect(btn, 'la barra no lleva acción primaria rotulada').toBeTruthy();
    expect(texto(btn), 'la acción primaria de la barra no lleva texto').toBe('ui.emptyCta');
    expect(btn!.closest('ok-data-table'), 'la acción primaria cuelga fuera de la tabla').toBeTruthy();
  });

  it('el botón de la barra abre el mismo panel de alta', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    (root(el).querySelector('[slot="toolbar"][data-action="create"]') as HTMLElement).click();
    await settle(el);
    expect(tabla(el)?.panel).toBe('create');
  });
});

describe('4 · cargando y error se PINTAN (nada de pantalla muda)', () => {
  it('mientras carga pinta el bloque de carga y no el vacío', async () => {
    pending = true;
    const el = await montar();
    expect(root(el).querySelector('[data-state="loading"]'), 'no hay bloque de carga').toBeTruthy();
    expect(
      root(el).querySelector('[data-empty="first-run"]'),
      'mientras carga ya dice que no hay reservas',
    ).toBeNull();
  });

  it('si la carga falla pinta el error y un reintento, y no el vacío', async () => {
    failWith = 'boom';
    const el = await montar();
    const err = root(el).querySelector('[data-state="error"]');
    expect(err, 'el fallo de carga es mudo').toBeTruthy();
    expect(texto(err!.querySelector('[data-action="retry"]'))).toBe('ui.btnRetry');
    expect(root(el).querySelector('[data-empty="first-run"]'), 'un fallo se pinta como «sin reservas»').toBeNull();
  });

  it('el reintento vuelve a pedir la página', async () => {
    failWith = 'boom';
    const el = await montar();
    failWith = '';
    page = { rows: [unaReserva], total: 1 };
    (root(el).querySelector('[data-action="retry"]') as HTMLElement).click();
    await settle(el);
    expect(root(el).querySelector('[data-state="error"]'), 'el error se queda tras reintentar con éxito').toBeNull();
  });
});

describe('5 · i18n y controles de formulario', () => {
  const cat = (lang: string) =>
    JSON.parse(readFileSync(join(moduleRoot(), 'locales', `${lang}.json`), 'utf8')) as {
      ui: Record<string, string>;
    };

  const NUEVAS = [
    'emptyTitle',
    'emptyBody',
    'emptyHint',
    'emptyCta',
    'noResultsTitle',
    'noResultsBody',
    'btnClearFilters',
    'btnRetry',
  ];

  it.each(NUEVAS)('la cadena `ui.%s` existe en `en` y en `es`', (key) => {
    for (const lang of ['en', 'es']) {
      const value = cat(lang).ui[key];
      expect(value, `falta ui.${key} en ${lang}.json`).toBeTruthy();
      expect(value.trim().length, `ui.${key} vacía en ${lang}.json`).toBeGreaterThan(0);
    }
  });

  it('el catálogo `es` no deja ninguna cadena `ui` sin traducir respecto de `en`', () => {
    const faltan = Object.keys(cat('en').ui).filter((k) => !cat('es').ui[k]);
    expect(faltan, 'cadenas sin traducción al español').toEqual([]);
  });

  it('ningún control de formulario lleva `fill="outline"` (no-op en modo ios, ADR-0143)', () => {
    const src = readFileSync(
      join(moduleRoot(), 'ui/components/erp-reservations-list/erp-reservations-list.ts'),
      'utf8',
    );
    const ofensores = src
      .split('\n')
      .map((linea, i) => ({ linea: linea.trim(), n: i + 1 }))
      .filter(
        ({ linea }) =>
          /<ion-(input|select|textarea)\b/.test(linea) && /fill=["']?outline/.test(linea),
      );
    expect(ofensores.map((o) => o.n), 'controles de formulario con fill="outline"').toEqual([]);
  });
});
