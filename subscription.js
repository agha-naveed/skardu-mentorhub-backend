// ============================================================
// Subscriptions — a calendar month at a time
// ============================================================
// A tutor pays the administrator by hand (Easypaisa, JazzCash or
// bank). The money moves outside the app; the app keeps the dates.
//
//   · A verified payment covers the CALENDAR MONTH it is for.
//   · Payment is due by the 3rd (admin can change the day).
//   · A tutor whose month is not verified by the 3rd is suspended
//     automatically and removed from search. They can still sign in
//     and send a receipt; verification restores them at once.
//   · A newly approved tutor gets the rest of that month free.
//
// `subscription_paid_until` is the LAST DAY of the covered month.
// "Today" is always Pakistan time, so a server running in UTC does
// not move the deadline by a day.
// ============================================================
export const DEFAULT_DUE_DAY = 3;
export const TIME_ZONE = 'Asia/Karachi';

// 'YYYY-MM-DD' for the given moment, in Pakistan.
export function todayPK(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

const parts = (ymd) => {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  return { y, m, d };
};
const pad = (n) => String(n).padStart(2, '0');

// Last day of the month containing ymd.
export function endOfMonth(ymd) {
  const { y, m } = parts(ymd);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(last)}`;
}

// First day of the month AFTER the one containing ymd.
export function firstOfNextMonth(ymd) {
  const { y, m } = parts(ymd);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${pad(m + 1)}-01`;
}

export function firstOfMonth(ymd) {
  const { y, m } = parts(ymd);
  return `${y}-${pad(m)}-01`;
}

// The due date for the month containing ymd.
export function dueDateFor(ymd, dueDay = DEFAULT_DUE_DAY) {
  const { y, m } = parts(ymd);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${pad(m)}-${pad(Math.min(dueDay, last))}`;
}

function daysBetween(fromYmd, toYmd) {
  const a = parts(fromYmd), b = parts(toYmd);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}

// The month a payment made today should cover.
//   · This month not yet paid  -> this month (also when paying late
//     in the month: the month is the unit, not the number of days).
//   · This month already paid  -> next month (paying ahead).
export function nextPaidUntil(currentPaidUntil, today = todayPK()) {
  const thisMonthEnd = endOfMonth(today);
  const current = currentPaidUntil ? String(currentPaidUntil).slice(0, 10) : null;

  if (current && current >= thisMonthEnd) {
    return endOfMonth(firstOfNextMonth(current));
  }
  return thisMonthEnd;
}

// ------------------------------------------------------------
// Where a tutor stands, in words the app can show directly
// ------------------------------------------------------------
//   state  'paid' | 'due' | 'suspended' | 'unset'
// ------------------------------------------------------------
export function subscriptionState(tutor, hasClaim = false, { today = todayPK(), dueDay = DEFAULT_DUE_DAY } = {}) {
  const paidUntil = tutor?.subscription_paid_until
    ? String(tutor.subscription_paid_until).slice(0, 10) : null;

  const nextDue = paidUntil && paidUntil >= today
    ? dueDateFor(firstOfNextMonth(paidUntil), dueDay)
    : dueDateFor(today, dueDay);

  const base = {
    paid_until: paidUntil,
    due_day: dueDay,
    next_due: nextDue,
    has_claim: hasClaim,
    // kept so older screens do not break
    grace_day: null, grace_days: 0, suspended_until: null,
  };

  if (tutor?.payment_suspended) {
    return {
      ...base, state: 'suspended', listed: false, days_left: 0,
      message: hasClaim
        ? 'Your account is suspended. Your receipt is with the administrator — you are restored as soon as they verify it.'
        : `Your account is suspended and hidden from search because the monthly payment was not verified by the ${dueDay}th. Send your receipt to restore it.`,
    };
  }

  if (!paidUntil) {
    return { ...base, state: 'unset', listed: true, days_left: null,
      message: 'Your subscription starts once your profile is approved.' };
  }

  if (paidUntil >= today) {
    const left = daysBetween(today, paidUntil) + 1;
    return {
      ...base, state: 'paid', listed: true, days_left: left,
      message: `Paid for this month, until ${paidUntil}.`,
    };
  }

  // Month not covered, deadline not reached yet — or reached and the
  // scheduler has not run yet.
  const due = dueDateFor(today, dueDay);
  const left = Math.max(0, daysBetween(today, due));
  return {
    ...base, state: 'due', listed: true, days_left: left,
    message: hasClaim
      ? 'Your receipt is with the administrator. Once it is verified you are covered for this month.'
      : left === 0
        ? `Payment is due today (the ${dueDay}th). Send your receipt now or you will be suspended.`
        : `Payment for this month is due by the ${dueDay}th — ${left} day${left === 1 ? '' : 's'} left. Send your receipt to stay in search.`,
  };
}
