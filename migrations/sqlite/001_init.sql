-- Reservations · esquema inicial (SQLite). Portado fielmente de old_modules/m_reservations/models.py.
-- Modelos: ReservationSettings (config por hub), TimeSlot (ventanas horarias por día),
-- BlockedDate (cierres/festivos), Reservation (reserva individual con máquina de estados)
-- y WaitlistEntry (lista de espera para slots llenos).
-- Contrato de fila estándar de hub-next (§2.5): hub_id + soft-delete + auditoría en cada tabla.
--
-- NOTA: el legacy usaba el prefijo de tabla 'table_reservations_' y MODULE_ID 'table_reservations'.
-- En hub-next el módulo se llama 'reservations' y las tablas usan el prefijo 'reservations_'.

-- Config de reservas por hub (1 fila por hub — único por hub_id).
CREATE TABLE IF NOT EXISTS reservations_settings (
    id                       TEXT PRIMARY KEY,
    hub_id                   TEXT NOT NULL,
    time_slot_duration       INTEGER NOT NULL DEFAULT 30,
    min_party_size           INTEGER NOT NULL DEFAULT 1,
    max_party_size           INTEGER NOT NULL DEFAULT 20,
    min_advance_hours        INTEGER NOT NULL DEFAULT 1,
    max_advance_days         INTEGER NOT NULL DEFAULT 30,
    auto_confirm             INTEGER NOT NULL DEFAULT 0,
    require_phone            INTEGER NOT NULL DEFAULT 1,
    require_email            INTEGER NOT NULL DEFAULT 0,
    no_show_window_minutes   INTEGER NOT NULL DEFAULT 15,
    default_duration_minutes INTEGER NOT NULL DEFAULT 120,
    send_confirmation_email  INTEGER NOT NULL DEFAULT 0,
    send_reminder_email      INTEGER NOT NULL DEFAULT 0,
    reminder_hours_before    INTEGER NOT NULL DEFAULT 24,
    is_deleted               INTEGER NOT NULL DEFAULT 0,
    deleted_at               TEXT,
    created_by               TEXT,
    created_at               TEXT NOT NULL,
    updated_by               TEXT,
    updated_at               TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_settings_hub ON reservations_settings (hub_id);
CREATE INDEX        IF NOT EXISTS idx_reservations_settings_hub ON reservations_settings (hub_id, is_deleted);

-- Ventanas horarias disponibles por día de la semana (0=lunes … 6=domingo).
CREATE TABLE IF NOT EXISTS reservations_timeslot (
    id               TEXT PRIMARY KEY,
    hub_id           TEXT NOT NULL,
    day_of_week      INTEGER NOT NULL,        -- 0..6 (lunes..domingo)
    start_time       TEXT NOT NULL,           -- ISO HH:MM:SS
    end_time         TEXT NOT NULL,           -- ISO HH:MM:SS
    max_reservations INTEGER NOT NULL DEFAULT 10,
    is_active        INTEGER NOT NULL DEFAULT 1,
    is_deleted       INTEGER NOT NULL DEFAULT 0,
    deleted_at       TEXT,
    created_by       TEXT,
    created_at       TEXT NOT NULL,
    updated_by       TEXT,
    updated_at       TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_timeslot_per_hub
    ON reservations_timeslot (hub_id, day_of_week, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_reservations_timeslot_hub ON reservations_timeslot (hub_id, is_deleted);
CREATE INDEX IF NOT EXISTS ix_reservations_timeslot_active ON reservations_timeslot (hub_id, is_active);

-- Fechas/horas bloqueadas (festivos, cierres). is_full_day=1 bloquea el día entero;
-- si es parcial, blocked_from/blocked_until acotan la franja.
CREATE TABLE IF NOT EXISTS reservations_blockeddate (
    id            TEXT PRIMARY KEY,
    hub_id        TEXT NOT NULL,
    date          TEXT NOT NULL,              -- ISO YYYY-MM-DD
    reason        TEXT NOT NULL DEFAULT '',
    is_full_day   INTEGER NOT NULL DEFAULT 1,
    blocked_from  TEXT,                        -- ISO HH:MM:SS o NULL
    blocked_until TEXT,                        -- ISO HH:MM:SS o NULL
    is_deleted    INTEGER NOT NULL DEFAULT 0,
    deleted_at    TEXT,
    created_by    TEXT,
    created_at    TEXT NOT NULL,
    updated_by    TEXT,
    updated_at    TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_reservations_blockeddate_per_hub
    ON reservations_blockeddate (hub_id, date, blocked_from);
CREATE INDEX IF NOT EXISTS idx_reservations_blockeddate_hub ON reservations_blockeddate (hub_id, is_deleted);
CREATE INDEX IF NOT EXISTS ix_reservations_blockeddate_date ON reservations_blockeddate (hub_id, date);

-- Reserva individual. customer_id y table_id son referencias cross-módulo (customers/tables);
-- no hay FK porque esos módulos pueden no estar cargados — se resuelven por contrato.
-- status: pending|confirmed|seated|completed|cancelled|no_show (máquina de estados → WASM-TODO).
CREATE TABLE IF NOT EXISTS reservations_reservation (
    id                  TEXT PRIMARY KEY,
    hub_id              TEXT NOT NULL,
    customer_id         TEXT,
    guest_name          TEXT NOT NULL,
    guest_phone         TEXT NOT NULL DEFAULT '',
    guest_email         TEXT NOT NULL DEFAULT '',
    date                TEXT NOT NULL,          -- ISO YYYY-MM-DD
    time                TEXT NOT NULL,          -- ISO HH:MM:SS
    party_size          INTEGER NOT NULL DEFAULT 2,
    duration_minutes    INTEGER NOT NULL DEFAULT 120,
    table_id            TEXT,
    status              TEXT NOT NULL DEFAULT 'pending',
    notes               TEXT NOT NULL DEFAULT '',
    internal_notes      TEXT NOT NULL DEFAULT '',
    confirmed_at        TEXT,
    seated_at           TEXT,
    completed_at        TEXT,
    cancelled_at        TEXT,
    cancellation_reason TEXT NOT NULL DEFAULT '',
    is_deleted          INTEGER NOT NULL DEFAULT 0,
    deleted_at          TEXT,
    created_by          TEXT,
    created_at          TEXT NOT NULL,
    updated_by          TEXT,
    updated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_reservation_hub ON reservations_reservation (hub_id, is_deleted);
CREATE INDEX IF NOT EXISTS ix_reservations_reservation_date_status ON reservations_reservation (hub_id, date, status);
CREATE INDEX IF NOT EXISTS ix_reservations_reservation_phone ON reservations_reservation (hub_id, guest_phone);

-- Lista de espera para slots completos. is_converted=1 cuando se transforma en reserva real
-- (reservation_id apunta a la reserva creada). La promoción auto desde waitlist → WASM-TODO.
CREATE TABLE IF NOT EXISTS reservations_waitlistentry (
    id             TEXT PRIMARY KEY,
    hub_id         TEXT NOT NULL,
    customer_id    TEXT,
    guest_name     TEXT NOT NULL,
    guest_phone    TEXT NOT NULL,
    guest_email    TEXT NOT NULL DEFAULT '',
    date           TEXT NOT NULL,              -- ISO YYYY-MM-DD
    preferred_time TEXT NOT NULL,              -- ISO HH:MM:SS
    party_size     INTEGER NOT NULL DEFAULT 2,
    notes          TEXT NOT NULL DEFAULT '',
    is_contacted   INTEGER NOT NULL DEFAULT 0,
    is_converted   INTEGER NOT NULL DEFAULT 0,
    reservation_id TEXT,
    is_deleted     INTEGER NOT NULL DEFAULT 0,
    deleted_at     TEXT,
    created_by     TEXT,
    created_at     TEXT NOT NULL,
    updated_by     TEXT,
    updated_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_reservations_waitlistentry_hub ON reservations_waitlistentry (hub_id, is_deleted);
CREATE INDEX IF NOT EXISTS ix_reservations_waitlistentry_date ON reservations_waitlistentry (hub_id, date, is_converted);
