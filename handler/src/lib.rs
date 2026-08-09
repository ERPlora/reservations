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
//!   el `:now` del host — el cliente ya no puede falsificarlos.
//! * `waitlist_update` — actualización de lista de espera; si el payload pide
//!   `is_converted=1`, hace la **promoción atómica** waitlist→reserva (§3):
//!   `reservations._waitlist_promote` crea la reserva LEYENDO los datos de la
//!   propia entrada (autoridad = fila, no el cliente), re-aplica el gate de
//!   disponibilidad (bloqueos/franja/capacidad) y enlaza `is_converted=1` +
//!   `reservation_id` en la misma transacción; cualquier fallo revierte ambos.
//!
//! Ids: el host pasa `context.new_ids` (autoridad de ids); el guest solo los
//! reparte (`new_ids[0]` = nueva reserva). El guest no toca la BD ni genera ids.

use erplora_guest_sdk::{Event, Operation, Output};
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

    let mut p = Map::new();
    p.insert("reservation_id".into(), json!(reservation_id));
    p.insert("status".into(), json!(status));
    p.insert(
        "cancellation_reason".into(),
        if status == "cancelled" {
            payload.get("cancellation_reason").cloned().unwrap_or(Value::Null)
        } else {
            Value::Null
        },
    );

    Ok(Output {
        operations: vec![Operation::sql("reservations._apply_status", p)],
        events: vec![], // reservations.reservation.status_changed lo emite el command (declarado)
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
