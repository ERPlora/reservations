// reservations#78 — a calendar date ('YYYY-MM-DD': the date of a reservation, of a waitlist entry,
// of a blocked day, the day the book or the occupancy is on) shown and typed in the HUB's day/month
// order: day first in Spanish, month first in English. A native `<input type="date">` cannot do it:
// Chromium paints it with the BROWSER's (operating system's) locale and ignores the hub language —
// a Spanish hub on a US-English laptop read «09/29/2026», and «03/04/2026» typed as the 3rd of
// April saved the 4th of March. Same reading as schedules#56 (schedules/ui/lib/calendar-date.ts)
// and appointments#242; modules share no JS, so this is the reservations copy of it.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The `YYYY-MM-DD` string, or `null` if the day/month/year is not a real calendar date. */
function toIsoDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1) return null;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day > days[month - 1]) return null;
  return `${String(year).padStart(4, '0')}-${pad2(month)}-${pad2(day)}`;
}

/** Whether the language writes the day before the month, read from how `Intl` itself orders a
 *  formatted date. Day first when the locale is unknown or `Intl` throws. */
function isDayFirst(locale: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat(locale || undefined, { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
      new Date(Date.UTC(2026, 8, 26)),
    );
    const month = parts.findIndex((p) => p.type === 'month');
    const day = parts.findIndex((p) => p.type === 'day');
    return month === -1 || day === -1 || day < month;
  } catch {
    return true;
  }
}

const STORED = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Formats a stored `YYYY-MM-DD` date as a numeric date in the locale's own day/month order
 *  (`es` → `29/09/2026`, `en` → `09/29/2026`), 2-digit day/month and 4-digit year, always joined
 *  by `/` so the field can be typed back unchanged. Built from `Date.UTC` and formatted in UTC: the
 *  device's timezone never moves it (a calendar date names no instant). `''` for anything that is
 *  not a real calendar date. */
export function formatCalendarDate(iso: string, locale: string): string {
  const match = iso.match(STORED);
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!toIsoDate(year, month, day)) return '';
  try {
    const parts = new Intl.DateTimeFormat(locale || undefined, {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'UTC',
    }).formatToParts(new Date(Date.UTC(year, month - 1, day)));
    const ordered = parts.filter((p) => p.type === 'day' || p.type === 'month' || p.type === 'year').map((p) => p.value);
    if (ordered.length === 3) return ordered.join('/');
  } catch {
    // Intl threw on the given locale: fall back to the day-first form below.
  }
  return `${pad2(day)}/${pad2(month)}/${String(year).padStart(4, '0')}`;
}

// D/M/YYYY with `/`, `.`, `-` or spaces between the parts — or digits only (DDMMYYYY), because the
// iPhone's numeric keypad has no slash.
const TYPED = /^(?:(\d{1,2})\s*[/.\-\s]\s*(\d{1,2})\s*[/.\-\s]\s*(\d{4})|(\d{2})(\d{2})(\d{4}))$/;

/** Reads a date typed or pasted as free text — in the locale's day/month order, or ISO — back to
 *  the stored `YYYY-MM-DD`, or `null` when it is not (yet) a real date: a half-typed «29/09» must
 *  never keep the last valid date. */
export function parseCalendarDate(text: string, locale: string): string | null {
  const trimmed = text.trim();
  const iso = trimmed.match(STORED);
  if (iso) return toIsoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const match = trimmed.match(TYPED);
  if (!match) return null;
  const first = Number(match[1] ?? match[4]);
  const second = Number(match[2] ?? match[5]);
  const year = Number(match[3] ?? match[6]);
  return isDayFirst(locale) ? toIsoDate(year, second, first) : toIsoDate(year, first, second);
}

/** reservations#78 — the text of the date fields of a screen while it is being typed, by field key,
 *  kept apart from the stored date (which only ever holds a real 'YYYY-MM-DD' or ''). Same shape as
 *  `WallTimeDrafts` (reservations#77), so the date and the hour of a form type, leave and refuse
 *  alike. `repaint` asks the host component to render again (a draft is view state). */
export class CalendarDateDrafts<K extends string> {
  private texts: Partial<Record<K, string>> = {};

  constructor(private readonly repaint: () => void) {}

  /** What a date field shows: the raw text while it is being typed (a half-typed «29/09» stays on
   *  screen), the stored date in the hub's order otherwise. */
  shown(key: K, stored: string, locale: string): string {
    return this.texts[key] ?? formatCalendarDate(stored, locale);
  }

  /** `ionInput`: keeps the text as the draft and returns the stored date that follows it exactly —
   *  '' while it is not (yet) a date, so a half-typed date never saves the last valid one. */
  input(key: K, text: string, locale: string): string {
    this.texts = { ...this.texts, [key]: text };
    this.repaint();
    return parseCalendarDate(text, locale) ?? '';
  }

  /** Blur/Enter (`ionChange`): forgets a readable (or emptied) draft so the field repaints the
   *  stored date in the hub's order. An unreadable text stays, so the save can say why it refuses. */
  leave(key: K, locale: string): void {
    const text = this.texts[key];
    if (text === undefined || (text.trim() && !parseCalendarDate(text, locale))) return;
    this.forget(key);
  }

  /** True when any of the given fields holds typed text that is not a date: its stored date is ''
   *  and, without this, the form would read it as «not filled in» instead of «can't be read». */
  unreadable(locale: string, ...keys: K[]): boolean {
    return keys.some((key) => {
      const text = this.texts[key];
      return text !== undefined && text.trim() !== '' && parseCalendarDate(text, locale) === null;
    });
  }

  /** Forgets one draft, whatever it holds — a field with no save (the day picker) goes back to the
   *  day it is on, and a date set from elsewhere (the day arrows) is painted at once. */
  forget(key: K): void {
    if (!(key in this.texts)) return;
    const { [key]: _gone, ...rest } = this.texts;
    this.texts = rest as Partial<Record<K, string>>;
    this.repaint();
  }

  /** Forgets every draft — after a save, so the next entry starts with empty fields. */
  clear(): void {
    this.texts = {};
    this.repaint();
  }
}
