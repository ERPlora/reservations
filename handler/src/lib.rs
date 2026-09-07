//! Handlers WASM (Tier 2) del módulo `reservations` — WASM-TODO §1–§4.
//!
//! Tres funciones exportadas (lógica pura, sin BD: reciben `{payload, context}`
//! y devuelven **intenciones** — ops SQL por nombre de command del mismo módulo —
//! que el host valida y ejecuta en UNA transacción):
//!
//! * `create_reservation` — gate de disponibilidad (§2/§4, anti-overbooking).
//!   Valida/normaliza el payload y delega en `reservations._create_gated`, cuyo
//!   INSERT condicional solo materializa la fila si settings/bloqueos/franja/
//!   capacidad/ventana de antelación lo permiten, **dentro de la transacción**
//!   (el conteo de capacidad es atómico). Un assert sobre la tabla guardia
//!   `reservations__gate` (CHECK ok=1) revierte todo si el gate falla.
//! * `set_status` — máquina de estados (§1). Rechaza estados/transiciones que
//!   nunca son legales en el guest; la legalidad dependiente del estado ACTUAL
//!   la aplica el SQL de `reservations._apply_status` (UPDATE condicionado +
//!   assert). Los timestamps (`confirmed_at`/`seated_at`/…) los fija el SQL con
//!   el `:now` del host — el cliente ya no puede falsificarlos. It also emits
//!   `reservations.reservation.status_changed` enriched from the preloaded row
//!   (`reads`, ADR-0069) — table, date, time, party, guest — so `tables` can hold
//!   or release the table from that event alone (reservations#13).
//! * `waitlist_update` — actualización de lista de espera; si el payload pide
//!   `is_converted=1`, hace la **promoción atómica** waitlist→reserva (§3):
//!   `reservations._waitlist_promote` crea la reserva LEYENDO los datos de la
//!   propia entrada (autoridad = fila, no el cliente), re-aplica el gate de
//!   disponibilidad (bloqueos/franja/capacidad) y enlaza `is_converted=1` +
//!   `reservation_id` en la misma transacción; cualquier fallo revierte ambos.
//!
//! Ids: el host pasa `context.new_ids` (autoridad de ids); el guest solo los
//! reparte (`new_ids[0]` = nueva reserva). El guest no toca la BD ni genera ids.

use erplora_guest_sdk::{DomainError, Event, Operation, Output};
use serde_json::{json, Map, Value};

#[cfg(feature = "guest")]
use extism_pdk::*;

#[cfg(feature = "guest")]
fn guest_err(msg: String) -> WithReturnCode<Error> {
    WithReturnCode::new(Error::msg(msg), 1)
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn create_reservation(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    create_reservation_pure(input.into_inner().into_value())
        .map(Json)
        .map_err(guest_err)
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn set_status(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    set_status_pure(input.into_inner().into_value()).map(Json).map_err(guest_err)
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn update_reservation(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    update_reservation_pure(input.into_inner().into_value()).map(Json).map_err(guest_err)
}

#[cfg(feature = "guest")]
#[plugin_fn]
pub fn waitlist_update(input: Json<erplora_guest_sdk::Input>) -> FnResult<Json<Output>> {
    waitlist_update_pure(input.into_inner().into_value()).map(Json).map_err(guest_err)
}

// ── helpers puros ────────────────────────────────────────────────────────────

fn as_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        _ => String::new(),
    }
}

fn as_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().map(|f| f as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_i64().unwrap_or(0) != 0,
        Value::String(s) => matches!(s.as_str(), "1" | "true" | "True" | "yes"),
        _ => false,
    }
}

fn req_str(payload: &Value, key: &str) -> Result<String, String> {
    let s = as_str(payload.get(key).unwrap_or(&Value::Null));
    let s = s.trim().to_string();
    if s.is_empty() {
        return Err(format!("`{key}` es obligatorio"));
    }
    Ok(s)
}

/// `YYYY-MM-DD` plausible (forma; el calendario real lo resuelve SQLite con strftime).
fn validate_date(date: &str) -> Result<(), String> {
    let b = date.as_bytes();
    let ok = b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter().enumerate().all(|(i, c)| matches!(i, 4 | 7) || c.is_ascii_digit());
    if !ok {
        return Err(format!("`date` inválida: `{date}` (se espera YYYY-MM-DD)"));
    }
    let (m, d) = (date[5..7].parse::<u8>().unwrap_or(0), date[8..10].parse::<u8>().unwrap_or(0));
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return Err(format!("`date` inválida: `{date}` (se espera YYYY-MM-DD)"));
    }
    Ok(())
}

/// Normaliza `HH:MM` / `HH:MM:SS` → `HH:MM:SS` (las comparaciones con
/// timeslot.start_time/end_time son lexicográficas y exigen el mismo ancho).
fn normalize_time(time: &str) -> Result<String, String> {
    let parts: Vec<&str> = time.split(':').collect();
    let valid = |s: &str, max: u8| s.len() == 2 && s.parse::<u8>().map(|v| v <= max).unwrap_or(false);
    match parts.as_slice() {
        [h, m] if valid(h, 23) && valid(m, 59) => Ok(format!("{h}:{m}:00")),
        [h, m, s] if valid(h, 23) && valid(m, 59) && valid(s, 59) => Ok(format!("{h}:{m}:{s}")),
        _ => Err(format!("`time` inválida: `{time}` (se espera HH:MM o HH:MM:SS)")),
    }
}

fn payload_and_ids(input: &Value) -> (Value, Vec<Value>) {
    let payload = input.get("payload").cloned().unwrap_or(Value::Null);
    let new_ids = input
        .pointer("/context/new_ids")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    (payload, new_ids)
}

// ── reservations#31/#32: the pre-check in front of the gate ───────────────────
//
// The authoritative gate stays in the SQL of `_create_gated` (a pre-check decides from a read;
// the race only closes server-side, same design as appointments#70). What lives HERE is the
// refusal the caller can act on: a stable namespaced code (hub#139) the UI translates, instead
// of the raw `reservations__gate` CHECK constraint every rejection used to surface as — full
// slot, day without service and oversized party were all the same sentence. The pre-check reads
// what the runtime pre-loaded (ADR-0069): the settings singleton, the day's slot capacity and
// the day's blocked dates. A read that did not ARRIVE is a refusal (fail closed), never a
// fallback to the payload; a read that arrived EMPTY (a hub without a settings row) means the
// DB defaults apply — the same COALESCEs the gate uses.

/// One pre-loaded read as rows. `None` = the runtime did NOT deliver the key (ADR-0069 rule 3).
fn read_rows<'a>(input: &'a Value, query: &str) -> Option<&'a Vec<Value>> {
    input
        .pointer("/context/reads")
        .and_then(|r| r.get(query))
        .and_then(|v| v.as_array())
}

/// The settings singleton the handler decides with; `{}` = this hub has no settings row yet
/// (the migration creates none), so the DB defaults apply — exactly the gate's COALESCEs.
fn settings_row(input: &Value) -> Option<Value> {
    read_rows(input, "reservations.settings.get")
        .map(|rows| rows.first().cloned().unwrap_or_else(|| json!({})))
}

/// `key` of the settings row as i64, falling to the same default the gate's COALESCE uses.
fn settings_i64(settings: &Value, key: &str, default: i64) -> i64 {
    settings.get(key).and_then(as_i64).filter(|v| *v >= 0).unwrap_or(default)
}

/// reservations#32: «phone required» / «email required» were settings that nothing read — with
/// both on, a booking with NO contact at all was accepted. The gate's SQL never sees the guest
/// fields (it only guards availability), so the enforcement lives here, against the SAME
/// settings row the Settings tab edits. `customer_id` is not a contact: the guest fields are.
fn contact_refusal(settings: &Value, payload: &Value) -> Option<DomainError> {
    let phone = as_str(payload.get("guest_phone").unwrap_or(&Value::Null));
    let email = as_str(payload.get("guest_email").unwrap_or(&Value::Null));
    if truthy(settings.get("require_phone").unwrap_or(&Value::Null)) && phone.trim().is_empty() {
        return Some(DomainError::new(
            "reservations.phone_required",
            "This business requires a phone number for every reservation.",
        ));
    }
    if truthy(settings.get("require_email").unwrap_or(&Value::Null)) && email.trim().is_empty() {
        return Some(DomainError::new(
            "reservations.email_required",
            "This business requires an email address for every reservation.",
        ));
    }
    None
}

