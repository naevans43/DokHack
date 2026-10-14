// Tiny daily mode and the forgiving streak.
//
// Tiny daily mode is opt-in: once on, a review session stops after a small cap
// (default 10 cards or 3 minutes, whichever comes first) with a "done for
// today" screen, so a day's review stays a habit-sized thing rather than a
// backlog to clear. The setting and today's time are per device (localStorage,
// like the session); today's card count also comes from review_log, so a phone
// and a laptop share it when that table exists.
//
// The streak forgives: one missed day between active days doesn't break it,
// only two missed days in a row does -- and a day that isn't over yet never
// counts as missed. It counts active days, so a rest day keeps the run alive
// without adding to it.

export const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** How many missed days in a row a streak survives. */
export const STREAK_GRACE_DAYS = 1;

export interface Streak {
  days: number; // active days in the current run
  activeToday: boolean;
}

/** The current run of active days ending today (see the header comment for the forgiving rule). */
export function forgivingStreak(active: Set<string>, today = new Date()): Streak {
  const d = new Date(today);
  const activeToday = active.has(dayKey(d));
  if (!activeToday) d.setDate(d.getDate() - 1); // today isn't over yet
  let days = 0;
  let gap = 0;
  for (let i = 0; i < 400; i++, d.setDate(d.getDate() - 1)) {
    if (active.has(dayKey(d))) { days++; gap = 0; continue; }
    if (++gap > STREAK_GRACE_DAYS) break;
  }
  return { days, activeToday };
}

// ---- tiny daily mode settings and today's progress ---------------------------

export interface DailySettings {
  on: boolean;
  cards: number;
  minutes: number;
}

export const DEFAULT_DAILY: DailySettings = { on: false, cards: 10, minutes: 3 };
export const CARD_CHOICES = [5, 10, 15, 20];
export const MINUTE_CHOICES = [2, 3, 5, 10];

interface Today { day: string; cards: number; ms: number; extra: boolean }

const SETTINGS_KEY = 'dokhack-daily';
const TODAY_KEY = 'dokhack-daily-today';

function read<T>(key: string): Partial<T> | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<T> | null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
}

export function loadDaily(): DailySettings {
  return { ...DEFAULT_DAILY, ...read<DailySettings>(SETTINGS_KEY) };
}

export function saveDaily(s: DailySettings): void {
  write(SETTINGS_KEY, s);
}

/** Today's progress on this device; resets itself when the date changes. */
export function loadToday(): Today {
  const t = read<Today>(TODAY_KEY);
  const day = dayKey(new Date());
  return t && t.day === day
    ? { day, cards: t.cards ?? 0, ms: t.ms ?? 0, extra: !!t.extra }
    : { day, cards: 0, ms: 0, extra: false };
}

export function saveToday(t: Today): void {
  write(TODAY_KEY, t);
}

/** True once today's cap is reached (and the reader hasn't chosen to keep going). */
export function capReached(s: DailySettings, t: Today): boolean {
  return s.on && !t.extra && (t.cards >= s.cards || t.ms >= s.minutes * 60_000);
}
