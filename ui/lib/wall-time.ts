// reservations#77 — the hour of a reservation, of a waitlist entry and the start/end of a time slot
// are WALL times ('HH:MM[:SS]', the civil reading of the dining room clock), shown and typed in the
// HUB's language: 24 h in Spanish, AM/PM in English. A native `<input type="time">` cannot do it:
// Chromium paints it with the BROWSER's (operating system's) clock and ignores the hub language — a
// Spanish hub on a US-English laptop read «07:30 PM». Same reading as schedules#50
// (schedules/ui/lib/wall-time.ts), appointments#214 and staff#86; modules share no JS, so this is
// the reservations copy of it.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

const STORED = /^(\d{2}):(\d{2})(?::\d{2})?$/;

/** Formats a stored `HH:MM[:SS]` wall time in the given locale's own clock (`es` → `14:30`,
 *  `en` → `02:30 PM`), 2-digit hour and minute. Built from `Date.UTC` and formatted with
 *  `timeZone: 'UTC'`, so the device's timezone never moves it (a wall time has none to move).
 *  `hourCycle` is left to the locale on purpose: that IS the language's clock. Anything that is
 *  not a valid wall time comes back untouched, so a list never blanks a value it cannot read. */
export function formatWallTime(time: string, locale: string): string {
  const match = time.match(STORED);
  if (!match) return time;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return time;
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'UTC',
    }).format(new Date(Date.UTC(2026, 0, 1, hour, minute)));
  } catch {
    // Intl threw on the given locale: fall back to the 24-hour form below.
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

// H, HH, H:MM, HH:MM, H.MM (optional :SS) — or digits only (HMM, HHMM), because the phone's
// numeric keypad has no colon — with an optional meridiem as English and Spanish write it
// («PM», «pm», «p.m.», «p. m.»). Intl separates it with a narrow no-break space, which `\s` covers.
const TYPED = /^(?:(\d{1,2})(?:[:.](\d{2})(?::\d{2})?)?|(\d{1,2})(\d{2}))(?:\s*([ap])\.?\s?m\.?)?$/i;

/** Reads a time typed or pasted as free text back to the stored `HH:MM`, or `null` when it is
 *  not (yet) a time — a half-typed «14:» must never keep the last valid hour. */
export function parseWallTime(text: string): string | null {
  const match = text.trim().match(TYPED);
  if (!match) return null;
  const [, hourText, minuteText, packedHour, packedMinute, meridiem] = match;
  let hour = Number(hourText ?? packedHour);
  const minute = Number(minuteText ?? packedMinute ?? 0);
  if (minute > 59) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    const isPm = meridiem.toLowerCase() === 'p';
    hour = isPm ? (hour === 12 ? 12 : hour + 12) : hour === 12 ? 0 : hour;
  } else if (hour > 23) {
    return null;
  }
  return `${pad2(hour)}:${pad2(minute)}`;
}

/** reservations#77 — the text of the time fields of a form while it is being typed, by field key,
 *  kept apart from the stored hour (which only ever holds a valid 'HH:MM' or ''). One store per
 *  form: the three screens share the same typing, leaving and pasting rules. `repaint` asks the
 *  host component to render again (a draft is view state). */
export class WallTimeDrafts<K extends string> {
  private texts: Partial<Record<K, string>> = {};

  constructor(private readonly repaint: () => void) {}

  /** What a time field shows: the raw text while it is being typed (a half-typed «19:» stays on
   *  screen), the stored hour in the hub's clock otherwise. */
  shown(key: K, stored: string, locale: string): string {
    return this.texts[key] ?? formatWallTime(stored, locale);
  }

  /** `ionInput`: keeps the text as the draft and returns the stored hour that follows it exactly —
   *  '' while it is not (yet) a time, so a half-typed hour never saves the last valid one. */
  input(key: K, text: string): string {
    this.texts = { ...this.texts, [key]: text };
    this.repaint();
    return parseWallTime(text) ?? '';
  }

  /** Blur/Enter (`ionChange`): forgets a readable draft so the field repaints the stored hour in
   *  the hub's clock. An unreadable text stays, so the save can say why it refuses. */
  leave(key: K): void {
    const text = this.texts[key];
    if (text === undefined || (text.trim() && !parseWallTime(text))) return;
    this.forget(key);
  }

  /** A time pasted in any spelling the parser reads is returned (to be stored) and repainted in the
   *  hub clock at once. Anything else returns `null` and is left to the browser's own paste. */
  paste(key: K, e: Event): string | null {
    const time = parseWallTime((e as ClipboardEvent).clipboardData?.getData('text') ?? '');
    if (!time) return null;
    e.preventDefault();
    this.forget(key);
    return time;
  }

  /** True when any of the given fields holds typed text that is not a time: its stored hour is ''
   *  and, without this, the form would read it as «not filled in» instead of «can't be read». */
  unreadable(...keys: K[]): boolean {
    return keys.some((key) => {
      const text = this.texts[key];
      return text !== undefined && text.trim() !== '' && parseWallTime(text) === null;
    });
  }

  /** Forgets every draft — after a save, so the next entry starts with empty fields. */
  clear(): void {
    this.texts = {};
    this.repaint();
  }

  private forget(key: K): void {
    const { [key]: _gone, ...rest } = this.texts;
    this.texts = rest as Partial<Record<K, string>>;
    this.repaint();
  }
}