/// Party size outside the configured `[min_party_size, max_party_size]`.
fn party_size_refusal(settings: &Value, party_size: i64) -> Option<DomainError> {
    let (min, max) = (
        settings_i64(settings, "min_party_size", 1),
        settings_i64(settings, "max_party_size", 20),
    );
    (party_size < min || party_size > max).then(|| {
        DomainError::new(
            "reservations.party_size_exceeded",
            format!("Party size must be between {min} and {max} for this business."),
        )
    })
}

/// The date is blocked: full day, or a block window that covers the requested time (inclusive,
/// like the gate). `blocked_from`/`until` are `HH:MM[:SS]` TEXT — lexicographic works because
/// `time` arrives here already normalized to `HH:MM:SS`.
fn blocked_date_refusal(input: &Value, date: &str, time: &str) -> Option<DomainError> {
    let rows = read_rows(input, "reservations.blocked_dates.on_date")?;
    let hit = rows.iter().any(|b| {
        if as_str(b.get("date").unwrap_or(&Value::Null)) != date {
            return false;
        }
        if truthy(b.get("is_full_day").unwrap_or(&Value::Null)) {
            return true;
        }
        let (from, until) = (
            as_str(b.get("blocked_from").unwrap_or(&Value::Null)),
            as_str(b.get("blocked_until").unwrap_or(&Value::Null)),
        );
        !from.is_empty() && !until.is_empty() && time >= from.as_str() && time <= until.as_str()
    });
    hit.then(|| {
        DomainError::new(
            "reservations.date_blocked",
            "That date is blocked (holiday or closure); no reservations are taken that day.",
        )
    })
}

/// No active slot of that day contains the requested time (`end_time` exclusive, like the gate),
/// or the slot(s) that do are at capacity. `slots.count_for` is pre-filtered to the payload's
/// weekday, so containment here is the whole membership rule.
fn slot_refusal(input: &Value, time: &str) -> Option<DomainError> {
    let rows = read_rows(input, "reservations.slots.count_for")?;
    let contains = |r: &Value| {
        let (start, end) = (
            as_str(r.get("start_time").unwrap_or(&Value::Null)),
            as_str(r.get("end_time").unwrap_or(&Value::Null)),
        );
        !start.is_empty() && !end.is_empty() && time >= start.as_str() && time < end.as_str()
    };
    let matching: Vec<&Value> = rows.iter().filter(|r| contains(r)).collect();
    if matching.is_empty() {
        return Some(DomainError::new(
            "reservations.no_service_day",
            "There is no service at that time: no open time slot covers it.",
        ));
    }
    let has_room = |r: &Value| {
        let (reserved, max) = (
            r.get("reserved").and_then(as_i64).unwrap_or(0),
            r.get("max_reservations").and_then(as_i64).unwrap_or(0),
        );
        reserved < max
    };
    (!matching.iter().any(|r| has_room(r))).then(|| {
        DomainError::new(
            "reservations.no_capacity",
            "That time slot is fully booked for that date.",
        )
    })
}

/// The advance-booking window is deliberately NOT pre-checked here: the gate measures the
/// wall-clock reservation against the SERVER's timezone (`erp_datediff_days` casts the local
/// `date || time` as timestamptz) while the handler only knows the UTC `now` — a handler-side
/// check could disagree with the gate by hours around the boundary. That refusal still surfaces
/// from the gate (see `_create_gated_assert.sql`, reason `outside_advance_window`).

/// reservations#31: the specific pre-checks in front of the SQL gate. `Ok(None)` = nothing to
/// refuse from the reads; a `DomainError` aborts the command before any write.
fn create_refusal(input: &Value, settings: &Value, payload: &Value, party_size: i64, date: &str, time: &str) -> Option<DomainError> {
    contact_refusal(settings, payload)
        .or_else(|| party_size_refusal(settings, party_size))
        .or_else(|| blocked_date_refusal(input, date, time))
        .or_else(|| slot_refusal(input, time))
}

// ── §2/§4 gate de disponibilidad en el alta ──────────────────────────────────

/// `{payload, context}` → intención `reservations._create_gated` + evento.
pub fn create_reservation_pure(input: Value) -> Result<Output, String> {
    let (payload, new_ids) = payload_and_ids(&input);

    let guest_name = req_str(&payload, "guest_name")?;
    let date = req_str(&payload, "date")?;
    validate_date(&date)?;
    let time = normalize_time(&req_str(&payload, "time")?)?;
    let party_size = as_i64(payload.get("party_size").unwrap_or(&Value::Null))
        .filter(|n| *n >= 1)
        .ok_or("`party_size` debe ser un entero >= 1")?;
    let duration = payload
        .get("duration_minutes")
        .and_then(as_i64)
        .filter(|n| *n >= 1)
        .map(Value::from)
        .unwrap_or(Value::Null); // NULL → default de settings en el SQL
    let reservation_id = new_ids.first().map(as_str).filter(|s| !s.is_empty())
        .ok_or("context.new_ids vacío: el host no entregó ids")?;

    // reservations#31/#32: the readable pre-check in front of the gate. The reads the manifest
    // declares (`reads`, required) are the authority; without them the command refuses — a guard
    // that guesses when its input is missing is a guard that opens. The SQL gate below stays
    // untouched and authoritative for the race.
    if !["reservations.settings.get", "reservations.slots.count_for", "reservations.blocked_dates.on_date"]
        .iter()
        .all(|q| read_rows(&input, q).is_some())
    {
        return Ok(Output::new().with_error(DomainError::new(
            "reservations.reads_unavailable",
            "The reservation settings could not be read; nothing was booked.",
        )));
    }
    let settings = settings_row(&input).unwrap_or_else(|| json!({}));
    if let Some(refusal) = create_refusal(&input, &settings, &payload, party_size, &date, &time) {
        return Ok(Output::new().with_error(refusal));
    }

    let mut p = Map::new();
    p.insert("reservation_id".into(), json!(reservation_id));
    p.insert("customer_id".into(), payload.get("customer_id").cloned().unwrap_or(Value::Null));
    p.insert("guest_name".into(), json!(guest_name));
    p.insert("guest_phone".into(), json!(as_str(payload.get("guest_phone").unwrap_or(&Value::Null))));
    p.insert("guest_email".into(), json!(as_str(payload.get("guest_email").unwrap_or(&Value::Null))));
    p.insert("date".into(), json!(date));
    p.insert("time".into(), json!(time));
    p.insert("party_size".into(), json!(party_size));
    p.insert("duration_minutes".into(), duration);
    p.insert("table_id".into(), payload.get("table_id").cloned().unwrap_or(Value::Null));
    p.insert("notes".into(), json!(as_str(payload.get("notes").unwrap_or(&Value::Null))));
    p.insert("internal_notes".into(), json!(as_str(payload.get("internal_notes").unwrap_or(&Value::Null))));

    let event = Event::new("reservations.reservation.created", json!({
        "sender": "reservations",
        "reservation_id": reservation_id,
        "customer_id": payload.get("customer_id").cloned().unwrap_or(Value::Null),
        "guest_name": guest_name,
        "date": date,
        "time": time,
        "party_size": party_size,
    }));

    Ok(Output {
        operations: vec![Operation::sql("reservations._create_gated", p)],
        events: vec![event],
        ..Default::default()
    })
}

// ── reservations#50: WHO is asking, and is the table theirs? ─────────────────
//
// The mirror of appointments#140 (`cancel`) and appointments#142 (`reschedule`), same rule and
// same shape: ONE guard, asked by BOTH customer-facing doors. Two copies of «is this yours» is
// how one of them ends up drifting open again.

/// Who is asking. `staff` = someone operating the hub (the DEFAULT: the reservations screen
/// never sends a channel); `customer` = the guest herself through an external channel — today
/// the WhatsApp automation acting on her behalf (whatsapp_inbox#60).
#[derive(Clone, Copy, PartialEq, Debug)]
enum CallerChannel {
    Staff,
    Customer,
}

