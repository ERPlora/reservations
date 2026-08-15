# Reservations — Overview

## What this module does

Reservations is the planning layer that comes before service in the dining room. It defines **when
and for how many people** you accept bookings, records each reservation with its own state machine,
blocks dates you are closed, and keeps a **waitlist** for people who did not fit in a full slot —
which can later be promoted into a real reservation.

## What this module does NOT do

- **It does not seat anybody.** Occupancy, sessions, transfers and splits belong to `tables`. A
  reservation carries at most a table reference.
- **It does not hold the table on the floor plan.** Painting a table as reserved is a **hold**, and
  `tables` decides that.
- **It does not take money.** No deposits, no prepayments, no cancellation fees.
- **It does not send anything.** Confirmation and reminder settings exist, but no email, SMS or
  WhatsApp is sent by this module.
- **It does not run any scheduled task.** Releasing unconfirmed bookings and sending reminders are
  designed but **not implemented**.
- **It does not sync with external calendars.** That belongs to a satellite module, and this module
  is last in line for it — see [concepts.md](concepts.md).

## It is not the appointment diary

Two modules book time and they are not interchangeable:

| | **Reservations** | **Appointments** |
|---|---|---|
| Books | A **table** for a party, at a restaurant | A **service** with a **professional** |
| Cares about | Party size, slot capacity, the dining room | Duration, overlap per professional |
| Typical business | Restaurant, bar | Salon, clinic, workshop |

## Modules it connects to

**Depends on `tables` and `customers`** — both are installed with it. Even so, the customer and the
table are referenced **by contract, without foreign keys**, because those modules may not be loaded
at the moment the row is read.

**Events it emits**

| Event | When |
|---|---|
| `reservations.reservation.created` | a booking is made — **emitted by the handler**, so it is not visible in the manifest |
| `reservations.reservation.updated` | booking details change |
| `reservations.reservation.status_changed` | it advances, is cancelled or marked a no-show |
| `reservations.reservation.deleted` | it is deleted |
| `reservations.timeslot.created` / `.deleted` | the available windows change |
| `reservations.blocked_date.created` / `.deleted` | blocked dates change |
| `reservations.waitlist.created` / `.updated` / `.deleted` | the waitlist changes |
| `reservations.settings.updated` | the settings are saved |

Two traps for anyone writing a listener: **the creation event is not declared in the manifest** (the
handler emits it), and **there is no cancellation event** — a cancellation travels inside
`status_changed`, so look at the status, not the event name.

**Events it listens to** — none.

## The lifecycle

```
pending ──▶ confirmed ──▶ seated ──▶ completed
   └────────────┴──▶ cancelled / no_show
```

`pending` is a starting state only: nothing can go **back** to it.

## Where its numbers come from

- **Dates and times are naive** — no timezone attached. That is why external calendar sync is blocked
  for this module.
- **Days of the week are 0 = Monday … 6 = Sunday.**
- **Times are `HH:MM:SS`** once normalised.
