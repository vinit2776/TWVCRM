// Replays a rule over the last N days of the real ledger so the number can be chosen
// against history instead of guessed: "this would have sent 6 emails, not 140".

import { addDays, istToday, type HolidayEntry, type LedgerBucket } from "@/lib/energy-baseline";
import { emptyState, isOutOfBand, SLOT_MS, stepSlot, type RuleParams } from "./engine";
import { makeBaselineCtx, typicalFor } from "./baseline";

export const BACKTEST_DAYS = 14;
const IST_OFFSET = "+05:30";

export interface BacktestDay {
  date: string;
  outSlots: number;
  episodes: number;
  emails: number;
  held: number;
}

export interface BacktestResult {
  days: number; // days that had a usable baseline and readings
  outSlots: number; // emails a "mail every out-of-band slot" alert would send
  episodes: number;
  emails: number; // with the protections, after the daily cap
  held: number;
  perDay: BacktestDay[];
}

export function dateStartMs(date: string): number {
  return new Date(`${date}T00:00:00${IST_OFFSET}`).getTime();
}

export function backtestRule(
  rows: LedgerBucket[],
  holidays: HolidayEntry[],
  p: RuleParams,
  dailyCap: number,
  now: Date = new Date()
): BacktestResult {
  const today = istToday(now);
  const ctx = makeBaselineCtx(rows, holidays, today);
  const result: BacktestResult = { days: 0, outSlots: 0, episodes: 0, emails: 0, held: 0, perDay: [] };

  for (let i = BACKTEST_DAYS; i >= 1; i--) {
    const date = addDays(today, -i);
    const curve = ctx.curves.get(date);
    const { typical, peers } = typicalFor(ctx, date);
    if (!curve || peers === 0 || typical.every((v) => v == null)) continue;

    const start = dateStartMs(date);
    let state = emptyState();
    const day: BacktestDay = { date, outSlots: 0, episodes: 0, emails: 0, held: 0 };
    for (let k = 0; k < 96; k++) {
      const actual = curve[k];
      const usual = typical[k];
      if (actual != null && usual != null && isOutOfBand(actual, usual, p)) day.outSlots++;
      const step = stepSlot(state, { tsMs: start + k * SLOT_MS, actualKw: actual, typicalKw: usual }, p);
      state = step.state;
      if (step.opened) day.episodes++;
      step.effects.forEach(() => { if (day.emails < dailyCap) day.emails++; else day.held++; });
    }
    result.days++;
    result.outSlots += day.outSlots; result.episodes += day.episodes; result.emails += day.emails; result.held += day.held;
    result.perDay.push(day);
  }
  return result;
}
