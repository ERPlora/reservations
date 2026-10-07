# WORKFLOW — Reservas

Prefijo: RESERVATIONS
Alcance MVP: restaurante

> Contrato de comportamiento del módulo (pm#620, pm#621). Se lee antes de tocar el código y se
> actualiza en la misma PR que cambie un comportamiento. El detalle técnico vive en
> `architecture/modules/reservations.md`; aquí se escribe lo que ve y hace la persona.

## Para qué sirve y para quién

Reservas es el libro de reservas del restaurante o del bar: decide cuándo y para cuántos se acepta
reservar (franjas horarias con un máximo de reservas y días bloqueados), apunta cada reserva y la
lleva de Pendiente a Completada, y guarda en una lista de espera a quien no cabe. Lo usan el
**responsable** de sala (configura, confirma, sienta, cancela), el **empleado** que coge el teléfono o
atiende la puerta (consulta y apunta reservas) y, sin nadie delante, el **cliente** que pide mesa por
WhatsApp. No es la agenda de citas de una peluquería (eso es Citas) ni el plano de sala (eso es Mesas).

## Referencia adoptada

Contrastada en `.claude/agents/qa-hub-restaurant.md` §2 (10/08/2026); se adopta esto, no más:

- [OpenTable — gestión de sala](https://www.opentable.com/restaurant-solutions/products/table-management/):
  libro por servicio, turnos con aforo, lista de espera, asignación de mesa y estado de la mesa que
  sigue a la reserva. De OpenTable/Resy se copia también la franja agotada **visible y atenuada**, no
  escondida.
- [Toast — mensajes al comensal](https://support.toasttab.com/en/article/Text-messages-guests-can-receive-from-Toast):
  el comensal se entera por mensaje de que su reserva está hecha o confirmada.
- [Square — planos de sala](https://squareup.com/help/us/en/article/6427-building-your-floor-plan):
  comensales (cubiertos) por servicio y ocupación.
- [Meta — coexistencia con la app](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/):
  la reserva por WhatsApp sin cambiar de número.
- Ciclo de vida de la reserva del mercado: pendiente → confirmada → sentada → completada, más
  cancelada y no presentada; no se vuelve atrás.

## Antes de empezar

- Al instalar Reservas se instalan con él **Mesas** y **Clientes**.
- **Franjas**: sin una franja activa para ese día de la semana no se puede reservar nada. Es la causa
  número uno de «no hay disponibilidad».
- **Reglas** (sin pantalla propia hoy, ver RESERVATIONS-F03): de fábrica se aceptan grupos de 1 a 20,
  con al menos 1 hora de antelación y hasta 30 días vista, la reserva dura 120 minutos, nace
  Pendiente y una pendiente se libera 15 minutos después de su hora. El teléfono no es obligatorio
  mientras el restaurante no haya guardado ningún ajuste; el primer guardado (también el
  interruptor de WhatsApp) lo vuelve obligatorio. Cambiar la duración por defecto solo afecta a las
  reservas convertidas desde la lista de espera: a mano o por WhatsApp duran siempre 120 minutos.

Configuración inicial, paso a paso:

1. Abre **Reservas → Disponibilidad**, sección **Franjas horarias**, y crea las franjas de cada día
   de servicio (RESERVATIONS-F01).
2. En **Fechas bloqueadas**, añade los cierres y festivos que ya conozcas (RESERVATIONS-F02).
3. Si quieres otras reglas (grupos, antelación, teléfono obligatorio), cámbialas con el asistente
   (RESERVATIONS-F03); si usas WhatsApp, elige allí si las reservas se confirman solas
   (RESERVATIONS-F04).
4. Crea una reserva de prueba y comprueba en **Disponibilidad → Ocupación** que su franja baja en uno.

Para reservar por WhatsApp, el camino entero de punta a punta está en el recorrido `REC_WA_MESA`
(`architecture/workflows/whatsapp-mesa.md`).

## Pantallas

### Reservas
Menú **Reservas → Reservas**. Arriba, la **barra del día**: «Día anterior», la fecha (se escribe
dd/mm/aaaa), «Día siguiente» y «Hoy» cuando se está en otro día; el día en letra; y tres cifras:
**cubiertos** (personas que vienen, sin canceladas ni no-show), **reservas** y **próxima franja**
(la primera que no ha terminado, con cuántas quedan «libres» o «Lleno»; o «No queda servicio hoy»,
«Sin servicio este día», «Cerrado este día»). Debajo, la tabla del día ordenada por hora: Fecha,
Hora, Cliente, Teléfono, Pax, Estado; buscador «Buscar cliente, teléfono o fecha…» que busca por
nombre, teléfono o correo en **todo** el libro (resultados por día y hora; una fecha escrita ahí
no encuentra nada); filtros; vista tabla o tarjetas. Acción principal
«Nueva reserva» (abre el panel lateral con el formulario) y, por fila, «Confirmar», «Sentar»,
«Completar» y «Cancelar». «Hoy» es el del reloj del negocio, no el del dispositivo.
Vacía: «No hay reservas este día» con explicación y «Nueva reserva». Buscando sin resultados:
«Ninguna reserva coincide con la búsqueda» y «Limpiar filtros». Cargando: spinner «Cargando…» y
esqueleto en las cifras. Error: el mensaje y «Reintentar»; un fallo de una acción de fila sale
encima de la tabla y uno del formulario, dentro del formulario.

### Lista de espera
Menú **Reservas → Lista de espera**. Tabla: Fecha, Hora pref., Cliente, Teléfono, Pax, Contactado;
buscador y filtros. Acción principal «Añadir cliente» (panel con Cliente, Teléfono, Fecha, Hora, Pax
y «Añadir a la lista de espera»); por fila «Contactado», «Convertir» y «Quitar». Vacía: «Lista de
espera vacía.». Cargando: «Cargando…». Error: el mensaje de la tabla con reintento.

### Disponibilidad
Menú **Reservas → Disponibilidad**. Tres secciones apiladas:
- **Ocupación**: una fecha (hoy por defecto) y, por franja activa de ese día, Franja, Reservadas,
  Máx y Disponibles; la franja sin hueco se ve atenuada con la marca «Lleno». Se refresca sola
  cuando entra, cambia o se cancela una reserva. Vacía: «Sin servicio ese día (sin franjas activas).».
- **Franjas horarias**: Día, Desde, Hasta, Máx; «Añadir franja» (Día, Desde, Hasta, Máx →
  «Crear franja») y «Quitar» por fila. Vacía: «Sin franjas horarias.».
- **Fechas bloqueadas**: Fecha, Motivo, Día completo; «Añadir fecha bloqueada» (Fecha, Motivo →
  «Bloquear fecha») y «Quitar». Vacía: «Sin fechas bloqueadas.».
Cada sección pinta su propio «Cargando…» y su error con reintento.

## Flujos

El detalle de cada flujo (pasos, datos, fallos, implicados y QA) vive en `workflow/`, con la misma
gramática y el mismo prefijo. Huecos (`parcial`, `no hecho`): el porqué está en la línea `Estado:`.

| ID | Flujo | Estado | Fichero |
|---|---|---|---|
| RESERVATIONS-F01 | Crear y quitar franjas horarias | hecho | [workflow/disponibilidad.md](workflow/disponibilidad.md) |
| RESERVATIONS-F02 | Bloquear un día | parcial | [workflow/disponibilidad.md](workflow/disponibilidad.md) |
| RESERVATIONS-F03 | Ajustar las reglas de reserva | parcial | [workflow/disponibilidad.md](workflow/disponibilidad.md) |
| RESERVATIONS-F04 | Elegir si las reservas se confirman solas | parcial | [workflow/disponibilidad.md](workflow/disponibilidad.md) |
| RESERVATIONS-F05 | Consultar cuánto queda libre en un día | hecho | [workflow/disponibilidad.md](workflow/disponibilidad.md) |
| RESERVATIONS-F06 | Tomar una reserva a mano (teléfono o mostrador) | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F07 | Confirmar una reserva | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F08 | Modificar una reserva (hora, comensales, mesa) | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F09 | Cancelar una reserva | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F10 | Marcar que no se presentaron | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F11 | Sentar a la reserva | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F12 | Completar la reserva | hecho | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F13 | Liberar las reservas pendientes que nadie confirmó | hecho | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F14 | Apuntar en la lista de espera | parcial | [workflow/lista-de-espera.md](workflow/lista-de-espera.md) |
| RESERVATIONS-F15 | Marcar contactado o quitar de la lista de espera | hecho | [workflow/lista-de-espera.md](workflow/lista-de-espera.md) |
| RESERVATIONS-F16 | Convertir una entrada de la lista de espera en reserva | parcial | [workflow/lista-de-espera.md](workflow/lista-de-espera.md) |
| RESERVATIONS-F17 | Reserva que llega por WhatsApp | hecho | [workflow/whatsapp-y-clientes.md](workflow/whatsapp-y-clientes.md) |
| RESERVATIONS-F18 | Cambiar o anular la reserva por WhatsApp | no hecho | [workflow/whatsapp-y-clientes.md](workflow/whatsapp-y-clientes.md) |
| RESERVATIONS-F19 | Avisar por WhatsApp cuando el restaurante confirma | no hecho | [workflow/whatsapp-y-clientes.md](workflow/whatsapp-y-clientes.md) |
| RESERVATIONS-F20 | Borrar una reserva | parcial | [workflow/reservas.md](workflow/reservas.md) |
| RESERVATIONS-F21 | Unir las reservas de dos fichas de cliente | hecho | [workflow/whatsapp-y-clientes.md](workflow/whatsapp-y-clientes.md) |
| RESERVATIONS-F22 | Borrar los datos personales de un cliente (RGPD) | parcial | [workflow/whatsapp-y-clientes.md](workflow/whatsapp-y-clientes.md) |

## Cobertura contra la referencia

| Elemento de la referencia | Estado | Flujo |
|---|---|---|
| Turnos/franjas por día con aforo | hecho (aforo en reservas, no en comensales) | F01 |
| Cierres y festivos | hecho día completo; por horas, sin pantalla | F02 |
| Reglas: grupos, antelación, duración, contacto obligatorio | parcial: sin pantalla | F03 |
| Confirmación automática o manual | parcial: el primer guardado vuelve obligatorio el teléfono | F04 |
| Ocupación por servicio y cubiertos del día | hecho | F05 |
| Alta con nombre, teléfono, comensales, hora | hecho | F06 |
| Alta con correo, notas, alérgenos, ocasión, preferencia de zona | no hecho en pantalla (correo y notas por asistente o WhatsApp) | F06 |
| Asignar mesa a mano | parcial: solo por el asistente | F08 |
| Asignación automática de mesa | no hecho | — |
| Impedir dos reservas en la misma mesa a la misma hora | no hecho | — |
| Ciclo pendiente → confirmada → sentada → completada | hecho | F07, F11, F12 |
| Cancelar con motivo | parcial: sin motivo en pantalla | F09 |
| No presentado | parcial: sin botón | F10 |
| Modificar recalcula la disponibilidad | hecho (por asistente) | F08 |
| Modificar mueve la retención de mesa | parcial: mesa sí, hora no | F08 |
| Reserva confirmada retiene la mesa en el plano | parcial: solo si ya tiene mesa y se confirma con «Confirmar»; la que nace Confirmada no retiene | F04, F07 |
| Sentar gasta la retención | parcial: lo hace abrir la mesa en Mesas, no «Sentar», y la gasta cualquiera que se siente en esa mesa | F11 |
| La reserva sale en el plano cerca de su hora | parcial: la mesa se pinta Reservada desde que se confirma, aunque sea para otro día | F07 |
| Una reserva que no llega no deja la mesa muerta | parcial: la retención caduca 1 o 2 horas tarde en España | F11, F20 |
| Cancelar o no-show suelta la mesa | hecho | F09, F10 |
| Liberar las pendientes vencidas | hecho | F13 |
| Lista de espera: alta, contacto, conversión | hecho | F14, F15, F16 |
| Lista de espera: espera estimada, prioridad, aviso al cliente | no hecho | F14 |
| Dos reservas a la vez sobre el último hueco: gana una | hecho | F06 |
| Reserva por WhatsApp | hecho | F17 |
| Cambiar o anular por WhatsApp | no hecho | F18 |
| Mensaje al cliente al confirmar | no hecho | F19 |
| Historial del cliente (no-shows previos) | no hecho | — |
| Recordatorios antes de la reserva | fuera del MVP | — |
| Depósito, señal o cargo por no-show | fuera del MVP | — |
| Reserva desde la web del restaurante | no existe: Reservas online es un libro interno que se rellena con sesión, sin página pública ni puerta sin sesión | — |

## Datos: de quién es cada dato

- **Propios**: reservas, franjas horarias, fechas bloqueadas, lista de espera y los ajustes del
  restaurante (uno por hub). Otros módulos los leen solo por sus consultas públicas.
- **De Clientes**: la ficha se guarda como una referencia, sin enlace fuerte; Reservas no la lee
  (la busca por teléfono la receta de WhatsApp). Escucha la unión de fichas (F21) y el borrado de
  sus datos personales (F22).
- **De Mesas**: la mesa se guarda como referencia. Reservas no toca el plano: anuncia los cambios de
  estado y Mesas retiene, mueve o suelta su mesa.
- **Datos personales** (inventario RGPD):
  - reserva: ficha de cliente enlazada, nombre, teléfono, correo, notas del cliente (pueden traer
    alergias o una silla de ruedas: datos de salud), notas internas y motivo de cancelación;
  - lista de espera: ficha de cliente enlazada, nombre, teléfono, correo y notas;
  - en las cinco tablas (también franjas, bloqueos y ajustes): qué empleado creó y cambió cada fila;
  - copias fuera de Reservas: el aviso de reserva creada lleva nombre y ficha; el de cambio de
    estado, nombre y ficha; el de reserva cambiada, el teléfono, el correo y las notas si se
    cambian. Mesas copia el nombre en la etiqueta de la mesa retenida.
  - **Borrado**: al borrar los datos personales de una ficha en Clientes, Reservas vacía nombre,
    teléfono, correo, notas del cliente, notas internas y motivo de cancelación de sus reservas, y
    nombre, teléfono, correo y notas de sus entradas de espera, también las borradas (F22); la
    pantalla dice «Cliente borrado». Se conservan la fila, el día, la hora, los comensales, la mesa,
    el estado y el enlace a la ficha. No alcanza lo apuntado a mano sin ficha (reservations#99), ni
    la etiqueta de la mesa en Mesas, ni quién del equipo creó o cambió cada fila.

## Reglas que no se rompen

- **Aislamiento**: toda lectura y escritura va con el hub; un id de cliente o de mesa de otro hub
  nunca casa.
- **Toda reserva pasa la puerta al crearla o editarla**: comensales dentro de límites, antelación,
  día no bloqueado, franja activa que cubre la hora y hueco en la franja, comprobado dentro de la
  misma escritura; al crear (a mano o por WhatsApp), además, teléfono y correo si los ajustes los
  exigen. Dos reservas sobre el último hueco: una gana, la otra se rechaza. La conversión desde la
  lista de espera solo comprueba el día bloqueado y la franja con sitio.
- **El estado solo avanza**: nada vuelve a Pendiente; repetir el estado se rechaza; Completada solo
  desde Sentada; las horas de cada paso las pone el sistema, no quien llama.
- **En nombre del cliente** (WhatsApp u otro canal): la reserva tiene que ser suya, comprobado
  contra la propia reserva y antes de nada más; un cliente nunca cambia la mesa ni las notas internas.
- **Permisos**: el empleado consulta y apunta reservas; confirmar, sentar, completar, cancelar,
  editar, franjas, bloqueos, lista de espera y ajustes son del responsable; borrar, solo del
  administrador. El servidor lo aplica aunque la pantalla enseñe el botón.
- **Dinero y fiscal**: este módulo no cobra ni factura nada.
- Una reserva rechazada no deja nada escrito ni anuncia nada.

## Lo que NO hace, a propósito

- No cobra depósitos, señales ni cargos por no presentarse.
- No envía correos, SMS ni recordatorios; los ajustes de correo son solo una política guardada.
- No pinta ni ocupa el plano: eso es de Mesas, que lo hace al oír los cambios de la reserva.
- No es la agenda de citas por profesional (Citas) ni la reserva web (Reservas online).
- No sincroniza con calendarios externos: sus fechas y horas no llevan zona horaria.

## Dudas abiertas

Se resuelven con `market-decision`; no las decide el worker.

1. ¿El camarero (empleado) debe poder confirmar, sentar y cancelar? Hoy solo el responsable.
2. ¿El aforo de una franja se cuenta en reservas (hoy) o en comensales, como hace el mercado?
3. «Sentar» en Reservas y abrir la mesa en Mesas: ¿una sola acción que haga las dos?
4. ¿Hacen falta en la pantalla Editar, No-show, motivo al cancelar y asignar mesa, o el asistente basta?
5. ¿Asignación automática de mesa y control de dos reservas en la misma mesa entran en el MVP?
8. ¿Desde cuándo se pinta Reservada la mesa (hoy, desde que se confirma) y debe gastar la reserva de la noche
   un grupo que se sienta en esa mesa horas antes (hoy sí)? Es la duda 1 de Mesas (TABLES-F25, TABLES-F28).
6. La lista de espera: ¿es la cola de la puerta de hoy (espera estimada, aviso) o una lista para otro día?
7. ¿Teléfono obligatorio de fábrica? Hoy un restaurante sin ajustes guardados no lo exige y en
   cuanto guarda cualquiera (también desde WhatsApp) pasa a exigirlo.

## Fuentes contrastadas

Contra `origin/main` v3.0.48 (04/10/2026). Una línea por discrepancia; manda el código.

- **Pestaña de Ajustes**: `docs/screens.md`, `architecture/modules/reservations.md` (fila «Componente UI») y el capítulo del manual dicen que el shell la genera; no existe, porque el manifest no declara bloque de ajustes (F03).
- **`docs/overview.md`, `docs/concepts.md`, `docs/limits.md`, `README.md` y el manual** dicen que no hay tarea programada y que las pendientes nunca se liberan; se liberan cada 15 minutos desde reservations#5 (F13).
- **`docs/limits.md`**: «no hay recuento de huecos para la UI»; existe y lo pinta Disponibilidad desde reservations#4 y #38 (F05).
- **`docs/screens.md`** describe adjuntar ficha, correo, mesa, duración y notas al tomar la reserva, «Cancelar con motivo», la acción «No-show», abrir una reserva para ver su detalle y bloquear por horas; la pantalla no tiene nada de eso (F02, F06, F09, F10).
- **`docs/limits.md`**: «el cambio rechazado = la reserva no existe»; casi siempre es la puerta de disponibilidad (F08).
- **QA R-02 y `qa-hub-restaurant` §05** piden asignar mesa al reservar y que la reserva bloquee la mesa en el plano; desde la pantalla no se puede asignar mesa (F07, F08).
- **`qa-hub-restaurant` §05**: «modificar fecha u hora libera el hold anterior»; cambiar la hora no mueve la retención, solo cambiar la mesa (F08).
- **WR-02** espera un mensaje al cliente cuando el responsable confirma; no existe (F19).
- **WR-03** espera que anular por WhatsApp suelte la mesa; la receta no anula, contesta que alguien se ocupa (F18).
- **Matriz de roles de `qa-hub-restaurant` §6**: el camarero entra como empleado, y un empleado no puede confirmar, sentar ni cancelar (F07, F09, F11; duda 1).
- **`whatsapp_inbox/flows/README.md`** dice que Reservas no comprueba de quién es la reserva al cambiarla o anularla; desde reservations#50 sí lo comprueba (F18).
- **`module.json`** (`reservations.settings.set_auto_confirm`, descripción para el asistente): «una reserva que hizo el propio cliente»; el interruptor vale para toda reserva nueva, también la tomada a mano y la convertida desde la lista de espera (F04).
- **Duración por defecto**: `docs/screens.md` y `architecture/modules/reservations.md` dicen que la reserva toma la duración de los ajustes; el esquema de alta trae 120 por defecto y el hub lo rellena antes, así que solo la toma la conversión desde la lista de espera (F03, F06, F16).
- **Texto de ayuda del buscador de Reservas** («Buscar cliente, teléfono o fecha…»): una fecha no encuentra nada; busca por nombre, teléfono y correo (pantalla Reservas).
- **RESERVATIONS-F07, F11 y F20, oleada 2 (Mesas, 05/10/2026)**: decían que Mesas pinta la mesa reservada «desde su hora» y que la retención caduca «al acabar su ventana»; la pinta desde que se confirma (`_hold_paint_reservation.sql` no mira la fecha) y caduca 1 o 2 horas tarde, porque guarda la hora del negocio sin zona y la compara como texto con la hora del servidor en UTC (`table_hold_expire.sql`). Y sentar a cualquiera en esa mesa gasta todas sus retenciones (`_hold_consume_seated.sql` filtra solo por mesa) (F07, F11, F20).
