// reservations#78 — a calendar date shown and typed in the HUB's day/month order, not the browser's.
//
// The date of a new reservation, the day picker of the book, the date of a waitlist entry and the
// two dates of Availability (occupancy, blocked date) were native `<input type="date">`: Chromium
// paints that control with the BROWSER's (operating system's) locale, so a Spanish hub on a
// US-English laptop read «09/29/2026» and «03/04/2026» typed as the 3rd of April saved the 4th of
// March. Same contract as schedules#56 (schedules/ui/lib/calendar-date.ts): modules share no JS.
import { afterAll, describe, expect, it } from 'vitest';

// A zone WEST of UTC: a calendar date formatted through the device's timezone slides to the day
// before here, so the helper must never let the device zone touch it.
const previousTz = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  process.env.TZ = previousTz;
});

const { CalendarDateDrafts, formatCalendarDate, parseCalendarDate } = await import('./calendar-date');

describe('formatCalendarDate — the stored ISO date in the hub order', () => {
  it('Spanish writes day/month/year', () => {
    expect(formatCalendarDate('2026-09-29', 'es')).toBe('29/09/2026');
    expect(formatCalendarDate('2026-04-03', 'es')).toBe('03/04/2026');
  });

  it('English writes month/day/year', () => {
    expect(formatCalendarDate('2026-09-29', 'en')).toBe('09/29/2026');
    expect(formatCalendarDate('2026-04-03', 'en')).toBe('04/03/2026');
  });

  it('the device timezone never moves the day (it is a date, not an instant)', () => {
    expect(formatCalendarDate('2026-01-01', 'es')).toBe('01/01/2026');
  });

  it('a locale Intl cannot read falls back to day first', () => {
    expect(() => new Intl.DateTimeFormat('es_ES')).toThrow(RangeError);
    expect(formatCalendarDate('2026-09-29', 'es_ES')).toBe('29/09/2026');
    expect(formatCalendarDate('2026-09-29', 'xx-invalid-!!')).toBe('29/09/2026');
  });

  it('empty or impossible dates paint nothing', () => {
    expect(formatCalendarDate('', 'es')).toBe('');
    expect(formatCalendarDate('2026-02-30', 'es')).toBe('');
    expect(formatCalendarDate('29/09/2026', 'es')).toBe('');
  });
});

describe('parseCalendarDate — what is typed back to the stored ISO date', () => {
  it('Spanish reads day/month/year', () => {
    expect(parseCalendarDate('03/04/2026', 'es')).toBe('2026-04-03');
    expect(parseCalendarDate('29/09/2026', 'es')).toBe('2026-09-29');
  });

  it('English reads month/day/year', () => {
    expect(parseCalendarDate('03/04/2026', 'en')).toBe('2026-03-04');
    expect(parseCalendarDate('09/29/2026', 'en')).toBe('2026-09-29');
  });

  it('a locale Intl cannot read reads day first, the same order it is painted in', () => {
    expect(parseCalendarDate('03/04/2026', 'es_ES')).toBe('2026-04-03');
    expect(parseCalendarDate('03/04/2026', 'xx-invalid-!!')).toBe('2026-04-03');
  });

  it('what the field paints is read back unchanged, in both languages', () => {
    for (const locale of ['es', 'en']) {
      expect(parseCalendarDate(formatCalendarDate('2026-09-29', locale), locale)).toBe('2026-09-29');
    }
  });

  it('single digits and the usual separators (dot, dash, space) are read', () => {
    expect(parseCalendarDate('3/4/2026', 'es')).toBe('2026-04-03');
    expect(parseCalendarDate('3.4.2026', 'es')).toBe('2026-04-03');
    expect(parseCalendarDate('3-4-2026', 'es')).toBe('2026-04-03');
    expect(parseCalendarDate(' 3 4 2026 ', 'es')).toBe('2026-04-03');
  });

  it('digits only (the iPhone numeric keypad has no slash) are read in the hub order', () => {
    expect(parseCalendarDate('03042026', 'es')).toBe('2026-04-03');
    expect(parseCalendarDate('03042026', 'en')).toBe('2026-03-04');
  });

  it('a pasted ISO date is read as it is, whatever the language', () => {
    expect(parseCalendarDate('2026-04-03', 'es')).toBe('2026-04-03');
    expect(parseCalendarDate('2026-04-03', 'en')).toBe('2026-04-03');
  });

  it('a half-typed or impossible date is not a date yet', () => {
    for (const text of ['', '29', '29/09', '29/09/20', '29/09/202', '31/02/2026', '29/02/2026', '32/01/2026', '00/01/2026', '29/13/2026', 'mañana', '2909202']) {
      expect(parseCalendarDate(text, 'es'), text).toBeNull();
    }
    expect(parseCalendarDate('29/02/2028', 'es')).toBe('2028-02-29');
    expect(parseCalendarDate('09/29/2026', 'es')).toBeNull();
  });
});

