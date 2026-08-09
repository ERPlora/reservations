// Editing a reservation has to pass the same door as creating one (reservations#14).
//
// `create` is gated properly: party size within the configured limits, the advance window, no
// blocked date, and an active timeslot **with room left**, counted atomically. `update` had none of
// it — a bare `UPDATE … WHERE id = :reservation_id`. So the door was only on the way in: move the
// same reservation to a full slot, to a blocked day, or to a party of forty, and it went through.
//
// The second half is smaller and just as annoying in a dining room: `table_id = COALESCE(:table_id,
// table_id)` means NULL is "leave it alone", so **there is no way to say "take the table off"**. A
// reservation assigned by mistake stays assigned.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'module.json'), 'utf8')) as {
  id: string;
  commands: Record<string, { sql?: string[]; expect_rows?: { op: string; n: number; error: string; message?: string } }>;
};
const cmd = manifest.commands['reservations.reservations.update'];
const sql = (cmd.sql ?? [])
  .map((f) => readFileSync(join(ROOT, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'))
  .join('\n');

describe('the edit revalidates availability, like the create does', () => {
  it('checks the party size against the configured limits', () => {
    expect(sql, 'a reservation can be edited to a party of forty').toMatch(/min_party_size/);
    expect(sql).toMatch(/max_party_size/);
  });

  it('checks the advance window against the server clock', () => {
    expect(sql, 'a reservation can be moved to yesterday').toMatch(/erp_datediff_days/);
    expect(sql).toMatch(/:now/);
  });

  it('refuses a date the business blocked', () => {
    expect(sql, 'a reservation can be moved onto a closed day').toMatch(/reservations_blockeddate/);
  });

  it('requires an active timeslot that still has room', () => {
    expect(sql, 'a reservation can be moved into a full slot').toMatch(/reservations_timeslot/);
    expect(sql).toMatch(/max_reservations/);
  });

  // The subtle one. The capacity count must not see the reservation being edited, or moving it
  // WITHIN its own slot would count it twice and refuse a change that changes nothing.
  it('does not count itself when checking the slot capacity', () => {
    expect(
      sql,
      'the capacity count includes the reservation being edited: moving it inside its own slot would be refused',
    ).toMatch(/r\.id\s*(<>|!=)\s*:reservation_id/i);
  });

  it('measures the window and the slot on the values AFTER the edit', () => {
    // `COALESCE(:date, date)` is the effective date: what the reservation will be, not what it was.
    expect(sql, 'the gate checks the old values, so an edit could dodge it').toMatch(/COALESCE\(\s*:date\s*,\s*date\s*\)/);
    expect(sql).toMatch(/COALESCE\(\s*:time\s*,\s*time\s*\)/);
  });
});

describe('a table can be taken off, not only put on', () => {
  it('uses a sentinel so that "clear it" is expressible', () => {
    // Two sentinels, the same shape `staff` settled on for `user_id` (ADR-0188): NULL = do not
    // touch, '' = unassign. And the bind is COALESCEd to a literal so Postgres can infer its type —
    // a bare `:table_id IS NULL` is the 42P08 that bit staff.
    expect(sql, 'with plain COALESCE, NULL means "keep" and nothing means "clear"').toMatch(/'__keep__'|NULLIF\(\s*:table_id/);
  });
});

describe('a refused edit fails instead of reporting success', () => {
  it('declares the expect_rows gate', () => {
    const gate = cmd.expect_rows;
    expect(gate, 'without it, a rejected edit writes nothing and still emits reservation.updated').toBeTruthy();
    expect(gate!.op).toBe('min');
    expect(gate!.n).toBeGreaterThanOrEqual(1);
    expect(gate!.error.split('.')[0]).toBe(manifest.id);
    expect(gate!.message).toBeTruthy();
  });
});
