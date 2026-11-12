'use strict';

// Salary wallet: the dashboard card that starts the month at the employee's full salary
// and marks each day as secured or lost from their attendance. Pure computation only —
// server.js gathers each day's status (computeDayStatus) and renders the card.

// How much one day is worth. For now every calendar day counts the same, Sundays
// included: monthly salary ÷ the days in that month (₹30,000 in November = ₹1,000 a day).
// This is the one place to change if payroll moves to paying by working days.
function dailyRate(monthlySalary, year, month) {
  return monthlySalary / new Date(year, month, 0).getDate();
}

// What a day does to the wallet:
//   secured   the full day's pay is kept (Present, Late)
//   half      half kept, half lost (Half Day, Missed Checkout)
//   lost      the day's pay is gone (Absent, unpaid leave)
//   paid      a paid day off (Week Off, Holiday, paid leave)
//   hold      waiting on a manager (Punch Error, a pending branch review); neither total
//   today     today, still in progress
//   upcoming  later this month
//   not_joined before the employee's join date; not part of their pay
const SHARE_KEPT = { secured: 1, paid: 1, half: 0.5, lost: 0 };

const DONE_TODAY = new Set(['Present', 'Late', 'Half Day', 'Week Off', 'Holiday', 'On Leave', 'Missed Checkout', 'Punch Error']);

function dayOutcome(day, { today, dateJoined, leavePaid }) {
  if (dateJoined && day.date < dateJoined) return 'not_joined';
  if (day.date > today) return 'upcoming';
  if (day.date === today && !DONE_TODAY.has(day.status)) return 'today';
  if (day.deviation === 'pending') return 'hold';
  switch (day.status) {
    case 'Present':
    case 'Late':
      return 'secured';
    case 'Half Day':
    // The app already tells employees a missed check-out "counts as a Half Day until you
    // submit a correction" — the wallet says the same, and the money comes back once the
    // correction is approved.
    case 'Missed Checkout':
      return 'half';
    case 'Absent':
      return 'lost';
    case 'Week Off':
    case 'Holiday':
      return 'paid';
    case 'On Leave':
      return leavePaid ? 'paid' : 'lost';
    case 'Punch Error':
      return 'hold';
    default:
      return 'upcoming';
  }
}

// days: computeDayStatus results for every date of the month, in date order.
// monthlyPaidLeave: { types: [...], cap: n } — leave types where only the first `cap`
// days a month are paid (the same rule as the Leave Balance card); other approved leave
// (Comp Off) is always paid.
function computeSalaryWallet({ monthlySalary, year, month, today, dateJoined = null, days, monthlyPaidLeave = { types: [], cap: 0 } }) {
  const rate = dailyRate(monthlySalary, year, month);
  const leaveTaken = {};
  const blocks = days.map(day => {
    let leavePaid = true;
    if (day.status === 'On Leave' && monthlyPaidLeave.types.includes(day.label)) {
      leaveTaken[day.label] = (leaveTaken[day.label] || 0) + 1;
      leavePaid = leaveTaken[day.label] <= monthlyPaidLeave.cap;
    }
    const outcome = dayOutcome(day, { today, dateJoined, leavePaid });
    const kept = outcome in SHARE_KEPT ? SHARE_KEPT[outcome] * rate : 0;
    const lost = outcome in SHARE_KEPT ? rate - kept : 0;
    return { date: day.date, day: Number(day.date.slice(8, 10)), status: day.status, label: day.label || null, outcome, secured: kept, lost };
  });

  const secured = blocks.reduce((sum, b) => sum + b.secured, 0);
  const lost = blocks.reduce((sum, b) => sum + b.lost, 0);
  const notJoined = blocks.filter(b => b.outcome === 'not_joined').length * rate;

  // Present days in a row, counting back from the latest finished day. Paid days off and
  // days on hold neither add to it nor break it.
  let streak = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const o = blocks[i].outcome;
    if (o === 'upcoming' || o === 'today' || o === 'paid' || o === 'hold') continue;
    if (o === 'secured') streak++;
    else break;
  }

  return {
    monthlySalary,
    dailyRate: rate,
    takeHome: monthlySalary - lost - notJoined,
    secured,
    lost,
    streak,
    blocks,
    todayBlock: blocks.find(b => b.date === today) || null,
  };
}

module.exports = { dailyRate, dayOutcome, computeSalaryWallet };