describe('CalendarDateDrafts — the text of the date fields of a form while it is typed', () => {
  function store() {
    let repaints = 0;
    const drafts = new CalendarDateDrafts<'a' | 'b'>(() => {
      repaints += 1;
    });
    return { drafts, repaints: () => repaints };
  }

  it('shows the stored date in the hub order when nothing is being typed', () => {
    const { drafts } = store();
    expect(drafts.shown('a', '2026-09-29', 'es')).toBe('29/09/2026');
    expect(drafts.shown('a', '2026-09-29', 'en')).toBe('09/29/2026');
    expect(drafts.shown('a', '', 'es')).toBe('');
  });

  it('input keeps the raw text on screen and returns the date it reads — or "" until it is one', () => {
    const { drafts, repaints } = store();
    expect(drafts.input('a', '03/04', 'es')).toBe('');
    expect(drafts.shown('a', '', 'es')).toBe('03/04');
    expect(drafts.input('a', '03/04/2026', 'es')).toBe('2026-04-03');
    expect(drafts.shown('a', '2026-04-03', 'es')).toBe('03/04/2026');
    expect(drafts.input('a', '03042026', 'en')).toBe('2026-03-04');
    expect(repaints()).toBe(3);
  });

  it('leaving a readable field repaints the stored date in the hub order', () => {
    const { drafts } = store();
    drafts.input('a', '3.4.2026', 'es');
    drafts.leave('a', 'es');
    expect(drafts.shown('a', '2026-04-03', 'es')).toBe('03/04/2026');
  });

  it('leaving an emptied field forgets it too', () => {
    const { drafts } = store();
    drafts.input('a', '', 'es');
    drafts.leave('a', 'es');
    expect(drafts.shown('a', '2026-04-03', 'es')).toBe('03/04/2026');
  });

  it('leaving an unreadable field keeps the text, so the save can say why it refuses', () => {
    const { drafts } = store();
    drafts.input('a', '31/02/2026', 'es');
    drafts.leave('a', 'es');
    expect(drafts.shown('a', '', 'es')).toBe('31/02/2026');
    expect(drafts.unreadable('es', 'a')).toBe(true);
  });

  it('unreadable is true only for typed text that is not a date, field by field', () => {
    const { drafts } = store();
    expect(drafts.unreadable('es', 'a', 'b')).toBe(false);
    drafts.input('a', '29/09/2026', 'es');
    drafts.input('b', '   ', 'es');
    expect(drafts.unreadable('es', 'a', 'b')).toBe(false);
    drafts.input('b', '29/09', 'es');
    expect(drafts.unreadable('es', 'a')).toBe(false);
    expect(drafts.unreadable('es', 'b')).toBe(true);
    expect(drafts.unreadable('es', 'a', 'b')).toBe(true);
  });

  it('forget drops one draft (the others stay), clear drops them all', () => {
    const { drafts } = store();
    drafts.input('a', '29/09', 'es');
    drafts.input('b', '30/09', 'es');
    drafts.forget('a');
    expect(drafts.shown('a', '2026-09-29', 'es')).toBe('29/09/2026');
    expect(drafts.shown('b', '', 'es')).toBe('30/09');
    drafts.clear();
    expect(drafts.shown('b', '2026-09-30', 'es')).toBe('30/09/2026');
  });
});
