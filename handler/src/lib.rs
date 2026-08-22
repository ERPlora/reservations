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
    let row = input
        .pointer("/context/reads/reservations.reservations.get/0")
        .cloned()
        .unwrap_or(Value::Null);

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
}
