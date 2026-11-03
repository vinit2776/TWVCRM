// Suggests a follow-up time from what a rep typed after a call ("call me Friday 4pm", "after 1 Jan").
// It only pre-fills the date box: the person still confirms or changes it, so a wrong guess costs a
// glance rather than a missed call. All maths is on IST wall-clock, matching how follow-ups are stored.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIRST_SLOT_MIN = 9 * 60;
const LAST_SLOT_MIN = 20 * 60;
const DEFAULT_MIN = 11 * 60;

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
// Only whole day and month names (or their usual short forms) count, so "next month", "friendly"
// or "2 marketing seats" are not read as a date.
const WEEKDAY_WORDS = "sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat";
const MONTH_WORDS =
  "january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec";

type Ist = { y: number; m: number; d: number; minutes: number; weekday: number };

function istParts(date: Date): Ist {
  const s = new Date(date.getTime() + IST_OFFSET_MS);
  return {
    y: s.getUTCFullYear(),
    m: s.getUTCMonth(),
    d: s.getUTCDate(),
    minutes: s.getUTCHours() * 60 + s.getUTCMinutes(),
    weekday: s.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "yyyy-MM-ddTHH:mm" for a calendar day plus minutes after midnight, clamped to the pickable slots. */
function toValue(y: number, m: number, d: number, minutes: number): string {
  const clamped = Math.min(LAST_SLOT_MIN, Math.max(FIRST_SLOT_MIN, minutes));
  const slot = Math.floor(clamped / 30) * 30;
  const day = new Date(Date.UTC(y, m, d));
  return `${day.getUTCFullYear()}-${pad(day.getUTCMonth() + 1)}-${pad(day.getUTCDate())}T${pad(Math.floor(slot / 60))}:${pad(slot % 60)}`;
}

function addDays(p: Ist, days: number): { y: number; m: number; d: number } {
  const day = new Date(Date.UTC(p.y, p.m, p.d) + days * DAY_MS);
  return { y: day.getUTCFullYear(), m: day.getUTCMonth(), d: day.getUTCDate() };
}

/** The time of day in the text, in minutes after midnight, or null when none is stated. */
function readTime(text: string): number | null {
  if (/\bnoon\b/.test(text)) return 12 * 60;
  const ampm = text.match(/\b(1[0-2]|0?[1-9])(?::([0-5]\d))?\s*(am|pm)\b/);
  if (ampm) {
    let h = Number(ampm[1]) % 12;
    if (ampm[3] === "pm") h += 12;
    return h * 60 + Number(ampm[2] ?? 0);
  }
  const h24 = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/);
  if (h24) return Number(h24[1]) * 60 + Number(h24[2]);
  return null;
}

/**
 * A follow-up time suggested by the note, or null when the note names no date. `now` is injected so
 * tests are deterministic. The suggestion is always in the future.
 */
export function suggestFollowUp(note: string, now: Date = new Date()): string | null {
  const text = note.toLowerCase();
  const today = istParts(now);
  const time = readTime(text);
  let day: { y: number; m: number; d: number } | null = null;

  const inN = text.match(/\bin (\d{1,2}) (day|week)s?\b/);
  const dated = text.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_WORDS})\\b`));

  if (/\btoday\b/.test(text)) day = addDays(today, 0);
  else if (/\b(tomorrow|tmrw|tmr)\b/.test(text)) day = addDays(today, 1);
  else if (inN) day = addDays(today, Number(inN[1]) * (inN[2] === "week" ? 7 : 1));
  else if (dated) {
    const m = MONTHS.indexOf(dated[2].slice(0, 3));
    const d = Number(dated[1]);
    let y = today.y;
    if (Date.UTC(y, m, d) < Date.UTC(today.y, today.m, today.d)) y += 1;
    day = { y, m, d };
  } else if (/\bnext week\b/.test(text)) {
    day = addDays(today, ((8 - today.weekday) % 7) || 7);
  } else {
    const wd = text.match(new RegExp(`\\b(${WEEKDAY_WORDS})\\b`));
    if (wd) {
      const target = WEEKDAYS.indexOf(wd[1].slice(0, 3));
      day = addDays(today, ((target - today.weekday + 7) % 7) || 7);
    }
  }
  if (!day) return null;

  const value = toValue(day.y, day.m, day.d, time ?? DEFAULT_MIN);
  const when = new Date(`${value}:00+05:30`);
  return when.getTime() > now.getTime() ? value : null;
}

/** `days` from now at the same wall-clock time, nudged into the 9am-8pm slots a follow-up can use. */
export function followUpInDays(days: number, now: Date = new Date()): string {
  const p = istParts(now);
  const day = addDays(p, days);
  // Round up so "48 hours from now" never lands earlier than asked.
  return toValue(day.y, day.m, day.d, Math.ceil(p.minutes / 30) * 30);
}
