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
  /** outfitkit#112 — la búsqueda que el módulo le IMPONE a la tabla (`undefined` = no la controla). */
  search?: string;
  /** outfitkit#106 — los filtros que el módulo le impone; una identidad nueva reasigna el espejo. */
  filterValues?: Record<string, unknown>;
  /** Nº de filtros que la tabla se cree puestos → el badge del embudo. */
  activeFilterCount: number;
  /** Lo que llama el panel de filtros de la tabla al elegir un valor (`onFilterInput`). */
  setServerFilter: (key: string, value: unknown) => void;
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

describe('3 · la acción primaria de la barra la pinta LA TABLA (`addable`)', () => {
  // POR QUÉ CAMBIÓ ESTE CONTRATO (reservations#47). En #41 la decisión de mercado —Odoo,
  // Business Central, WooCommerce Bookings, Lightspeed, Fresha y NN/g: la acción principal de un
  // listado se ROTULA— se cumplió aquí a mano, apagando `addable` y proyectando un botón propio
  // en el slot `toolbar`, porque en ESCRITORIO `addable` pintaba un «+» de 36 px indistinguible
  // de los otros tres iconos de la barra. outfitkit#113 lo arregló EN LA TABLA: `addable` pinta
  // el mismo botón rotulado y relleno en los dos viewports. La decisión de mercado NO cambia; lo
  // que cambia es quién la cumple. Mantener el botón a mano deja a Reservas fuera de cualquier
  // mejora futura de esa barra y le obliga a re-alinearlo cada vez que la tabla se mueve.
  it('la tabla declara `addable`: el alta la pinta ella, rotulada también en escritorio', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    expect(tabla(el)?.addable, 'el alta sigue sin salir de la tabla: `addable` apagado').toBe(true);
  });

  it('el módulo ya NO proyecta un botón de alta propio en la barra', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    expect(
      root(el).querySelector('[slot="toolbar"][data-action="create"]'),
      'sigue el botón de alta hecho a mano: dos altas que mantener y una que se desalinea',
    ).toBeNull();
  });

  it('el botón de alta de la tabla lleva TEXTO y abre el panel donde vive el formulario', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    const alta = tabla(el)!.shadowRoot!.querySelector('ion-button.add-btn') as HTMLElement | null;
    expect(alta, 'la tabla no pinta ningún botón de alta rotulado en la barra').toBeTruthy();
    // Y con el rótulo del MÓDULO: heredar el alta de la tabla no puede degradar «Nueva reserva» al
    // «Añadir» genérico de ok-data-table (misma decisión de mercado que reservations#41).
    expect(texto(alta), 'el alta de la barra perdió el rótulo propio: dice «Añadir»').toBe('ui.emptyCta');

    alta!.click();
    await settle(el);
    expect(tabla(el)?.panel, 'el alta de la barra no abre el panel `create`').toBe('create');
    expect(root(el).querySelector('form[slot="create"]'), 'el formulario de alta no está proyectado').toBeTruthy();
  });

  it('el rótulo del alta sigue al idioma activo (la memoización por idioma no se queda pegada)', async () => {
    page = { rows: [unaReserva], total: 1 };
    const erp = (globalThis as Record<string, unknown>).erplora as {
      locale: string;
      t: (c: unknown, k: string) => string;
    };
    // Doble consciente del idioma: así una etiqueta cacheada de más se ve como texto, no como
    // detalle interno. Con el catálogo real es la diferencia entre «Nueva reserva» y «New
    // reservation» en la barra de un hub que cambia de idioma sin recargar (ADR-0055).
    erp.t = (_c: unknown, k: string) => `${erp.locale}:${k}`;
    const el = await montar();
    const alta = () => tabla(el)!.shadowRoot!.querySelector('ion-button.add-btn');
    expect(texto(alta())).toBe('es:ui.emptyCta');

    erp.locale = 'en';
    window.dispatchEvent(new Event('erplora:locale-changed'));
    await settle(el);
    expect(texto(alta()), 'el alta se queda con el rótulo del idioma anterior').toBe('en:ui.emptyCta');
  });

  it('el vacío de primera vez sigue teniendo SU botón rotulado (la barra no se ve ahí)', async () => {
    const el = await montar();
    const cta = root(el).querySelector('ok-empty-state [data-action="create"]');
    expect(cta, 'el vacío de primera vez se queda sin acción primaria').toBeTruthy();
    expect(texto(cta)).toBe('ui.emptyCta');
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

// ── Review of PR #44 (rv-44): the blocks must not stack, and the table must not step aside while
// the person is USING it. Written red-first against the worker's implementation.
describe('6 · review #44: the blocks do not stack and the table stays while it is in use', () => {
  type TablaFull = Tabla & { emptyMessage: string; close: () => void };
  const tablaFull = (el: HTMLElement & { shadowRoot: ShadowRoot }) => tabla(el) as TablaFull;

  it('first run + create panel open: the table with its form is on screen, and the empty-state is NOT stacked above it', async () => {
    const el = await montar();
    (root(el).querySelector('[data-action="create"]') as HTMLElement).click();
    await settle(el);
    const t = tablaFull(el);
    expect(t.panel).toBe('create');
    expect(
      root(el).querySelector('[data-empty="first-run"]'),
      'the first-run empty-state is still painted above the table while the create panel is open',
    ).toBeNull();
    expect(t.hasAttribute('hidden'), 'the table is hidden while its create panel is open').toBe(false);
    expect(t.emptyMessage, 'the table says «no results match your search» without any search').toBe('ui.emptyTitle');
  });

  it('closing the create panel without saving brings the first-run empty-state back', async () => {
    const el = await montar();
    (root(el).querySelector('[data-action="create"]') as HTMLElement).click();
    await settle(el);
    const t = tablaFull(el);
    t.close(); // what the «X» / scrim do inside the table; the click that did it bubbles to the host
    t.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    await settle(el);
    expect(root(el).querySelector('[data-empty="first-run"]'), 'the first-run empty-state does not come back').toBeTruthy();
  });

  it('reloading with rows on screen neither hides the table nor stacks a loading block above it', async () => {
    page = { rows: [unaReserva], total: 1 };
    const el = await montar();
    pending = true;
    tabla(el)!.dispatchEvent(new CustomEvent('searchChange', { detail: 'a' }));
    await settle(el);
    expect(tabla(el)!.hasAttribute('hidden'), 'the table with rows is hidden while reloading').toBe(false);
    expect(root(el).querySelector('[data-state="loading"]'), 'a loading block is stacked above a table that has rows').toBeNull();
  });

  it('typing past «no results» keeps the table (and its searchbar focus): it is not hidden while the query is in flight', async () => {
    const el = await montar();
    tabla(el)!.dispatchEvent(new CustomEvent('searchChange', { detail: 'zzzz' }));
    await settle(el);
    expect(root(el).querySelector('[data-empty="no-results"]')).toBeTruthy();
    pending = true;
    tabla(el)!.dispatchEvent(new CustomEvent('searchChange', { detail: 'zzzzz' }));
    await settle(el);
    expect(tabla(el)!.hasAttribute('hidden'), 'the table goes display:none mid-query and the searchbar loses focus').toBe(false);
    expect(root(el).querySelector('[data-state="loading"]'), 'the loading block replaces the table the person is typing in').toBeNull();
  });

  // reservations#47 — «Limpiar» deshace la consulta por el CONTRATO de la tabla, no metiendo la
  // mano en su shadow root. Antes se le borraba el `value` al `ion-searchbar` desde fuera: seguía
  // funcionando, pero dejaba a la tabla creyendo que la búsqueda era «zzzz», y el día que outfitkit
  // renombrara ese nodo el buscador se quedaría escrito SIN QUE NADIE AVISARA (el `querySelector`
  // devuelve null y no falla). Y de los filtros no se ocupaba nadie.
  it('«Limpiar» le dice a la tabla que la búsqueda es vacía (outfitkit#112), no le borra el nodo', async () => {
    const el = await montar();
    const bar = tabla(el)!.shadowRoot!.querySelector('ion-searchbar') as (HTMLElement & { value?: string }) | null;
    expect(bar, 'la tabla no pinta ningún ion-searchbar').toBeTruthy();

    // Lo que hace la persona: TECLEAR. Así el buscador de la tabla —controlado desde #117— se
    // queda además con su propio estado interno en «zzzz», que es justo lo que el apaño no tocaba.
    bar!.value = 'zzzz';
    bar!.dispatchEvent(new CustomEvent('ionInput', { bubbles: true, composed: true }));
    await settle(el);
    expect(tabla(el)!.search, 'el módulo no le dice a la tabla qué búsqueda está viendo').toBe('zzzz');

    (root(el).querySelector('[data-action="clear-filters"]') as HTMLElement).click();
    await settle(el);
    expect(tabla(el)!.search, 'la tabla no recibe la búsqueda vacía: solo se le borró el nodo a mano').toBe('');
    expect(bar!.value, 'el texto sigue escrito en el buscador tras limpiar').toBe('');
  });

  it('«Limpiar» también deshace los filtros DE LA TABLA, no solo los del controlador', async () => {
    const el = await montar();
    // Exactamente lo que hace el panel de filtros de la tabla al elegir un estado: fija su espejo
    // y avisa (`onFilterInput` de ok-data-table).
    tabla(el)!.setServerFilter('status', 'confirmed');
    tabla(el)!.dispatchEvent(new CustomEvent('filterChange', { detail: { col: 'status', value: 'confirmed' } }));
    await settle(el);
    expect(tabla(el)!.activeFilterCount, 'el embudo de la tabla no cuenta el filtro puesto').toBe(1);

    (root(el).querySelector('[data-action="clear-filters"]') as HTMLElement).click();
    await settle(el);
    expect(
      tabla(el)!.activeFilterCount,
      'el embudo sigue marcando un filtro que la lista ya no aplica: la pantalla se contradice',
    ).toBe(0);
  });
});
