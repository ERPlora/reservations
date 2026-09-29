// reservations#77 — the hour of a reservation, of a waitlist entry or of a time slot («19:30»,
// stored as 'HH:MM[:SS]') is shown and typed in the HUB's clock: 24 h in Spanish, AM/PM in
// English. These are the two halves the three screens use: format a stored wall time for the
// active language, and read back what a person typed or pasted. Same contract as schedules#50 (schedules/ui/lib/wall-time.ts): modules share no JS.
import { describe, expect, it } from 'vitest';
import { WallTimeDrafts, formatWallTime, parseWallTime } from './wall-time';

// Intl separates «AM/PM» with a narrow no-break space; the assertions compare plain spaces.
const plain = (s: string) => s.replace(/\s/g, ' ');

describe('formatWallTime — a stored HH:MM in the hub clock', () => {
  it('Spanish reads 24 h', () => {
    expect(formatWallTime('09:00', 'es')).toBe('09:00');
    expect(formatWallTime('14:30', 'es')).toBe('14:30');
  });

  it('English reads AM/PM', () => {
    expect(plain(formatWallTime('09:00', 'en'))).toBe('09:00 AM');
    expect(plain(formatWallTime('14:30', 'en'))).toBe('02:30 PM');
  });

  it('midnight is 00:00 in Spanish, never 24:00 (the day boundary would move)', () => {
    expect(formatWallTime('00:00', 'es')).toBe('00:00');
    expect(plain(formatWallTime('00:00', 'en'))).toBe('12:00 AM');
  });

  it('a stored value with seconds is still a wall time', () => {
    expect(formatWallTime('18:00:00', 'es')).toBe('18:00');
  });

  it('the device timezone never moves it (a wall time has no zone)', () => {
    const previous = process.env.TZ;
    process.env.TZ = 'Pacific/Kiritimati';
    try {
      expect(formatWallTime('09:00', 'es')).toBe('09:00');
    } finally {
      process.env.TZ = previous;
    }
  });

  it('a locale Intl cannot read falls back to the 24 h HH:MM, seconds dropped', () => {
    expect(() => new Intl.DateTimeFormat('es_ES')).toThrow(RangeError);
    expect(formatWallTime('18:00:00', 'es_ES')).toBe('18:00');
  });

  it('anything that is not a wall time is returned untouched (empty stays empty)', () => {
    expect(formatWallTime('', 'es')).toBe('');
    expect(formatWallTime('25:00', 'es')).toBe('25:00');
    expect(formatWallTime('abc', 'en')).toBe('abc');
  });
});

describe('parseWallTime — what a person types or pastes, back to HH:MM', () => {
  it('reads the 24 h form, with one or two hour digits', () => {
    expect(parseWallTime('14:30')).toBe('14:30');
    expect(parseWallTime('9:05')).toBe('09:05');
    expect(parseWallTime('09.30')).toBe('09:30');
  });

  it('reads digits only — the phone numeric keypad has no colon', () => {
    expect(parseWallTime('1430')).toBe('14:30');
    expect(parseWallTime('930')).toBe('09:30');
    expect(parseWallTime('9')).toBe('09:00');
    expect(parseWallTime('17')).toBe('17:00');
  });

  it('reads back what the English clock shows, and the Spanish 12 h spelling', () => {
    expect(parseWallTime('02:30 PM')).toBe('14:30');
    expect(parseWallTime('02:30 PM')).toBe('14:30');
    expect(parseWallTime('2:30 pm')).toBe('14:30');
    expect(parseWallTime('12:00 AM')).toBe('00:00');
    expect(parseWallTime('12:15 p. m.')).toBe('12:15');
    expect(parseWallTime('9 am')).toBe('09:00');
  });

  it('ignores seconds and surrounding blanks', () => {
    expect(parseWallTime('  18:00:00 ')).toBe('18:00');
  });

  it('refuses what is not a time (a half-typed value is not the last valid hour)', () => {
    for (const bad of ['', '14:', '1:3', '24:00', '2400', '12:60', '13:00 pm', '0 am', '12345', 'abc', '14:30x']) {
      expect(parseWallTime(bad), bad).toBeNull();
    }
  });
});

describe('WallTimeDrafts — the text of a time field while it is being typed', () => {
  function drafts() {
    let repaints = 0;
    const d = new WallTimeDrafts<'start' | 'end'>(() => repaints++);
    return { d, repaints: () => repaints };
  }

  it('without a draft the field shows the stored hour in the hub clock', () => {
    const { d } = drafts();
    expect(d.shown('start', '19:30:00', 'es')).toBe('19:30');
    expect(plain(d.shown('start', '19:30:00', 'en'))).toBe('07:30 PM');
    expect(d.shown('start', '', 'es')).toBe('');
  });

  it('typing keeps the raw text on screen and hands back the stored HH:MM (or "" while unreadable)', () => {
    const { d, repaints } = drafts();
    expect(d.input('start', '1930')).toBe('19:30');
    expect(d.shown('start', '19:30', 'es')).toBe('1930');
    expect(d.input('start', '19:')).toBe('');
    expect(d.shown('start', '', 'es')).toBe('19:');
    expect(repaints()).toBe(2);
  });

  it('leaving forgets a readable text (the field repaints the hub clock) and keeps an unreadable one', () => {
    const { d } = drafts();
    d.input('start', '1930');
    d.leave('start');
    expect(d.shown('start', '19:30', 'es')).toBe('19:30');
    d.input('end', '21:');
    d.leave('end');
    expect(d.shown('end', '', 'es')).toBe('21:');
    expect(d.unreadable('start', 'end')).toBe(true);
    expect(d.unreadable('start')).toBe(false);
  });

  it('an emptied field is not unreadable, a half-typed one is until it reads', () => {
    const { d } = drafts();
    d.input('start', '');
    expect(d.unreadable('start')).toBe(false);
    d.input('start', '7:');
    expect(d.unreadable('start')).toBe(true);
    d.input('start', '7:3');
    expect(d.unreadable('start')).toBe(true);
    d.input('start', '7:30');
    expect(d.unreadable('start')).toBe(false);
  });

  it('a pasted time is stored at once and the paste is taken; anything else is left to the browser', () => {
    const { d } = drafts();
    d.input('start', '7');
    const ev = new Event('paste', { cancelable: true }) as Event & { clipboardData: unknown };
    ev.clipboardData = { getData: () => '2:30 pm' };
    expect(d.paste('start', ev)).toBe('14:30');
    expect(ev.defaultPrevented).toBe(true);
    expect(d.shown('start', '14:30', 'es')).toBe('14:30');
    const other = new Event('paste', { cancelable: true }) as Event & { clipboardData: unknown };
    other.clipboardData = { getData: () => 'dinner' };
    expect(d.paste('start', other)).toBeNull();
    expect(other.defaultPrevented).toBe(false);
  });

  it('clear() forgets every draft', () => {
    const { d } = drafts();
    d.input('start', '19:');
    d.input('end', '2');
    d.clear();
    expect(d.unreadable('start', 'end')).toBe(false);
    expect(d.shown('end', '21:00', 'es')).toBe('21:00');
  });
});
