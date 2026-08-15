# Módulo `reservations` — reservas de mesa y lista de espera

Capa de planificación **previa al servicio en sala**: define cuándo y para cuántos comensales se
acepta reservar (**franjas horarias** con capacidad + **fechas bloqueadas**), registra cada reserva
con su máquina de estados (`pending → confirmed → seated → completed`, más `cancelled`/`no_show`) y
captura en **lista de espera** a quien no cabe en un slot lleno, con **promoción atómica** a reserva.

> ⚠️ **No es `appointments`.** Aquí se reserva una **mesa** para un grupo (aforo por franja); allí se
> reserva un **servicio** con un **profesional** (solape por profesional). Y **no es `tables`**:
> sentar, mover y ocupar es de `tables`; esta reserva solo lleva una **referencia** de mesa.

<!-- -->

> **Module id:** `reservations`. **Depende de:** `tables`, `customers` — pero los referencia **por
> contrato, SIN FK** (esos módulos pueden no estar cargados al leer la fila).
> Módulo híbrido: SQL + handler WASM (`create_reservation`, `set_status`, `waitlist_update`) con
> guardas de estado en SQL vía tabla guardia `reservations__gate`.

## Documentación de usuario — [`docs/`](docs/)

Viaja **dentro** del módulo y se versiona con él: el asistente del hub (ADR-0282) la indexa por
versión instalada y cita la de TU versión, no la de la última publicada. En inglés (idioma fuente).

| Fichero | Para qué |
| ------- | -------- |
| [`docs/overview.md`](docs/overview.md) | Qué hace y qué NO hace; reservas vs citas; el ciclo de vida |
| [`docs/screens.md`](docs/screens.md) | Reservations / Waitlist / Availability y la **promoción** desde la lista de espera |
| [`docs/concepts.md`](docs/concepts.md) | Las guardas se evalúan **DENTRO del write** (aforo atómico), no se vuelve a `pending`, repetir estado se RECHAZA, la promoción lee la BD (no al cliente) |
| [`docs/limits.md`](docs/limits.md) | Las 5 causas de rechazo, permisos por acción y las dos trampas para integradores |

## Dos trampas para quien escriba un listener

1. **`reservations.reservations.create` no declara `emit` en el manifest** — el evento
   `reservations.reservation.created` lo emite el **handler WASM**. Existe aunque el `module.json` no
   lo delate.
2. **No hay evento de cancelación.** La cancelación viaja dentro de
   `reservations.reservation.status_changed`: hay que **mirar el estado**, no el nombre del evento.

## Qué expone hoy

| Tipo | Nombre | Permiso |
| ---- | ------ | ------- |
| query | `reservations.reservations.list` / `.get` | `view_reservation` |
| query | `reservations.timeslots.list` · `.blocked_dates.list` · `.waitlist.list` · `.settings.get` | los `view_*` correspondientes |
| command | `reservations.reservations.create` (WASM, aforo atómico) | `add_reservation` |
| command | `.update` (→ `reservations.update_rejected`) · `.set_status` (WASM) | `change_reservation` |
| command | `reservations.reservations.delete` | `delete_reservation` (solo admin) |
| command | `timeslots.create/delete` · `blocked_dates.create/delete` | `change_timeslot` · `change_blockeddate` |
| command | `waitlist.create` / `.update` (WASM, **promoción atómica**) / `.delete` | `change_waitlistentry` |
| command | `reservations.settings.upsert` | `manage_settings` |
| emite | `reservations.reservation.*`, `.timeslot.*`, `.blocked_date.*`, `.waitlist.*`, `.settings.updated` | — |
| escucha | — | — |

Navegación: `erp-reservations-list`, `erp-reservations-waitlist`, `erp-reservations-availability`;
ajustes declarativos (ADR-0082).

## Layout

```text
module.json                   # manifest (contrato técnico)
migrations/postgres/          # esquema §2.5 + tabla guardia reservations__gate
queries/*.sql                 # lecturas declarativas (:hub_id inyectado)
commands/*.sql                # escrituras declarativas (las `_` son intenciones del WASM)
schemas/*.json                # JSON Schemas de input (draft 2020-12)
handler/                      # WASM Tier 2 → dist/handler.wasm
ui/                           # Web Components (Lit/Ionic/OutfitKit)
docs/                         # documentación de usuario + corpus del asistente
```

## Estado y trabajo abierto

El estado vive en las **Issues de este repo**, no aquí. Limitaciones documentadas en
`docs/limits.md`: **cero envíos** (los ajustes de confirmación/recordatorio son solo política),
**cero tareas programadas** (`release_unconfirmed` y `send_reminders` diseñadas, no implementadas),
sin `alternatives[]` ni query de aforo para la UI, y `date`/`time` **naive** — por eso este módulo es
el **último de la cola** para `calendar_sync` (ADR-0148).

Doc de arquitectura: `architecture/modules/reservations.md` (cargarlo antes de tocar el módulo).