fn caller_channel(payload: &Value) -> Result<CallerChannel, String> {
    match payload.get("channel").map(as_str).as_deref() {
        None | Some("") | Some("staff") => Ok(CallerChannel::Staff),
        Some("customer") => Ok(CallerChannel::Customer),
        Some(other) => Err(format!(
            "`channel` inválido: `{other}` no es ninguno de staff|customer"
        )),
    }
}

/// The reservation row the runtime pre-loaded via `reads` (`reservations.reservations.get`,
/// filtered by `payload.reservation_id`, ADR-0069). `Value::Null` when the read is missing or
/// empty — graceful by contract (#13) on the staff path, fail-closed on the customer one.
fn reservation_row(input: &Value) -> Value {
    input
        .pointer("/context/reads/reservations.reservations.get/0")
        .cloned()
        .unwrap_or(Value::Null)
}

/// WHOSE reservation is it? Asked by `set_status` AND by `update`, in both cases straight after
/// the authoritative read and BEFORE the state machine, the availability gate and the policy —
/// so a caller holding an id that is not theirs always gets the same answer, «not yours»,
/// instead of a refusal that tells them whether that id exists and what state it is in.
///
/// `Ok(None)` = the caller may go on; `Ok(Some(err))` = the table is somebody else's;
/// `Err` = the payload itself is broken.
fn customer_identity_refusal(
    channel: CallerChannel,
    payload: &Value,
    row: &Value,
) -> Result<Option<DomainError>, String> {
    // Only the customer channel is bound: the staff channel is the dining room's own counter,
    // which manages every table in the room and never acts on anybody's behalf. A `customer_id`
    // it happens to send is NOT an identity claim — reading it as one would let a mistyped id
    // refuse the receptionist her own work, which is a business regression, not security.
    if channel != CallerChannel::Customer {
        return Ok(None);
    }
    let asking = as_str(payload.get("customer_id").unwrap_or(&Value::Null));
    let asking = asking.trim();
    if asking.is_empty() {
        // A payload contract bug, not a business refusal — the same treatment as a missing
        // `reservation_id`. A `channel: customer` that names nobody proves nothing, so it fails
        // closed and LOUDLY: an external channel wired without the guest must be fixed, not
        // answered with a sentence the guest is told to act on.
        return Err("`customer_id` es obligatorio cuando `channel` es `customer`".to_string());
    }
    // `row.customer_id` is the reservation's OWN link, from the authoritative read — never from
    // the payload. Null or empty (a walk-in the counter typed with no customer attached) matches
    // nobody: `asking` is non-empty by the check above. A missing read lands here too, which is
    // what makes the customer path fail closed where the staff path degrades to the SQL gate.
    if as_str(row.get("customer_id").unwrap_or(&Value::Null)) != asking {
        return Ok(Some(DomainError::new(
            "reservations.customer_mismatch",
            "That reservation belongs to a different guest, so it cannot be managed on their behalf.",
        )));
    }
    Ok(None)
}

/// Fields of a reservation that only the counter writes: the table it sits at (assigning your
/// own table is the dining room's decision, not the guest's) and the restaurant's private notes
/// about the booking. They are in the `update` schema because staff edits them from the screen;
/// opening the customer channel without this would hand the guest a pen for both.
const STAFF_ONLY_UPDATE_FIELDS: [&str; 2] = ["table_id", "internal_notes"];

/// The other half of the customer door on `update`: what a guest may change about her own
/// booking. Whoever it is, it is still not hers to seat or to annotate.
fn staff_only_field_refusal(channel: CallerChannel, payload: &Value) -> Option<DomainError> {
    if channel != CallerChannel::Customer {
        return None;
    }
    let field = STAFF_ONLY_UPDATE_FIELDS
        .iter()
        .find(|f| !matches!(payload.get(**f), None | Some(Value::Null)))?;
    Some(DomainError::new(
        "reservations.staff_only_field",
        format!("`{field}` is set by the restaurant; a guest cannot change it from their booking."),
    ))
}

// ── §1 máquina de estados ────────────────────────────────────────────────────

/// Estados destino válidos (a `pending` no se transiciona nunca; los orígenes
/// legales por destino los aplica el SQL de `_apply_status` contra el estado actual).
const TARGET_STATUSES: [&str; 5] = ["confirmed", "seated", "completed", "cancelled", "no_show"];

/// Every status the state machine knows (target or current). A current status OUTSIDE this set
/// is not something the handler can reason about — it degrades to the SQL gate instead of
/// refusing a transition it cannot vouch is illegal.
const KNOWN_STATUSES: [&str; 6] = ["pending", "confirmed", "seated", "completed", "cancelled", "no_show"];

/// reservations#37: the legal transitions, mirroring the WHERE of `_apply_status_update.sql`
/// pair by pair (repeating the same status is NOT legal — the SQL only accepts the forward
/// pairs). The SQL stays the authority against the live row inside the transaction; this mirror
/// only powers the readable refusal in front of it.
fn legal_transition(current: &str, target: &str) -> bool {
    matches!(
        (current, target),
        ("pending", "confirmed")
            | ("pending", "seated")
            | ("pending", "cancelled")
            | ("pending", "no_show")
            | ("confirmed", "seated")
            | ("confirmed", "cancelled")
            | ("confirmed", "no_show")
            | ("seated", "completed")
    )
}

/// reservations#37: the refusal the caller can act on. The English fallback sentence names the
/// CURRENT status and the REQUESTED one (the message channel is the source; the UI paints the
/// `errors` translation of the code); the terminal statuses get their own sentence because for
/// them no target is ever the answer. Same shape as the create refusals of #31/#32 (hub#139).
fn illegal_transition_error(current: &str, target: &str) -> DomainError {
    if matches!(current, "cancelled" | "completed" | "no_show") {
        return DomainError::new(
            "reservations.illegal_transition",
            format!("This reservation is {current}; its status can no longer change."),
        );
    }
    if target == "completed" {
        return DomainError::new(
            "reservations.illegal_transition",
            format!("This reservation is {current}; it cannot be completed before it is seated — seat it first."),
        );
    }
    DomainError::new(
        "reservations.illegal_transition",
        format!("This reservation is {current}; it cannot be set to {target}."),
    )
}

/// `{payload, context}` → intención `reservations._apply_status`.
pub fn set_status_pure(input: Value) -> Result<Output, String> {
    let (payload, _) = payload_and_ids(&input);

    let channel = caller_channel(&payload)?;
    let reservation_id = req_str(&payload, "reservation_id")?;
    let status = req_str(&payload, "status")?;
    if !TARGET_STATUSES.contains(&status.as_str()) {
        return Err(format!(
            "transición inválida: `{status}` no es un estado destino legal (válidos: {})",
            TARGET_STATUSES.join(", ")
        ));
    }

    let cancellation_reason = if status == "cancelled" {
        payload.get("cancellation_reason").cloned().unwrap_or(Value::Null)
    } else {
        Value::Null
    };

    // reservations#13: the event is emitted HERE, enriched from the authoritative row the host
    // preloaded (`reads` → `context.reads["reservations.reservations.get"]`, ADR-0069) — never
    // from the payload, so a caller cannot decide which table `tables` holds. `tables` listens
    // to it and holds/releases the table (`tables._hold_from_reservation`). The command declares
    // no `emit` for it: that would queue the same fact twice, once bare and once enriched.
    // If the read is missing (rule 3, graceful) the fact is still announced without table data.
    let row = reservation_row(&input);

    // reservations#50: WHOSE reservation is it? Decided from that same authoritative row and
    // BEFORE the state machine, so a stranger who guesses an id cannot cancel a table that is
    // not hers — nor use the state refusals to learn anything about it.
    if let Some(refusal) = customer_identity_refusal(channel, &payload, &row)? {
        return Ok(Output::new().with_error(refusal));
    }

    // reservations#37: the readable refusal in front of the state machine. The same preloaded
    // row that enriches the event says whether the transition is legal; when the guest KNOWS it
    // is not (current status known + pair outside the SQL's WHERE), refuse here with a stable
    // code (hub#139) instead of letting the `_apply_status` assert surface as a bare
    // `{"code":"error"}`. The read is graceful by contract (#13): if it did not arrive, or the
    // row carries a status the guest does not know, say nothing — the SQL gate inside the
    // transaction remains the authority and still rejects the illegal write.
    let current = as_str(row.get("status").unwrap_or(&Value::Null));
    if KNOWN_STATUSES.contains(&current.as_str()) && !legal_transition(&current, &status) {
        return Ok(Output::new().with_error(illegal_transition_error(&current, &status)));
    }

    let mut p = Map::new();
    p.insert("reservation_id".into(), json!(reservation_id));
    p.insert("status".into(), json!(status));
    p.insert("cancellation_reason".into(), cancellation_reason.clone());

    let field = |k: &str| row.get(k).cloned().unwrap_or(Value::Null);
    let event = Event::new("reservations.reservation.status_changed", json!({
        "sender": "reservations",
        "reservation_id": reservation_id,
        "status": status,
        "previous_status": field("status"),
        "cancellation_reason": cancellation_reason,
        "table_id": field("table_id"),
        "date": field("date"),
        "time": field("time"),
        "duration_minutes": field("duration_minutes"),
        "party_size": field("party_size"),
        "guest_name": field("guest_name"),
        "customer_id": field("customer_id"),
    }));

    Ok(Output {
        operations: vec![Operation::sql("reservations._apply_status", p)],
        events: vec![event],
        ..Default::default()
    })
}

