# Reservations — Screens

The module contributes three tabs to the hub navigation — **Reservations**, **Waitlist** and
**Availability** — plus a settings tab the shell generates from the declarative settings block.

## Reservations

The book opens on **today's service** — today on the business clock (the hub's timezone, not the
device's) — ordered by time, 50 rows per page (`reservations.reservations.list`). Requires
`reservations.view_reservation`.

A bar above the list answers the three questions of the shift for the day on screen:

- **Covers**: the guests committed that day (sum of party sizes), and the **bookings** they come
  in (`reservations.day.summary`). Cancelled and no-show bookings do not count; seated and
  completed ones do.
- **Next slot**: on today, the first time slot that has not ended yet (a slot in progress still
  counts), with the tables left or **Full**; on any other day, its first slot. It reads **No more
  service today** after the last slot, **No service this day** when the weekday has no active slot
  and **Closed this day** when the date is blocked whole (`reservations.slots.count_for`,
  `reservations.blocked_dates.on_date`).
- **Day stepper**: previous day · date · next day, and **Today** when the book is on another day.
  The list and the figures follow the day, and refresh live when a booking is created, edited,
  moved through its states or deleted.

**Searching** a guest name or phone looks through the **whole book**, not only the day on screen:
the guest who booked next Friday is found from today. Clearing the search (or **Clear filters**)
puts the book back on the day it was showing.

Open one for its full detail: the guest, the party, the date and time, the table, the notes and the
timestamps of each transition.

### Take a reservation

1. Enter the **guest name**, the **date**, the **time** and the **party size**.
2. Optionally attach a customer record, a phone, an email, a table, a duration and notes.
3. Save.

Before writing, the hub checks — atomically, inside the transaction — that:

- the party size is within the configured minimum and maximum;
- the date and time fall inside the **advance window** (not too soon, not too far ahead);
- the date is not **blocked**;
- there is an **active time slot** for that weekday covering that time;
- the slot still has **capacity**.

If everything passes, the booking is created `pending` — or `confirmed` directly, if **auto-confirm**
is on. The duration defaults from the settings. Requires `reservations.add_reservation` — an employee
can do this.

### Move a booking through its states

| Action | Allowed from |
|---|---|
| **Confirm** | `pending` |
| **Seat** | `pending`, `confirmed` |
| **Complete** | `seated` |
| **Cancel** (with a reason) | `pending`, `confirmed` |
| **No-show** | `pending`, `confirmed` |

Each transition stamps its own timestamp. Repeating the same status is **rejected**, and nothing can
go back to `pending`. Requires `reservations.change_reservation` — an employee **cannot** do this.

### Edit or delete

Editing the details needs `reservations.change_reservation`; if the update matches nothing you get
`reservations.update_rejected`. Deleting needs `reservations.delete_reservation` — **admin only**.
Prefer cancelling: it keeps the record and the reason.

## Waitlist

People who could not be given a slot (`reservations.waitlist.list`, 50 rows per page). Requires
`reservations.view_waitlistentry`.

An entry holds the guest, the date, the **preferred time**, the party size, whether they have been
contacted, and whether the entry has been converted into a booking.

### Add somebody to the waitlist

Enter the guest, the date, the preferred time and the party size. Requires
`reservations.change_waitlistentry`.

### Promote a waitlist entry into a reservation

This is the important flow.

1. Mark the entry as **converted**.
2. The hub creates the reservation **reading the waitlist row itself** — not what the screen sends —
   and re-checks availability: blocked dates, an active slot, and capacity.
3. The entry is linked to the new booking and marked converted.

**The advance window is deliberately not applied here**: this is staff acting, usually for today.

If the slot is full, or the entry was already converted, **the whole thing is rolled back** — no
booking, no half-converted entry. Requires `reservations.change_waitlistentry`.

## Availability

The screen that answers the floor manager's every-night question — **how much is left tonight?** —
and holds the rules that decide when you can be booked.

### Occupancy (reservations#38)

One row per active slot of the chosen **date** (defaults to today, picked from the table's
toolbar): the window, how many reservations are taken, the maximum, and what is **left**. A slot
with nothing left stays visible but dimmed and stamped **Full** — seeing that a window is closed
(and which one still has room) is what prevents most «turno completo» refusals before they happen.

The numbers come from `reservations.slots.count_for` (reservations#4): it counts exactly what the
anti-overbooking gate counts, so what you see is what the gate will enforce. The table refreshes
live as reservations land, move or cancel. Viewing needs `reservations.view_reservation`.

### Time slots

Bookable windows per weekday.

1. Pick the **day of the week** (0 = Monday … 6 = Sunday).
2. Set the **start** and **end** times.
3. Set **max reservations** — the capacity of that window.
4. Save.

A slot is unique per weekday, start and end. Creating and deleting need
`reservations.change_timeslot`; viewing needs `reservations.view_timeslot`.

### Blocked dates

Days you do not take bookings.

1. Give the **date**.
2. Either mark it **full day**, or set the window it blocks with a start and an end time.

Unique per date and start time. Creating and deleting need `reservations.change_blockeddate`.

## Settings

Generated by the shell from the settings schema. Viewing needs `reservations.view_settings` — an
employee can look; saving needs `reservations.manage_settings`.

| Setting | What it controls |
|---|---|
| Slot duration, default duration | How long a booking occupies |
| Minimum and maximum party size | The sizes you accept |
| Minimum advance hours, maximum advance days | The booking window |
| **Auto-confirm** | Whether a new booking is born `confirmed` instead of `pending` |
| Require phone, require email | Mandatory contact details |
| No-show window | How long before a booking counts as a no-show |
| Confirmation and reminder email flags and hours | Recorded as policy — **nothing is sent** |
