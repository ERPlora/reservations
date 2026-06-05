# WASM-TODO — módulo `reservations`

Lógica NO-CRUD portada de `old_modules/m_reservations/` que **no** se puede expresar de forma
fiel en SQL declarativo (§5.3 Tier 2: WASM vía Extism, o Tier 1 host caps). El WASM **no** toca
la BD: valida/calcula y devuelve *intenciones* que el runtime ejecuta contra los commands/queries
ya definidos. Mientras no exista el handler, los commands marcados aplican una versión "tonta"
(el SQL confía en que el payload ya viene validado) y los motores quedan pendientes.

Fuentes legacy: `services.py`, `whatsapp.py`, `scheduled_tasks.py`, `models.py` (propiedades/métodos
de `Reservation`).

---

## 1. Máquina de estados de la reserva (Tier 2 — WASM)

Origen: `Reservation.confirm/seat/complete/cancel/mark_no_show` + `can_be_*` (models.py) y
`ReservationService.update_status` (services.py).

Transiciones válidas (cualquier otra debe rechazarse):

| desde \ a   | confirmed | seated | completed | cancelled | no_show |
|-------------|-----------|--------|-----------|-----------|---------|
| pending     | ✔         | ✔      |           | ✔         | ✔       |
| confirmed   |           | ✔      |           | ✔         | ✔       |
| seated      |           |        | ✔         |           |         |

Reglas:
- `confirmed` ← solo desde `pending`; setea `confirmed_at = now`.
- `seated` ← desde `pending|confirmed`; setea `seated_at = now`.
- `completed` ← solo desde `seated`; setea `completed_at = now`.
- `cancelled` ← desde `pending|confirmed`; setea `cancelled_at = now` + `cancellation_reason`.
- `no_show` ← desde `pending|confirmed`; sin timestamp dedicado.

El handler debe: leer la reserva (query `reservations.reservations.get`), validar la transición
contra el `status` actual, calcular qué `*_at` rellenar, y devolver la intención que ejecuta el
command `reservations.reservations.set_status` (que ya acepta los binds `:confirmed_at` etc.).
**Hoy** `set_status` aplica el `status` recibido sin validar la transición → mover a WASM.

## 2. Motor de disponibilidad (Tier 2 — WASM)

Origen: `whatsapp.check_availability` + validaciones en `ReservationService.create`.

Para una fecha/hora/`party_size` dados, decidir si se puede reservar:
- `party_size` dentro de `[settings.min_party_size, settings.max_party_size]`.
- La fecha no está en `reservations_blockeddate` (día completo, o franja que solape la hora).
- La hora cae dentro de algún `reservations_timeslot` activo para ese `day_of_week`.
- El nº de reservas existentes en ese slot no supera `timeslot.max_reservations` (cuenta atómica).
- Ventana de antelación: `settings.min_advance_hours` ≤ (fecha-hora − now) ≤ `settings.max_advance_days`.
- Si no hay hueco, calcular **alternativas** (otros slots cercanos del mismo día / días próximos).

Devuelve `{ available, alternatives[], details }`. El alta (`create`) debe invocar esto antes de
insertar; **hoy** `reservations.reservations.create` inserta sin comprobar disponibilidad ni
bloqueos (solo el JSON Schema valida forma) → mover el gate a WASM.

## 3. Promoción de lista de espera → reserva (Tier 2 — WASM, multi-tabla)

Origen: campos `WaitlistEntry.is_converted/reservation_id` (models.py) — el legacy lo dejó como
flag manual, pero la conversión correcta es atómica:
1. Crear la reserva (command `reservations.reservations.create`).
2. Fijar en la entrada `is_converted = 1` y `reservation_id = <nueva reserva>`.

Debe ocurrir en una sola transacción. **Hoy** `reservations.waitlist.update` solo flipa el flag
`is_converted` (no crea la reserva ni enlaza `reservation_id`). El handler de conversión debe
orquestar ambos pasos y devolver las dos intenciones.

## 4. Contadores de capacidad atómicos (Tier 2 — WASM + query de conteo)

El chequeo de "slot lleno" (punto 2) requiere contar reservas vivas por (fecha, franja) y
compararlo con `max_reservations` bajo el `SAVEPOINT` del command, para evitar overbooking en
concurrencia. Necesita una query de conteo dedicada (p.ej. `reservations.slots.count_for`) que se
añadirá cuando se implemente el motor.

## 5. Tareas programadas (Tier 2/host — fuera del request del usuario)

Origen: `scheduled_tasks.py` (ambas eran `not_implemented` en legacy) + `module.py SCHEDULED_TASKS`.
- `release_unconfirmed` (cron `0 6 * * *`): cancelar/liberar reservas `pending` que superaron la
  ventana de hold (`settings.min_advance_hours` / política de no-confirmación).
- `send_reminders` (cron `0 17 * * *`): enviar recordatorios de las reservas de mañana
  (`settings.send_reminder_email` / `reminder_hours_before`).

En hub-next estas tareas las dispara el scheduler M2M; el handler calcula a quién aplicar y emite
las intenciones (set_status / envío de email vía host cap de notificaciones).

## 6. Integración WhatsApp (Tier 1 host cap + Tier 2)

Origen: `whatsapp.py` (`check_availability`, `create_from_request`, `get_context_for_bot`).
Reserva creada desde un mensaje de WhatsApp: reutiliza el motor de disponibilidad (punto 2) y el
alta. La mensajería saliente es una **host capability** mediada (no acceso de red directo del WASM,
§5.3 / §14). Pendiente de definir el contrato de notificaciones del runtime.

## 7. Propiedades derivadas de la reserva (Tier 0/SDK — no requieren WASM)

`reservation_datetime`, `end_datetime`, `is_past`, `is_today`, `minutes_until`, `is_upcoming`,
`status_label`, `status_class` (models.py) son puras funciones de los campos almacenados. Se
calculan en el Web Component / SDK a partir de la fila (no se persisten, no necesitan WASM).

---

### Resumen de qué quedó como SQL "confiado" pendiente de gate WASM
- `reservation_create.sql` — falta gate de disponibilidad/bloqueos/antelación (punto 2).
- `reservation_set_status.sql` — falta validación de transición + timestamps (punto 1).
- `waitlist_update.sql` — `is_converted` no crea ni enlaza la reserva (punto 3).
- Falta query de conteo de capacidad por slot (punto 4) y las tareas programadas (punto 5).

> NO se ha escrito Rust ni `dist/`. Este documento es el contrato para el Tier 2 cuando se implemente.
