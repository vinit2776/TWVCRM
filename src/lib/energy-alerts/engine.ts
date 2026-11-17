// The decision engine for energy slot alerts. Pure: no database, no clock, no email.
// It turns a stream of 15-minute readings into "episodes" and says when an email is
// warranted. The point is that a deviation that carries on is ONE episode that is
// notified once, then only on a worsening step or a back-off reminder — never per slot.

export const SLOT_MS = 15 * 60 * 1000;

export type Direction = "both" | "high" | "low";
export type ReminderSchedule = "std" | "4h" | "none";

// Slots (15 min each) after an episode opens at which a reminder may go out. The list
// length is the cap, so a forgotten alert can never become a steady stream.
export const REMINDER_SLOTS: Record<ReminderSchedule, number[]> = {
  std: [8, 24, 96], // 2h, 6h, 24h
  "4h": [16, 32, 48, 64, 80, 96], // every 4h, max 6
  none: [],
};

export const REMINDER_LABELS: Record<ReminderSchedule, string> = {
  std: "after 2h, 6h and 24h (max 3)",
  "4h": "every 4h (max 6)",
  none: "none",
};

// An episode only counts as recovered once usage is well inside the tolerance, not
// merely back under it — otherwise usage hovering at the edge would open and close
// (and email) repeatedly.
export const RECOVER_FRACTION = 0.6;
// A further email for a worsening deviation is allowed at 1x, 2x and 4x the tolerance.
export const STEP_MULTIPLES = [1, 2, 4] as const;

export interface RuleParams {
  tolerancePct: number;
  minKw: number;
  direction: Direction;
  persistSlots: number;
  recoverSlots: number;
  reminder: ReminderSchedule;
}

export interface OpenEpisode {
  dir: 1 | -1;
  startedMs: number;
  openedMs: number;
  peakDevPct: number; // absolute, in percent
  step: number;
  remindersSent: number;
  calmSlots: number;
  extraKwh: number;
  acked: boolean;
}

export interface EngineState {
  streakSlots: number;
  streakDir: 0 | 1 | -1;
  streakKwh: number;
  episode: OpenEpisode | null;
}

export interface SlotReading {
  tsMs: number; // slot start
  actualKw: number | null;
  typicalKw: number | null;
}

export type AlertKind = "opened" | "worse" | "reminder" | "resolved";

export interface AlertEffect {
  kind: AlertKind;
  tsMs: number;
  actualKw: number;
  typicalKw: number;
  devPct: number; // signed
  extraKwh: number;
}

export interface StepResult {
  state: EngineState;
  effects: AlertEffect[];
  opened: boolean;
  closed: OpenEpisode | null;
}

export function emptyState(): EngineState {
  return { streakSlots: 0, streakDir: 0, streakKwh: 0, episode: null };
}

export function stepOf(absDevFraction: number, tolFraction: number): number {
  if (absDevFraction >= tolFraction * STEP_MULTIPLES[2]) return 3;
  if (absDevFraction >= tolFraction * STEP_MULTIPLES[1]) return 2;
  return 1;
}

/** Is this slot out of band for the rule? Also true only when it is far enough in kW to matter. */
export function isOutOfBand(actualKw: number, typicalKw: number, p: RuleParams): boolean {
  if (typicalKw <= 0) return false;
  const diff = actualKw - typicalKw;
  const dirOk = p.direction === "both" || (p.direction === "high" && diff > 0) || (p.direction === "low" && diff < 0);
  return dirOk && (Math.abs(diff) / typicalKw) * 100 > p.tolerancePct && Math.abs(diff) >= p.minKw;
}

export function stepSlot(prev: EngineState, slot: SlotReading, p: RuleParams): StepResult {
  const state: EngineState = { ...prev, episode: prev.episode ? { ...prev.episode } : null };
  const none: StepResult = { state, effects: [], opened: false, closed: null };

  // No trustworthy figure for this slot (meter gap, or not enough history to say what is
  // usual). It can break a building streak, but never opens, worsens or closes an episode.
  if (slot.actualKw == null || slot.typicalKw == null || slot.typicalKw <= 0) {
    if (!state.episode) { state.streakSlots = 0; state.streakDir = 0; state.streakKwh = 0; }
    return none;
  }

  const a = slot.actualKw;
  const t = slot.typicalKw;
  const diff = a - t;
  const absDev = Math.abs(diff) / t;
  const sign: 1 | -1 = diff >= 0 ? 1 : -1;
  const devPct = (diff / t) * 100;
  const out = isOutOfBand(a, t, p);
  const effects: AlertEffect[] = [];
  const effect = (kind: AlertKind, extraKwh: number): void => {
    effects.push({ kind, tsMs: slot.tsMs, actualKw: a, typicalKw: t, devPct, extraKwh });
  };

  if (!state.episode) {
    if (out) {
      if (state.streakDir === sign) state.streakSlots++;
      else { state.streakSlots = 1; state.streakDir = sign; state.streakKwh = 0; }
      state.streakKwh += Math.abs(diff) * 0.25;
    } else {
      state.streakSlots = 0; state.streakDir = 0; state.streakKwh = 0;
    }
    if (state.streakSlots >= p.persistSlots) {
      const ep: OpenEpisode = {
        dir: sign,
        startedMs: slot.tsMs - (p.persistSlots - 1) * SLOT_MS,
        openedMs: slot.tsMs,
        peakDevPct: absDev * 100,
        step: stepOf(absDev, p.tolerancePct / 100),
        remindersSent: 0,
        calmSlots: 0,
        extraKwh: state.streakKwh,
        acked: false,
      };
      state.episode = ep;
      state.streakSlots = 0; state.streakDir = 0; state.streakKwh = 0;
      effect("opened", ep.extraKwh);
      return { state, effects, opened: true, closed: null };
    }
    return { state, effects, opened: false, closed: null };
  }

  const ep = state.episode;
  ep.extraKwh += Math.abs(diff) * 0.25;

  if (out && sign === ep.dir) {
    ep.calmSlots = 0;
    ep.peakDevPct = Math.max(ep.peakDevPct, absDev * 100);
    const st = stepOf(absDev, p.tolerancePct / 100);
    // A worsening step may email even when acknowledged: "I know" does not cover "it got worse".
    if (st > ep.step) { ep.step = st; effect("worse", ep.extraKwh); }
  } else if (absDev * 100 < p.tolerancePct * RECOVER_FRACTION) {
    ep.calmSlots++;
  } else {
    ep.calmSlots = 0;
  }

  if (ep.calmSlots >= p.recoverSlots) {
    const closed = ep;
    state.episode = null;
    effect("resolved", closed.extraKwh);
    return { state, effects, opened: false, closed };
  }

  const schedule = REMINDER_SLOTS[p.reminder];
  if (!ep.acked && ep.remindersSent < schedule.length && (slot.tsMs - ep.openedMs) / SLOT_MS >= schedule[ep.remindersSent]) {
    ep.remindersSent++;
    effect("reminder", ep.extraKwh);
  }
  return { state, effects, opened: false, closed: null };
}