// ── reservations#50: `update` behind the same door ───────────────────────────

/// Every field of the reservation the SQL of `_apply_update` can write, in the order the
/// `UPDATE` sets them. The handler carries them VERBATIM: `COALESCE(:field, field)` reads a
/// missing bind as «leave it as it was», which is what a partial edit means, and the driver
/// binds a missing key and an explicit `null` identically (both `DynNull`) — so forwarding the
/// payload field by field is byte-for-byte what the declarative command used to send.
const UPDATE_FIELDS: [&str; 10] = [
    "guest_name",
    "guest_phone",
    "guest_email",
    "date",
    "time",
    "party_size",
    "duration_minutes",
    "table_id",
    "notes",
    "internal_notes",
];

/// `{payload, context}` → intención `reservations._apply_update`.
///
/// `update` was Tier 0 (payload → `commands/reservation_update.sql`) and it moved here for ONE
/// reason: so it can ask the SAME identity guard `set_status` asks (reservations#50). Everything
/// the SQL decided, the SQL still decides — party-size limits, advance window, blocked days,
/// active slot with room, and the `expect_rows` rejection — inside the same transaction, now
/// hanging off the private `reservations._apply_update`. The handler adds no availability rule
/// and takes none away; it answers «who is asking, and is this table theirs».
pub fn update_reservation_pure(input: Value) -> Result<Output, String> {
    let (payload, _) = payload_and_ids(&input);

    let channel = caller_channel(&payload)?;
    let reservation_id = req_str(&payload, "reservation_id")?;
    let row = reservation_row(&input);

    // Asked FIRST, against the authoritative row, and before anything that could answer
    // differently depending on the row: a caller holding an id that is not theirs learns
    // nothing about it beyond «not yours».
    if let Some(refusal) = customer_identity_refusal(channel, &payload, &row)? {
        return Ok(Output::new().with_error(refusal));
    }
    if let Some(refusal) = staff_only_field_refusal(channel, &payload) {
        return Ok(Output::new().with_error(refusal));
    }

    let mut p = Map::new();
    p.insert("reservation_id".into(), json!(reservation_id));
    for field in UPDATE_FIELDS {
        p.insert(field.into(), payload.get(field).cloned().unwrap_or(Value::Null));
    }

    Ok(Output {
        operations: vec![Operation::sql("reservations._apply_update", p)],
        events: vec![],
        ..Default::default()
    })
}

// ── §3 waitlist: update simple o promoción atómica ──────────────────────────

