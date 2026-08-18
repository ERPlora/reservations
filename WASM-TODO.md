# WASM-TODO — módulo `reservations`

Lógica NO-CRUD que **no** se puede expresar de forma
fiel en SQL declarativo (§5.3 Tier 2: WASM vía Extism, o Tier 1 host caps). El WASM **no** toca
la BD: valida/calcula y devuelve *intenciones* que el runtime ejecuta contra los commands/queries
ya definidos.

> **Estado 2026-06-10:** los puntos **1–4 están IMPLEMENTADOS** (`handler/` Rust →
> `dist/handler.wasm`, funciones `create_reservation` / `set_status` / `waitlist_update`;
> verificado E2E contra el runtime real, 37/37). Diseño y desviaciones en
> `architecture/modules/reservations.md` y ADR-0021. Quedan pendientes los puntos 5 y 6.
>
> Desviación clave vs. el plan original: el host **no** entrega lecturas pre-cargadas (el guest
> recibe solo `{payload, context{hub_id, current_user_id, now, new_ids}}`), así que las guardas
> que dependen de datos vivos se evalúan en el SQL de commands **internos** dentro de la
> transacción, con assert-or-rollback sobre la tabla guardia `reservations__gate`
> (`CHECK (ok = 1)`, migración `002_gate.sql`).

Fuentes legacy: `services.py`, `whatsapp.py`, `scheduled_tasks.py`, `models.py` (propiedades/métodos
de `Reservation`).

---

## 1. Máquina de estados de la reserva (Tier 2 — WASM) ✅ IMPLEMENTADO

Origen: `Reservation.confirm/seat/complete/cancel/mark_no_show` + `can_be_*` (models.py) y
`ReservationService.update_status` (services.py).

Transiciones válidas (cualquier otra se rechaza, incluida repetir el mismo estado):

| desde \ a | confirmed | seated | completed | cancelled | no_show |
|-------------|-----------|--------|-----------|-----------|---------|
| pending | ✔ | ✔ | | ✔ | ✔ |
| confirmed | | ✔ | | ✔ | ✔ |
| seated | | | ✔ | | |

Reglas:
- `confirmed` ← solo desde `pending`; setea `confirmed_at = now`.
- `seated` ← desde `pending|confirmed`; setea `seated_at = now`.
- `completed` ← solo desde `seated`; setea `completed_at = now`.
- `cancelled` ← desde `pending|confirmed`; setea `cancelled_at = now` + `cancellation_reason`.
- `no_show` ← desde `pending|confirmed`; sin timestamp dedicado.

**Implementación:** handler `set_status` (rechaza destinos nunca legales) → command interno
`reservations._apply_status`: UPDATE condicionado a transición legal contra el `status` ACTUAL,
`*_at = :now` del runtime (el cliente ya no envía timestamps), assert sobre `reservations__gate`
(exige `status = :status AND updated_at = :now` ⇒ una transición ilegal revierte con error).

## 2. Motor de disponibilidad (Tier 2 — WASM) ✅ IMPLEMENTADO (sin `alternatives[]`)

Origen: `whatsapp.check_availability` + validaciones en `ReservationService.create`.

Para una fecha/hora/`party_size` dados, decide si se puede reservar:
- `party_size` dentro de `[settings.min_party_size, settings.max_party_size]`.
- La fecha no está en `reservations_blockeddate` (día completo, o franja que solape la hora).
- La hora cae dentro de algún `reservations_timeslot` activo para ese `day_of_week`.
- El nº de reservas vivas en ese slot no alcanza `timeslot.max_reservations` (conteo atómico).
- Ventana de antelación: `settings.min_advance_hours` ≤ (fecha-hora − now) ≤ `settings.max_advance_days`.

**Implementación:** handler `create_reservation` (valida forma, normaliza `time` a HH:MM:SS,
reparte el id de `context.new_ids`, emite `reservations.reservation.created` con el id) → command
interno `reservations._create_gated`: INSERT condicional que evalúa TODAS las condiciones contra
datos vivos dentro de la transacción (sin fila de settings aplican los defaults de la migración;
`auto_confirm` decide `pending|confirmed`; `duration_minutes` defaultea de settings) + assert.

