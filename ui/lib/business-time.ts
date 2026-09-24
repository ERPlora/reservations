/** The clock of `reservations` is the RESTAURANT clock (reservations#45).
 *
 * One authority, and it is the core: `erplora.timezone` is the IANA zone the runtime resolved
 * (`settings::timezone_of`, hub#731) and published through `/api/hub/context` (hub#1022). This
 * module stores no zone of its own. The device never rules: a tablet set to another country must
 * still open the book on the restaurant's today.
 *
 * Reservations store their `date` and `time` as WALL CLOCK text (`YYYY-MM-DD`, `HH:MM:SS`), so the
 * only conversions needed are «what day / what time is it on the restaurant's wall right now».
 * Same approach as `appointments` (`ui/lib/business-time.ts`, appointments#12): `Intl` ships the
 * whole IANA database at zero bytes of bundle. Modules do not import each other, hence the copy
 * of the three functions this screen needs.
 */

const DAY_MS = 86_400_000;

const pad = (n: number): string => String(n).padStart(2, '0');

/** One formatter per zone. `h23` (not `hour12: false`): the latter answers «24» for midnight in
 *  several engines, which would put the day boundary on the wrong date. */
const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(now: Date, timezone: string): Record<string, number> {
  let f = formatters.get(timezone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timezone, f);
  }
  const got: Record<string, number> = {};
  for (const p of f.formatToParts(now)) {
    if (p.type !== 'literal') got[p.type] = Number(p.value);
  }
  return got;
}

/** The IANA zone of the business, straight from the core. Degrades to `UTC` like the runtime's
 *  own `timezone_name()`: a clock wrong by a known amount beats one that follows the device. */
export function businessTimezone(): string {
  const tz = (globalThis as { erplora?: { timezone?: unknown } }).erplora?.timezone;
  return typeof tz === 'string' && tz.trim() ? tz.trim() : 'UTC';
}

/** Today on the restaurant calendar (`YYYY-MM-DD`). */
export function todayISO(timezone: string = businessTimezone(), now: Date = new Date()): string {
  const p = wallParts(now, timezone);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** The restaurant wall clock right now, `HH:MM:SS` — the shape `start_time`/`end_time` and a
 *  reservation's `time` are stored in, so it compares as text against them. */
export function nowWallTime(timezone: string = businessTimezone(), now: Date = new Date()): string {
  const p = wallParts(now, timezone);
  return `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** `day` ± `delta` CALENDAR days. Calendar arithmetic on a date-only value in UTC: a service day
 *  lasts 23, 24 or 25 hours, so «tomorrow» is the next DATE, never `+24 h`. A day the calendar
 *  cannot read comes back unchanged: the stepper must not invent a date. */
export function addDaysISO(day: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((day ?? '').trim());
  if (!m) return day;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + delta * DAY_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