/// `{payload, context}` → si `is_converted` es truthy, promoción atómica
/// (`reservations._waitlist_promote`); si no, update simple (`reservations._waitlist_update`).
pub fn waitlist_update_pure(input: Value) -> Result<Output, String> {
    let (payload, new_ids) = payload_and_ids(&input);

    let entry_id = req_str(&payload, "entry_id")?;
    let is_contacted = payload.get("is_contacted").cloned().unwrap_or(Value::Null);
    let notes = payload.get("notes").cloned().unwrap_or(Value::Null);
    let convert = payload.get("is_converted").map(truthy).unwrap_or(false);

    if !convert {
        let mut p = Map::new();
        p.insert("entry_id".into(), json!(entry_id));
        p.insert("is_contacted".into(), is_contacted);
        p.insert("is_converted".into(), payload.get("is_converted").cloned().unwrap_or(Value::Null));
        p.insert("notes".into(), notes);
        return Ok(Output {
            operations: vec![Operation::sql("reservations._waitlist_update", p)],
            events: vec![],
        ..Default::default()
        });
    }

    let reservation_id = new_ids.first().map(as_str).filter(|s| !s.is_empty())
        .ok_or("context.new_ids vacío: el host no entregó ids")?;

    let mut p = Map::new();
    p.insert("entry_id".into(), json!(entry_id));
    p.insert("reservation_id".into(), json!(reservation_id));
    p.insert("is_contacted".into(), is_contacted);
    p.insert("notes".into(), notes);

    let event = Event::new("reservations.reservation.created", json!({
        "sender": "reservations",
        "reservation_id": reservation_id,
        "waitlist_entry_id": entry_id,
        "promoted_from_waitlist": true,
    }));

    Ok(Output {
        operations: vec![Operation::sql("reservations._waitlist_promote", p)],
        events: vec![event],
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `{payload, context}` as the host builds it — `context.reads` is what ADR-0069 preloads
    /// from the manifest `reads` block, keyed by query name.
    fn input(payload: Value, reads: Option<Value>) -> Value {
        let mut ctx = json!({ "new_ids": [] });
        if let Some(r) = reads {
            ctx["reads"] = r;
        }
        json!({ "payload": payload, "context": ctx })
    }

    fn manifest() -> Value {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../module.json"))
            .expect("module.json next to handler/");
        serde_json::from_str(&raw).expect("module.json parses")
    }

    // ── reservations#13: the status change tells `tables` WHICH table, WHEN and for WHOM ──

    fn confirmed_row() -> Value {
        json!([{
            "id": "r-ana", "guest_name": "Ana", "guest_phone": "", "guest_email": "",
            "date": "2026-08-20", "time": "21:00:00", "party_size": 4,
            "duration_minutes": 90, "table_id": "t1", "status": "pending",
        }])
    }

    #[test]
    fn set_status_emits_status_changed_enriched_from_the_authoritative_row() {
        let out = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "confirmed" }),
            Some(json!({ "reservations.reservations.get": confirmed_row() })),
        ))
        .expect("legal transition");

        let ev = out
            .events
            .iter()
            .find(|e| e.name == "reservations.reservation.status_changed")
            .expect("the handler emits status_changed itself (the command no longer does)");
        assert_eq!(ev.payload["reservation_id"], json!("r-ana"));
        assert_eq!(ev.payload["status"], json!("confirmed"));
        assert_eq!(ev.payload["previous_status"], json!("pending"));
        assert_eq!(ev.payload["table_id"], json!("t1"), "tables needs the table to hold it");
        assert_eq!(ev.payload["date"], json!("2026-08-20"));
        assert_eq!(ev.payload["time"], json!("21:00:00"));
        assert_eq!(ev.payload["duration_minutes"], json!(90));
        assert_eq!(ev.payload["party_size"], json!(4));
        assert_eq!(ev.payload["guest_name"], json!("Ana"));
        assert_eq!(ev.payload["sender"], json!("reservations"));
        assert_eq!(out.events.len(), 1, "exactly one status_changed per transition");
    }

    #[test]
    fn set_status_refuses_an_illegal_transition_with_a_readable_code() {
        // reservations#37: the poster case — completing a reservation that was never seated.
        // The SQL state machine already refuses it (#2); what was missing is the refusal the
        // caller can act on: it surfaced as the raw `reservations__gate` CHECK constraint
        // ({"code":"error"}), which says nothing about why or what to do instead.
        let out = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "completed" }),
            Some(json!({ "reservations.reservations.get": confirmed_row() })),
        ))
        .expect("a refusal is an output, not a fault");
        assert_eq!(refusal_code(&out), "reservations.illegal_transition");
        let err = out.error.expect("refused");
        assert!(err.message.contains("pending"), "names the CURRENT status: {}", err.message);
        assert!(err.message.contains("completed"), "names the REQUESTED status: {}", err.message);
        assert!(out.operations.is_empty(), "a refusal must not carry operations");
        assert!(out.events.is_empty(), "a refusal must not announce a transition that did not happen");
    }

    #[test]
    fn set_status_refusal_covers_every_pair_the_state_machine_rejects() {
        // The pre-check mirrors `_apply_status_update.sql` exactly: refuse exactly what the SQL
        // would roll back. Repeating the same status is illegal too (the SQL only accepts the
        // forward pairs), and a terminal reservation (cancelled/completed/no_show) accepts
        // nothing at all.
        let refuses = [
            ("pending", "completed"),
            ("confirmed", "confirmed"),
            ("confirmed", "completed"),
            ("seated", "confirmed"),
            ("seated", "seated"),
            ("seated", "cancelled"),
            ("cancelled", "confirmed"),
            ("completed", "cancelled"),
            ("no_show", "no_show"),
        ];
        for (current, target) in refuses {
            let row = json!([{ "id": "r-1", "status": current }]);
            let out = set_status_pure(input(
                json!({ "reservation_id": "r-1", "status": target }),
                Some(json!({ "reservations.reservations.get": row })),
            ))
            .unwrap();
            assert_eq!(refusal_code(&out), "reservations.illegal_transition", "{current} → {target}");
            assert!(out.operations.is_empty(), "{current} → {target} must not write");
        }
    }

    #[test]
    fn set_status_still_proceeds_on_every_legal_transition() {
        // The pre-check may not over-refuse: every pair the SQL accepts must still reach the
        // gated UPDATE (the SQL stays the authority for the race).
        let legal = [
            ("pending", "confirmed"),
            ("pending", "seated"),
            ("pending", "cancelled"),
            ("pending", "no_show"),
            ("confirmed", "seated"),
            ("confirmed", "cancelled"),
            ("confirmed", "no_show"),
            ("seated", "completed"),
        ];
        for (current, target) in legal {
            let row = json!([{ "id": "r-1", "status": current }]);
            let out = set_status_pure(input(
                json!({ "reservation_id": "r-1", "status": target }),
                Some(json!({ "reservations.reservations.get": row })),
            ))
            .unwrap();
            assert_eq!(refusal_code(&out), "", "{current} → {target} was wrongly refused");
            assert_eq!(out.operations.len(), 1, "{current} → {target} must carry the gated UPDATE");
        }
    }

    #[test]
    fn set_status_unknown_current_status_degrades_to_the_sql_gate() {
        // A status the guest does not know (schema drift, hand-edited row) is NOT a refusal the
        // handler can vouch for — the SQL decides against the live row. Only refuse what the
        // handler KNOWS is illegal.
        let row = json!([{ "id": "r-1", "status": "mystery" }]);
        let out = set_status_pure(input(
            json!({ "reservation_id": "r-1", "status": "confirmed" }),
            Some(json!({ "reservations.reservations.get": row })),
        ))
        .unwrap();
        assert_eq!(refusal_code(&out), "", "an unknown current status is the SQL gate's call");
        assert_eq!(out.operations.len(), 1);
    }

    #[test]
    fn set_status_ignores_table_data_forged_in_the_payload() {
        // The caller cannot decide which table gets held: the row is the authority.
        let out = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "confirmed", "table_id": "t-forged" }),
            Some(json!({ "reservations.reservations.get": confirmed_row() })),
        ))
        .unwrap();
        assert_eq!(out.events[0].payload["table_id"], json!("t1"));
    }

    #[test]
    fn set_status_still_emits_when_the_read_is_missing() {
        // ADR-0069 rule 3: a read that fails is omitted, the command degrades — the status
        // change is still a fact worth announcing, only without the table details.
        let out = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "cancelled", "cancellation_reason": "sick" }),
            None,
        ))
        .unwrap();
        let ev = &out.events[0];
        assert_eq!(ev.name, "reservations.reservation.status_changed");
        assert_eq!(ev.payload["reservation_id"], json!("r-ana"));
        assert_eq!(ev.payload["status"], json!("cancelled"));
        assert_eq!(ev.payload["cancellation_reason"], json!("sick"));
        assert_eq!(ev.payload["table_id"], Value::Null);
    }

    // ── reservations#32/#31: enforced contacts + a refusal that says WHY ──────────────
    //
    // The create handler decides from the reads the runtime pre-loads (ADR-0069): the settings
    // singleton, the slot capacity of the day and the blocked dates of the day. A refusal is a
    // normal output (`with_error`, hub#139) — the SQL gate stays as the authoritative race guard.

    /// The settings singleton as the read returns it, with `over` patched on top.
    fn settings_read(over: Value) -> Value {
        let mut row = json!({
            "id": "s1", "time_slot_duration": 30, "min_party_size": 1, "max_party_size": 20,
            "min_advance_hours": 1, "max_advance_days": 30, "auto_confirm": 0,
            "require_phone": 0, "require_email": 0, "no_show_window_minutes": 15,
            "default_duration_minutes": 120, "send_confirmation_email": 0,
            "send_reminder_email": 0, "reminder_hours_before": 24
        });
        if let (Some(dst), Some(src)) = (row.as_object_mut(), over.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
        json!([row])
    }

    /// Slots of the day as `reservations.slots.count_for` returns them (`:date` only → all).
    fn slots_read(rows: Value) -> Value {
        rows
    }

    fn full_day_slot() -> Value {
        json!([{
            "timeslot_id": "s-dinner", "start_time": "20:00:00", "end_time": "23:00:00",
            "max_reservations": 2, "reserved": 1, "available": 1
        }])
    }

    fn base_payload() -> Value {
        json!({
            "guest_name": "Ana", "date": "2026-08-20", "time": "21:00", "party_size": 4
        })
    }

    /// Input with all three reads delivered and healthy by default.
    fn create_input(payload: Value, reads: Vec<(&str, Value)>) -> Value {
        let mut ctx = json!({ "new_ids": ["r-new"], "reads": {} });
        for (name, rows) in reads {
            ctx["reads"][name] = rows;
        }
        json!({ "payload": payload, "context": ctx })
    }

    fn healthy_reads() -> Vec<(&'static str, Value)> {
        vec![
            ("reservations.settings.get", settings_read(json!({}))),
            ("reservations.slots.count_for", slots_read(full_day_slot())),
            ("reservations.blocked_dates.on_date", json!([])),
        ]
    }

    fn refusal_code(out: &Output) -> &str {
        out.error.as_ref().map(|e| e.code.as_str()).unwrap_or("")
    }

    #[test]
    fn create_without_any_contact_is_refused_when_settings_require_one() {
        // reservations#32: both flags on and NO contact at all used to sail through.
        let out = create_reservation_pure(create_input(
            base_payload(),
            vec![
                ("reservations.settings.get", settings_read(json!({ "require_phone": 1, "require_email": 1 }))),
                ("reservations.slots.count_for", slots_read(full_day_slot())),
                ("reservations.blocked_dates.on_date", json!([])),
            ],
        ))
        .expect("a refusal is an output, not a fault");
        assert_eq!(refusal_code(&out), "reservations.phone_required");
        assert!(out.operations.is_empty(), "a refusal must not carry operations");
    }

    #[test]
    fn create_missing_email_is_refused_only_when_the_settings_ask_for_it() {
        let mut payload = base_payload();
        payload["guest_phone"] = json!("600123123");
        let requires = create_reservation_pure(create_input(
            payload.clone(),
            vec![
                ("reservations.settings.get", settings_read(json!({ "require_email": 1 }))),
                ("reservations.slots.count_for", slots_read(full_day_slot())),
                ("reservations.blocked_dates.on_date", json!([])),
            ],
        ))
        .unwrap();
        assert_eq!(refusal_code(&requires), "reservations.email_required");

        let lax = create_reservation_pure(create_input(payload, healthy_reads())).unwrap();
        assert_eq!(refusal_code(&lax), "", "no flags on: an email-less booking is fine");
    }

    #[test]
    fn create_refusal_names_the_party_size_limit() {
        let mut payload = base_payload();
        payload["party_size"] = json!(40); // settings max: 20
        let out = create_reservation_pure(create_input(payload, healthy_reads())).unwrap();
        assert_eq!(refusal_code(&out), "reservations.party_size_exceeded");
    }

    #[test]
    fn create_refusal_names_the_blocked_date() {
        let reads = vec![
            ("reservations.settings.get", settings_read(json!({}))),
            ("reservations.slots.count_for", slots_read(full_day_slot())),
            (
                "reservations.blocked_dates.on_date",
                json!([{ "id": "b1", "date": "2026-08-20", "reason": "staff party",
                        "is_full_day": 1, "blocked_from": Value::Null, "blocked_until": Value::Null }]),
            ),
        ];
        let out = create_reservation_pure(create_input(base_payload(), reads)).unwrap();
        assert_eq!(refusal_code(&out), "reservations.date_blocked");
    }

    #[test]
    fn create_refusal_names_the_day_without_service() {
        // No slot that day at all…
        let reads = vec![
            ("reservations.settings.get", settings_read(json!({}))),
            ("reservations.slots.count_for", slots_read(json!([]))),
            ("reservations.blocked_dates.on_date", json!([])),
        ];
        let out = create_reservation_pure(create_input(base_payload(), reads)).unwrap();
        assert_eq!(refusal_code(&out), "reservations.no_service_day");

        // …and a slot that day which does not CONTAIN the requested time.
        let lunch_only = json!([{
            "timeslot_id": "s-lunch", "start_time": "13:00:00", "end_time": "15:00:00",
            "max_reservations": 3, "reserved": 0, "available": 3
        }]);
        let reads = vec![
            ("reservations.settings.get", settings_read(json!({}))),
            ("reservations.slots.count_for", slots_read(lunch_only)),
            ("reservations.blocked_dates.on_date", json!([])),
        ];
        let out = create_reservation_pure(create_input(base_payload(), reads)).unwrap();
        assert_eq!(refusal_code(&out), "reservations.no_service_day");
    }

    #[test]
    fn create_refusal_names_the_full_slot() {
        let full = json!([{
            "timeslot_id": "s-dinner", "start_time": "20:00:00", "end_time": "23:00:00",
            "max_reservations": 2, "reserved": 2, "available": 0
        }]);
        let reads = vec![
            ("reservations.settings.get", settings_read(json!({}))),
            ("reservations.slots.count_for", slots_read(full)),
            ("reservations.blocked_dates.on_date", json!([])),
        ];
        let out = create_reservation_pure(create_input(base_payload(), reads)).unwrap();
        assert_eq!(refusal_code(&out), "reservations.no_capacity");
    }

    #[test]
    fn create_refuses_to_decide_without_its_reads() {
        // The runtime did not deliver the reads → fail closed, never fall back to the payload.
        let mut bare = create_input(base_payload(), Vec::new());
        bare["context"]["reads"] = json!({});
        let out = create_reservation_pure(bare).unwrap();
        assert_eq!(refusal_code(&out), "reservations.reads_unavailable");
    }

    #[test]
    fn create_with_everything_healthy_still_emits_the_gated_insert() {
        let out = create_reservation_pure(create_input(base_payload(), healthy_reads())).unwrap();
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations.len(), 1);
        assert_eq!(out.operations[0].command, "reservations._create_gated");
        assert_eq!(out.operations[0].params.get("time"), Some(&json!("21:00:00")));
    }

    #[test]
    fn manifest_preloads_the_three_reads_the_create_handler_decides_from() {
        let m = manifest();
        let cmd = &m["commands"]["reservations.reservations.create"];
        let reads = cmd["reads"].as_array().expect("create declares its reads");
        let find = |q: &str| {
            reads
                .iter()
                .find(|r| r["query"] == q)
                .unwrap_or_else(|| panic!("create must read `{q}`"))
        };
        assert_eq!(
            find("reservations.settings.get")["required"],
            json!(true),
            "the settings the handler decides with must be a required read"
        );
        assert_eq!(find("reservations.slots.count_for")["params"]["date"], json!("payload.date"));
        assert_eq!(find("reservations.slots.count_for")["required"], json!(true));
        assert_eq!(
            find("reservations.blocked_dates.on_date")["params"]["date"],
            json!("payload.date")
        );
        assert_eq!(find("reservations.blocked_dates.on_date")["required"], json!(true));
    }

    #[test]
    fn manifest_preloads_the_reservation_row_for_set_status_and_lets_the_handler_emit() {
        let m = manifest();
        let cmd = &m["commands"]["reservations.reservations.set_status"];
        let reads = cmd["reads"].as_array().expect("set_status declares `reads`");
        let read = reads
            .iter()
            .find(|r| r["query"] == "reservations.reservations.get")
            .expect("reads the reservation row by id");
        assert_eq!(read["params"]["reservation_id"], json!("payload.reservation_id"));
        // The handler owns the event now: a declared `emit` would queue it TWICE per transition
        // (once with the bare caller payload, once enriched).
        assert!(
            cmd.get("emit").map(|e| e.as_array().map(|a| a.is_empty()).unwrap_or(true)).unwrap_or(true),
            "set_status must not also declare `emit` for status_changed"
        );
        // Still declared at module level, so hub#240 lets the handler emit it.
        assert!(m["events"]["emits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e == "reservations.reservation.status_changed"));
    }

    // ── reservations#50: WHOSE table is it? ──────────────────────────────────────
    //
    // The mirror of appointments#140 (`cancel`) and appointments#142 (`reschedule`). A change
    // asked FOR the guest — the WhatsApp automation acting on her behalf — carries the id of the
    // reservation and nothing else, and the handler never looked at whose reservation it was: any
    // reservation id that reached the door was managed. `reservations.reservations.list` filters
    // `guest_phone` with `like`, so guessing one is not the hard part.

    /// A reservation of `customer_id`, in `status`. The counter's walk-ins have no customer at
    /// all (`customer_id` null), which is a row that belongs to NOBODY on the customer channel.
    fn row_of(customer_id: Value, status: &str) -> Value {
        json!([{
            "id": "r-ana", "customer_id": customer_id, "guest_name": "Ana",
            "guest_phone": "+34600111222", "guest_email": "",
            "date": "2026-08-20", "time": "21:00:00", "party_size": 4,
            "duration_minutes": 90, "table_id": "t1", "status": status,
        }])
    }

    fn reads_of(rows: Value) -> Option<Value> {
        Some(json!({ "reservations.reservations.get": rows }))
    }

    #[test]
    fn set_status_on_the_customer_channel_refuses_a_reservation_THAT_IS_NOT_HERS() {
        // THE case: the row belongs to `c-ana` and `c-bob` is the one asking. Cancelling it is a
        // legal transition, so nothing else in the handler would have stopped it.
        let out = set_status_pure(input(
            json!({
                "reservation_id": "r-ana", "status": "cancelled",
                "channel": "customer", "customer_id": "c-bob",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("a refusal is an output, not a fault");
        assert_eq!(refusal_code(&out), "reservations.customer_mismatch");
        assert!(out.operations.is_empty(), "somebody else's table must not be touched");
        assert!(out.events.is_empty(), "and nothing may be announced about it");
    }

    #[test]
    fn set_status_on_the_customer_channel_goes_on_when_the_reservation_is_hers() {
        let out = set_status_pure(input(
            json!({
                "reservation_id": "r-ana", "status": "cancelled",
                "channel": "customer", "customer_id": "c-ana",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("her own reservation");
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations[0].command, "reservations._apply_status");
    }

    #[test]
    fn set_status_on_the_customer_channel_without_a_customer_id_is_a_payload_fault() {
        // Fails CLOSED and LOUDLY: a `channel: customer` that names nobody is an external
        // channel wired wrong, not a sentence to show a guest.
        let err = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "cancelled", "channel": "customer" }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect_err("a broken payload is a fault, not a refusal");
        assert!(err.contains("customer_id"), "{err}");
    }

    #[test]
    fn set_status_by_the_counter_still_touches_any_reservation() {
        // The regression this guard must NOT cause: the dining room is the staff's own. No
        // channel = staff, and staff never says who it is asking for.
        let out = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "seated" }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("the counter seats whoever sits down");
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations[0].command, "reservations._apply_status");
    }

    #[test]
    fn a_customer_id_sent_on_the_staff_channel_is_not_an_identity_claim() {
        // Reading it as one would let a mistyped id refuse the receptionist her own work.
        let out = set_status_pure(input(
            json!({
                "reservation_id": "r-ana", "status": "seated",
                "channel": "staff", "customer_id": "c-bob",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("staff is not acting on anybody's behalf");
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations[0].command, "reservations._apply_status");
    }

    #[test]
    fn set_status_refuses_a_channel_that_is_neither_staff_nor_customer() {
        let err = set_status_pure(input(
            json!({ "reservation_id": "r-ana", "status": "seated", "channel": "kitchen" }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect_err("an unknown channel is a payload fault");
        assert!(err.contains("kitchen"), "{err}");
    }

    #[test]
    fn set_status_asks_WHOSE_reservation_it_is_before_the_state_machine() {
        // Order matters and is the whole point: a stranger holding an id that is not hers gets
        // the SAME answer whatever the row is doing — «not yours». If the state machine ran
        // first, the refusals would tell her whether that id exists and what state it is in.
        let out = set_status_pure(input(
            json!({
                "reservation_id": "r-ana", "status": "completed",
                "channel": "customer", "customer_id": "c-bob",
            }),
            // `pending → completed` is illegal: the state machine has an answer ready for it.
            reads_of(row_of(json!("c-ana"), "pending")),
        ))
        .expect("a refusal is an output");
        assert_eq!(
            refusal_code(&out),
            "reservations.customer_mismatch",
            "identity is decided BEFORE the state machine, or the refusal leaks the row's state"
        );
    }

    #[test]
    fn set_status_on_the_customer_channel_refuses_a_walk_in_that_belongs_to_nobody() {
        // A table the counter typed with no customer attached matches nobody: the asking id is
        // non-empty by the check above, so an empty link can never equal it.
        for orphan in [json!(null), json!("")] {
            let out = set_status_pure(input(
                json!({
                    "reservation_id": "r-ana", "status": "cancelled",
                    "channel": "customer", "customer_id": "c-bob",
                }),
                reads_of(row_of(orphan.clone(), "confirmed")),
            ))
            .expect("a refusal is an output");
            assert_eq!(
                refusal_code(&out),
                "reservations.customer_mismatch",
                "a walk-in ({orphan}) is nobody's to manage"
            );
        }
    }

    #[test]
    fn set_status_on_the_customer_channel_refuses_when_the_row_never_arrived() {
        // The read is graceful by contract (#13) and the staff path degrades to the SQL gate.
        // The customer path cannot: with no row there is nothing to compare, so it fails closed.
        let out = set_status_pure(input(
            json!({
                "reservation_id": "r-ana", "status": "cancelled",
                "channel": "customer", "customer_id": "c-bob",
            }),
            None,
        ))
        .expect("a refusal is an output");
        assert_eq!(refusal_code(&out), "reservations.customer_mismatch");
        assert!(out.operations.is_empty());
    }


    // ── reservations#50, the other door: `update` ────────────────────────────────
    //
    // `update` was a Tier 0 declarative command: payload → SQL, and the SQL's only question was
    // «does this row exist in this hub». It now goes through the handler for ONE reason — so it
    // can ask the SAME guard `set_status` asks. The availability gate it always had (capacity,
    // advance window, blocked days, active slot) did not move: it is still the SQL of
    // `reservations._apply_update`, still inside the transaction, still `expect_rows`.

    /// Every field the SQL of `_apply_update` binds. A field the handler forgets to carry binds
    /// NULL, and `COALESCE(:field, field)` reads that as «leave it as it was» — an edit that
    /// silently does nothing, which is the failure this list exists to prevent.
    const APPLY_UPDATE_BINDS: [&str; 10] = [
        "guest_name", "guest_phone", "guest_email", "date", "time",
        "party_size", "duration_minutes", "table_id", "notes", "internal_notes",
    ];

    #[test]
    fn update_on_the_customer_channel_refuses_a_reservation_THAT_IS_NOT_HERS() {
        let out = update_reservation_pure(input(
            json!({
                "reservation_id": "r-ana", "party_size": 8,
                "channel": "customer", "customer_id": "c-bob",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("a refusal is an output, not a fault");
        assert_eq!(refusal_code(&out), "reservations.customer_mismatch");
        assert!(out.operations.is_empty(), "somebody else's table must not be edited");
        assert!(out.events.is_empty());
    }

    #[test]
    fn update_on_the_customer_channel_goes_on_when_the_reservation_is_hers() {
        let out = update_reservation_pure(input(
            json!({
                "reservation_id": "r-ana", "party_size": 8,
                "channel": "customer", "customer_id": "c-ana",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("her own reservation");
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations[0].command, "reservations._apply_update");
        assert_eq!(out.operations[0].params.get("party_size"), Some(&json!(8)));
    }

    #[test]
    fn update_on_the_customer_channel_without_a_customer_id_is_a_payload_fault() {
        let err = update_reservation_pure(input(
            json!({ "reservation_id": "r-ana", "party_size": 8, "channel": "customer" }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect_err("a broken payload is a fault, not a refusal");
        assert!(err.contains("customer_id"), "{err}");
    }

    #[test]
    fn update_by_the_counter_still_edits_any_reservation() {
        // The business regression this guard must NOT cause.
        let out = update_reservation_pure(input(
            json!({ "reservation_id": "r-ana", "party_size": 8, "internal_notes": "VIP" }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("the dining room is the counter's");
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations[0].command, "reservations._apply_update");
    }

    #[test]
    fn update_by_the_counter_needs_no_reservation_row_at_all() {
        // The read is graceful and the staff path does not depend on it: the SQL gate inside the
        // transaction stays the authority, exactly as before this handler existed.
        let out = update_reservation_pure(input(
            json!({ "reservation_id": "r-ana", "party_size": 8 }),
            None,
        ))
        .expect("staff edits do not wait for the read");
        assert_eq!(refusal_code(&out), "");
        assert_eq!(out.operations[0].command, "reservations._apply_update");
    }

    #[test]
    fn a_customer_id_sent_on_the_staff_update_channel_is_not_an_identity_claim() {
        let out = update_reservation_pure(input(
            json!({
                "reservation_id": "r-ana", "party_size": 8,
                "channel": "staff", "customer_id": "c-bob",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("staff is not acting on anybody's behalf");
        assert_eq!(refusal_code(&out), "");
    }

    #[test]
    fn update_refuses_a_channel_that_is_neither_staff_nor_customer() {
        let err = update_reservation_pure(input(
            json!({ "reservation_id": "r-ana", "party_size": 8, "channel": "kitchen" }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect_err("an unknown channel is a payload fault");
        assert!(err.contains("kitchen"), "{err}");
    }

    #[test]
    fn update_on_the_customer_channel_refuses_a_walk_in_that_belongs_to_nobody() {
        for orphan in [json!(null), json!("")] {
            let out = update_reservation_pure(input(
                json!({
                    "reservation_id": "r-ana", "party_size": 8,
                    "channel": "customer", "customer_id": "c-bob",
                }),
                reads_of(row_of(orphan.clone(), "confirmed")),
            ))
            .expect("a refusal is an output");
            assert_eq!(refusal_code(&out), "reservations.customer_mismatch", "orphan {orphan}");
        }
    }

    #[test]
    fn update_on_the_customer_channel_refuses_when_the_row_never_arrived() {
        let out = update_reservation_pure(input(
            json!({
                "reservation_id": "r-ana", "party_size": 8,
                "channel": "customer", "customer_id": "c-bob",
            }),
            None,
        ))
        .expect("a refusal is an output");
        assert_eq!(refusal_code(&out), "reservations.customer_mismatch");
        assert!(out.operations.is_empty());
    }

    #[test]
    fn update_asks_WHOSE_reservation_it_is_before_anything_it_could_leak() {
        // Same ordering rule as `set_status`: whoever is asking with an id that is not theirs
        // gets «not yours» and NO operation, so the SQL gate never runs on that row and its
        // rejection cannot be read as an oracle either.
        let out = update_reservation_pure(input(
            json!({
                "reservation_id": "r-ana", "table_id": "t9", "internal_notes": "x",
                "channel": "customer", "customer_id": "c-bob",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("a refusal is an output");
        assert_eq!(
            refusal_code(&out),
            "reservations.customer_mismatch",
            "identity comes first: a foreign row is not even told which of its fields are staff-only"
        );
    }

    #[test]
    fn update_on_the_customer_channel_refuses_the_fields_only_the_restaurant_writes() {
        // Opening the customer door without this would hand the guest her own table assignment
        // and the restaurant's private notes — a new hole dug by the change that closes another.
        for (field, value) in [
            ("table_id", json!("t9")),
            ("table_id", json!("")), // the «unassign» sentinel is an assignment too
            ("internal_notes", json!("free bottle for this one")),
        ] {
            let mut payload = json!({
                "reservation_id": "r-ana", "channel": "customer", "customer_id": "c-ana",
            });
            payload[field] = value.clone();
            let out = update_reservation_pure(input(
                payload,
                reads_of(row_of(json!("c-ana"), "confirmed")),
            ))
            .expect("a refusal is an output");
            assert_eq!(
                refusal_code(&out),
                "reservations.staff_only_field",
                "{field} = {value} on her OWN reservation"
            );
            assert!(out.operations.is_empty(), "{field} must not reach the SQL");
        }
    }

    #[test]
    fn update_on_the_customer_channel_still_changes_what_the_booking_IS() {
        // What a guest legitimately asks for by message: another day, another time, more people,
        // her phone, a note about the highchair.
        let out = update_reservation_pure(input(
            json!({
                "reservation_id": "r-ana", "date": "2026-08-21", "time": "20:30:00",
                "party_size": 6, "guest_phone": "+34600999888", "notes": "highchair",
                "channel": "customer", "customer_id": "c-ana",
            }),
            reads_of(row_of(json!("c-ana"), "confirmed")),
        ))
        .expect("her own booking");
        assert_eq!(refusal_code(&out), "");
        let p = &out.operations[0].params;
        assert_eq!(p.get("date"), Some(&json!("2026-08-21")));
        assert_eq!(p.get("party_size"), Some(&json!(6)));
        assert_eq!(p.get("notes"), Some(&json!("highchair")));
    }

    #[test]
    fn update_carries_every_bind_the_sql_reads_and_leaves_the_untouched_ones_null() {
        // A missing bind and an explicit NULL are the same thing for the driver (both `DynNull`),
        // which is what `COALESCE(:field, field)` needs: «not sent» = «leave it as it was».
        let out = update_reservation_pure(input(
            json!({ "reservation_id": "r-ana", "time": "20:30:00" }),
            None,
        ))
        .expect("a partial edit is the normal case");
        let p = &out.operations[0].params;
        assert_eq!(p.get("reservation_id"), Some(&json!("r-ana")));
        for bind in APPLY_UPDATE_BINDS {
            let got = p.get(bind).unwrap_or_else(|| panic!("`{bind}` is not carried to the SQL"));
            if bind == "time" {
                assert_eq!(got, &json!("20:30:00"));
            } else {
                assert_eq!(got, &json!(null), "`{bind}` was not sent, so it must bind NULL");
            }
        }
    }

    #[test]
    fn update_ignores_anything_the_caller_makes_up_beyond_the_binds() {
        // `additionalProperties: false` already refuses it at the door; the handler does not
        // forward it either, so a param that is not a bind cannot reach the SQL by a second path.
        let out = update_reservation_pure(input(
            json!({ "reservation_id": "r-ana", "hub_id": "other-hub", "status": "completed" }),
            None,
        ))
        .expect("staff edit");
        let p = &out.operations[0].params;
        assert!(p.get("hub_id").is_none(), "the hub is the runtime's, never the payload's");
        assert!(p.get("status").is_none(), "status changes have their own door");
        assert_eq!(p.len(), APPLY_UPDATE_BINDS.len() + 1, "reservation_id + the binds, nothing else");
    }

    // ── the guard is ONE rule in ONE place, and both doors ask it ────────────────

    fn production_source() -> String {
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
            .expect("the handler can read its own source");
        let cut = src.find("#[cfg(test)]").expect("the test module is still there");
        src[..cut].to_string()
    }

    /// The body of a top-level `fn`, cut at the next one.
    fn body_of(src: &str, signature: &str) -> String {
        let start = src.find(signature).unwrap_or_else(|| panic!("`{signature}` is gone"));
        let rest = &src[start + signature.len()..];
        let end = ["\npub fn ", "\nfn "]
            .iter()
            .filter_map(|marker| rest.find(marker))
            .min()
            .unwrap_or(rest.len());
        rest[..end].to_string()
    }

    #[test]
    fn both_customer_facing_doors_ask_the_SAME_guard_and_the_rule_lives_in_ONE_place() {
        // reservations#50 is the third time this rule is written (appointments#140 for `cancel`,
        // appointments#142 for `reschedule`), and the lesson of the second one was that two
        // copies of «is this yours» drift apart until one of them is open again. So: exactly one
        // place mints the refusal, and every door reaches it by CALLING that place.
        let src = production_source();
        assert_eq!(
            src.matches("\"reservations.customer_mismatch\"").count(),
            1,
            "the mismatch refusal is minted in exactly one place — a second copy is a second rule"
        );
        for door in ["pub fn set_status_pure", "pub fn update_reservation_pure"] {
            assert!(
                body_of(&src, door).contains("customer_identity_refusal("),
                "`{door}` must ASK the shared guard, not re-implement it"
            );
        }
    }

    #[test]
    fn the_guard_reads_the_owner_from_the_ROW_and_never_from_the_payload() {
        // The mutant this kills: comparing `payload.customer_id` with itself (or with anything
        // else the caller sent) is a guard that always passes. The authority is the row the
        // runtime pre-loaded, which is why the check sits AFTER the read.
        let body = body_of(&production_source(), "fn customer_identity_refusal");
        assert!(
            body.contains("row.get(\"customer_id\")"),
            "the owner comes from the reservation row: {body}"
        );
    }

    #[test]
    fn manifest_preloads_the_reservation_row_for_update_too() {
        let m = manifest();
        let cmd = &m["commands"]["reservations.reservations.update"];
        assert_eq!(
            cmd["handler"]["function"], json!("update_reservation"),
            "update goes through the handler so it can ask the identity guard"
        );
        let read = cmd["reads"]
            .as_array()
            .expect("update declares `reads`")
            .iter()
            .find(|r| r["query"] == "reservations.reservations.get")
            .expect("reads the reservation row by id");
        assert_eq!(read["params"]["reservation_id"], json!("payload.reservation_id"));
    }

    #[test]
    fn the_update_gate_keeps_its_own_refusal_and_its_own_sql() {
        // What did NOT move: the availability gate of reservations#14 and the translatable
        // rejection it raises. It now hangs off the private command the handler delegates to.
        let m = manifest();
        let gated = &m["commands"]["reservations._apply_update"];
        assert_eq!(gated["sql"], json!(["commands/reservation_update.sql"]));
        assert_eq!(gated["expect_rows"]["op"], json!("min"));
        assert_eq!(gated["expect_rows"]["n"], json!(1));
        assert_eq!(gated["expect_rows"]["error"], json!("reservations.update_rejected"));
        assert_eq!(gated["permission"], json!("reservations.change_reservation"));
        assert!(
            m["commands"]["reservations.reservations.update"].get("sql").is_none(),
            "the public door no longer runs SQL by itself"
        );
    }

    #[test]
    fn both_customer_facing_schemas_declare_who_is_asking() {
        // The mechanical half of the guard: a door whose schema has no `channel`/`customer_id`
        // cannot be asked on behalf of a guest at all — `additionalProperties: false` drops them
        // — so the guard would sit there looking armed and never fire.
        for door in ["reservation_set_status", "reservation_update"] {
            let raw = std::fs::read_to_string(format!(
                "{}/../schemas/{door}.json",
                env!("CARGO_MANIFEST_DIR")
            ))
            .unwrap_or_else(|_| panic!("schemas/{door}.json"));
            let s: Value = serde_json::from_str(&raw).expect("the schema parses");
            assert_eq!(s["additionalProperties"], json!(false), "{door}");
            assert_eq!(
                s["properties"]["channel"]["enum"],
                json!(["staff", "customer"]),
                "{door} must name both channels"
            );
            assert_eq!(
                s["properties"]["channel"]["default"], json!("staff"),
                "{door}: no channel means the counter, which is what the screen sends"
            );
            assert_eq!(
                s["properties"]["customer_id"]["type"], json!("string"),
                "{door} must be able to say WHO is asking"
            );
        }
    }

}