**Pendiente:** `alternatives[]` (proponer otros slots) no es calculable sin lecturas del host en
el guest — gap del runtime (lecturas Tier 2). La UI puede componerlas con
`reservations.timeslots.list` + la futura query de conteo (punto 4).

## 3. Promoción de lista de espera → reserva (Tier 2 — WASM, multi-tabla) ✅ IMPLEMENTADO

Origen: campos `WaitlistEntry.is_converted/reservation_id` (models.py).

**Implementación:** `reservations.waitlist.update` ahora pasa por el handler `waitlist_update`:
- sin `is_converted` → update simple (command interno `reservations._waitlist_update`);
- con `is_converted=1` → promoción atómica (command interno `reservations._waitlist_promote`):
  crea la reserva **leyendo los datos de la propia fila de waitlist** (autoridad = BD, no el
  cliente), re-aplica el gate de disponibilidad (bloqueos/franja activa/capacidad; la ventana de
  antelación NO se aplica — es una acción de staff, normalmente para el mismo día) y enlaza
  `is_converted=1` + `reservation_id` en la MISMA transacción. Doble promoción, entrada
  inexistente o slot lleno ⇒ rollback de TODO (ni reserva ni flag). Emite además
  `reservations.reservation.created`.

## 4. Contadores de capacidad atómicos ✅ cubierto inline · query de conteo ✅ (`reservations.slots.count_for`, #4)

El chequeo de "slot lleno" se hace con un `COUNT(*)` correlacionado dentro del INSERT condicional
de `_create_gated`/`_waitlist_promote`, en la misma transacción del command ⇒ anti-overbooking
atómico (en SQLite el escritor es único; en Postgres revisar aislamiento cuando exista esa
migración). La lectura es `reservations.slots.count_for` (`queries/slots_count_for.sql`, #4):
por `{date[, time]}` devuelve una fila por franja activa del día con `reserved`/`available`, contando
EXACTAMENTE lo que cuenta el gate (mismo criterio de "viva" y de pertenencia a la franja) — es lo
que permite a la UI de disponibilidad mostrar ocupación sin intentar crear. Test contra Postgres
real: `tests/slots_count_for.pg.test.py`.

## 5. Tareas programadas (Tier 2/host — fuera del request del usuario) — PENDIENTE

Origen: `scheduled_tasks.py` (ambas eran `not_implemented` en legacy) + `module.py SCHEDULED_TASKS`.
- `release_unconfirmed` (cron `0 6 * * *`): cancelar/liberar reservas `pending` que superaron la
 ventana de hold (`settings.min_advance_hours` / política de no-confirmación).
- `send_reminders` (cron `0 17 * * *`): enviar recordatorios de las reservas de mañana
 (`settings.send_reminder_email` / `reminder_hours_before`).

En hub estas tareas las dispara el scheduler M2M; el handler calcula a quién aplicar y emite
las intenciones (set_status / envío de email vía host cap de notificaciones).

## 6. Integración WhatsApp (Tier 1 host cap + Tier 2) — PENDIENTE

Origen: `whatsapp.py` (`check_availability`, `create_from_request`, `get_context_for_bot`).
Reserva creada desde un mensaje de WhatsApp: reutiliza el motor de disponibilidad (punto 2) y el
alta. La mensajería saliente es una **host capability** mediada (no acceso de red directo del WASM,
§5.3 / §14). Pendiente de definir el contrato de notificaciones del runtime.

## 7. Propiedades derivadas de la reserva (Tier 0/SDK — no requieren WASM)

`reservation_datetime`, `end_datetime`, `is_past`, `is_today`, `minutes_until`, `is_upcoming`,
`status_label`, `status_class` (models.py) son puras funciones de los campos almacenados. Se
calculan en el Web Component / SDK a partir de la fila (no se persisten, no necesitan WASM).

---

### Cómo se compila el handler

```sh
cd handler
cargo build --release --target wasm32-unknown-unknown --features guest
cp target/wasm32-unknown-unknown/release/reservations_handler.wasm ../dist/handler.wasm
```

`erplora-guest-sdk` se referencia por ruta relativa al repo del Hub
(`../../../../hub/crates/guest-sdk`), igual que el resto de handlers del workspace.
