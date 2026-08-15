# Reservations — Limits and troubleshooting

## Known limitations you should know about

- **Nothing is ever sent.** Confirmation and reminder settings are policy only.
- **No scheduled tasks.** Unconfirmed bookings are never released automatically and reminders never
  go out.
- **No alternative slots are suggested** when a booking is refused. The engine cannot read
  alternatives, so it tells you it failed but not what would have worked.
- **No availability count for the UI.** There is no query that returns how many places are left in a
  slot; capacity is only checked while writing.
- **No external calendar sync**, and this module is last in the queue for it because its dates and
  times carry no timezone.
- **No deposits, prepayments or cancellation fees.**

## Refusals you will actually see

A refused booking **rolls the whole transaction back** — no row, no event.

| Refusal | What happened | What to do |
|---|---|---|
| Party size rejected | Below the minimum or above the maximum in the settings | Change the party, or the settings |
| Advance window rejected | Too soon (minimum notice) or too far ahead (maximum days) | Adjust the date, or the settings |
| Blocked date | The day, or that part of it, is closed | Remove the block or book another day |
| No active time slot | No slot for that weekday covers that time | Create the slot — this is the most common cause |
| Slot full | The window reached its maximum reservations | Add the guest to the **waitlist** |
| Invalid status transition | The target is not reachable from the current status, or is the same status | Re-read the booking; nothing changed |
| `reservations.update_rejected` | The update matched no row | Check the booking exists in this hub |
| Waitlist promotion rolled back | Already converted, or the slot filled up meanwhile | Re-read the entry |

## Accepted values

| Field | Values |
|---|---|
| Reservation status | `pending`, `confirmed`, `seated`, `cancelled`, `no_show`, `completed` |
| Day of week | 0 = Monday … 6 = Sunday |
| Time | `HH:MM:SS` after normalisation |
| Blocked date | full day, or a window with a start and an end |

## Caps and sizes

| Limit | Value |
|---|---|
| Rows per page (reservations, slots, blocked dates, waitlist) | 50 |
| Maximum rows a paginated request may ask for | 500 |
| Reservations per slot | the slot's own maximum |
| Time slots | unique per weekday, start and end |
| Blocked dates | unique per date and start |
| Settings rows per hub | 1 |

## Permissions per action

| To do this | You need |
|---|---|
| See reservations | `reservations.view_reservation` |
| Take a reservation | `reservations.add_reservation` |
| Confirm, seat, complete, cancel, mark no-show, edit | `reservations.change_reservation` |
| Delete a reservation | `reservations.delete_reservation` |
| See time slots / blocked dates / the waitlist | `reservations.view_timeslot` / `.view_blockeddate` / `.view_waitlistentry` |
| Create or delete time slots | `reservations.change_timeslot` |
| Create or delete blocked dates | `reservations.change_blockeddate` |
| Add to, update or promote from the waitlist | `reservations.change_waitlistentry` |
| See the settings | `reservations.view_settings` |
| Save the settings | `reservations.manage_settings` |

By role: **admin** has everything. **manager** has everything except deleting a reservation.
**employee** can **see everything and take a booking**, but cannot confirm, seat, cancel, mark a
no-show, edit, manage slots or blocked dates, or touch the waitlist.

That split is deliberate: answering the phone is routine; changing the night's plan is not.

## Dependencies — what breaks if something is missing

**`tables` and `customers` are required** and are installed with Reservations. You cannot uninstall
either while it is installed.

Even so, the references to them are **by contract, without foreign keys** — the modules may not be
loaded when a row is read, so a booking is readable regardless.

Practically:

- Without `tables`, a booking has nowhere to be seated and the floor plan never shows it as reserved.
- Without `customers`, bookings still work: the guest name, phone and email live on the booking
  itself, which is what a walk-in phone call needs.

**Nothing depends on Reservations.**

## When something looks wrong

**"There is no availability at all."** Almost always **no time slot** is configured for that weekday.
Check Availability before anything else, and remember weekdays are 0 = Monday.

**"It says the slot is full but the room is empty."** The slot's maximum reservations is the limit,
not the number of tables. Raise it, or add another slot.

**"I cannot book for tonight."** The **minimum advance hours** setting is refusing it. Lower it, or
add the guest to the waitlist and promote them — promotion deliberately skips that check.

**"I cannot book for next year."** The **maximum advance days** setting.

**"Confirming twice gave an error."** Correct. Repeating a status is rejected so the event is not
emitted twice.

**"I cannot set a booking back to pending."** By design; `pending` is a starting state only.

**"The guest cancelled and my integration never noticed."** There is **no cancellation event**. Listen
to `status_changed` and read the status.

**"My listener never sees a creation event."** It is emitted by the handler and not declared in the
manifest — the event exists.

**"The waitlist promotion did nothing."** The entry was already converted, or the slot filled up.
Both roll back completely.

**"An unconfirmed booking is still holding a slot from last week."** Nothing releases it
automatically. Cancel it by hand.

**"The guest never got a reminder."** Nothing sends reminders. The settings only record the intent.

**"The table does not show as reserved on the floor plan."** Reservations does not paint the plan;
`tables` must hold the table.
