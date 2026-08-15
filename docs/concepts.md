# Reservations — Concepts

The things people get wrong on their first day.

## A reservation is a promise; a session is the reality

Booking a table and **seating** people are two different things, owned by two different modules.

- **Reservations** says "these four people are expected at nine".
- **`tables`** owns the floor: which table is occupied, by whom, and what they ordered.

A reservation carries at most a table **reference**. To make the floor plan actually show a table as
reserved, `tables` must **hold** it — and that hold is what a booking hands over. This module does not
paint the plan.

## Every availability rule is checked inside the write, not before it

The guards live in the SQL of the write itself, in the same transaction. That is not an
implementation detail: it makes the **capacity count atomic**. Two people booking the last table at
the same instant cannot both succeed.

The consequence is that a rejected booking **rolls everything back** — no row, no event, nothing
half-done.

## The five things that can refuse a booking

In the order you should check them:

1. **Party size** outside the configured minimum or maximum.
2. **Advance window** — too soon (below the minimum notice) or too far ahead (beyond the maximum
   days).
3. **Blocked date** — the day, or that part of the day, is closed.
4. **No active time slot** for that weekday covering that time.
5. **Slot full** — the window has reached its maximum reservations.

"There is no availability" almost always means **no time slot is configured**, not that the
restaurant is full.

## The state machine only moves forward, and repeating is rejected

| From | Can go to |
|---|---|
| `pending` | `confirmed`, `seated`, `cancelled`, `no_show` |
| `confirmed` | `seated`, `cancelled`, `no_show` |
| `seated` | `completed` |

Two rules that surprise people:

- **Nothing can go back to `pending`.** It is a starting state only.
- **Setting the same status again is rejected**, not ignored. That is deliberate: it stops a repeated
  request from emitting the event twice.

## Cancelling is not deleting, and there is no cancellation event

Cancelling keeps the booking, stamps when it happened and stores the **reason**. A no-show does the
same and records that the guest never came — which is the data you need to spot a repeat offender.

**Deleting** is a separate, destructive, admin-only action.

And for integrators: **there is no `reservation.cancelled` event.** A cancellation arrives inside
`reservations.reservation.status_changed`. Look at the status, not the event name.

## The creation event exists even though the manifest does not declare it

`reservations.reservation.created` is emitted by the handler, not declared as a manifest emit. If you
grep the manifest for it you will not find it, and you will wrongly conclude nothing is emitted.

## Promoting from the waitlist trusts the database, not the caller

When a waitlist entry is converted, the booking is built by **reading the waitlist row**, not from
what the client sends. The row is the authority.

The availability gate is re-applied — blocked dates, an active slot, capacity — with one deliberate
exception: **the advance window does not apply.** Staff promoting somebody are normally doing it for
today, and a minimum-notice rule would block exactly the case the waitlist exists for.

A double promotion, or a slot that filled up in the meantime, **rolls back everything**: no booking
and no half-converted entry.

## Auto-confirm decides whether a booking is born `pending` or `confirmed`

With it off, every booking waits for somebody to confirm. With it on, a booking is immediately
`confirmed`. This is a per-hub setting, not a per-booking choice.

## Nothing is sent, and nothing runs on a timer

The settings hold confirmation and reminder policy — flags and hours. **No email, SMS or WhatsApp is
sent by this module.**

Likewise there is **no scheduled task**: releasing unconfirmed bookings the next morning and sending
tomorrow's reminders are designed and not implemented. Do not assume an unconfirmed booking will free
itself.

## The customer and the table are references, not links

Both are stored by contract, with **no foreign key**, because `customers` and `tables` may not be
loaded when the row is read. Deleting a customer does not touch the booking, and the guest name,
phone and email are copied onto it so a walk-in booking needs no customer record at all.

## Dates and times have no timezone

They are naive values. That is why this module is **last in line** for external calendar sync: a
correct round-trip with an external calendar is not possible until those columns carry an offset.

## Weekdays start at Monday

**0 = Monday, 6 = Sunday.** If your slots appear on the wrong day, this is almost always why.

## Deleting is a soft delete

Reservations, slots, blocked dates and waitlist entries are marked deleted, never erased.
