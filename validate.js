// ============================================================
// Checking what people type
// ============================================================
// Every rule here runs on the SERVER. The app checks the same
// things so the person gets an answer immediately, but the form
// can be bypassed by anyone calling the API directly — so these
// are the ones that actually count.
//
// Each function returns an error message, or null when the value
// is fine. That makes them easy to chain in a route.
// ============================================================

// ------------------------------------------------------------
// Email
// ------------------------------------------------------------
// Deliberately not the full RFC pattern. That monster accepts
// addresses nobody has ever owned and rejects nothing useful.
// This catches the mistakes people actually make: no @, no dot in
// the domain, spaces, a trailing comma.
// ------------------------------------------------------------
const EMAIL_PATTERN = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

export function checkEmail(value) {
  const email = String(value || '').trim().toLowerCase();

  if (!email) return 'Enter your email address.';
  if (email.length > 120) return 'That email address is too long.';
  if (!EMAIL_PATTERN.test(email)) {
    return 'That does not look like an email address. Check for a missing @ or dot.';
  }

  return null;
}

export function tidyEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// ------------------------------------------------------------
// Pakistani mobile numbers
// ------------------------------------------------------------
// Everything is stored in one shape: 11 digits starting 03.
//
//   03001234567      already right
//   0300 123 4567    spaces and dashes are stripped
//   +923001234567    the country code is converted
//   923001234567     likewise
//
// Anything else is rejected rather than guessed at, because a
// wrong phone number is the one field that makes the whole
// platform useless — it is how students and tutors reach each
// other.
// ------------------------------------------------------------
export function tidyPhone(value) {
  let digits = String(value || '').replace(/[\s\-()]/g, '');

  // +92 300 ... and 92300 ... both become 0300 ...
  if (digits.startsWith('+92')) digits = `0${digits.slice(3)}`;
  else if (digits.startsWith('92') && digits.length === 12) digits = `0${digits.slice(2)}`;

  return digits;
}

export function checkPhone(value) {
  const phone = tidyPhone(value);

  if (!phone) return 'Enter your phone number.';
  if (!/^\d+$/.test(phone)) return 'A phone number can only contain digits.';

  if (phone.length !== 11) {
    return phone.length > 11
      ? 'That is too long. A Pakistani mobile number is 11 digits, like 03001234567.'
      : 'That is too short. A Pakistani mobile number is 11 digits, like 03001234567.';
  }

  // 03 covers every Pakistani mobile network.
  if (!phone.startsWith('03')) {
    return 'Enter a Pakistani mobile number starting 03, like 03001234567.';
  }

  return null;
}

// ------------------------------------------------------------
// Numbers
// ------------------------------------------------------------
export function checkExperience(value) {
  if (value === '' || value == null) return null;   // optional

  const years = Number(value);

  if (Number.isNaN(years)) return 'Experience must be a number.';
  if (years < 0) return 'Experience cannot be negative.';
  if (years > 60) return 'That is more than 60 years. Check the number.';
  if (!Number.isInteger(years)) return 'Enter whole years.';

  return null;
}

export function checkFee(value, subjectName = 'this subject') {
  const fee = Number(value);

  if (Number.isNaN(fee)) return `The fee for ${subjectName} must be a number.`;
  if (fee < 0) return `The fee for ${subjectName} cannot be negative.`;
  if (fee > 200000) return `The fee for ${subjectName} looks wrong. Check the number.`;

  return null;
}

export function checkClassRange(from, to, subjectName = 'this subject') {
  const start = Number(from);
  const end = Number(to);

  if (!Number.isInteger(start) || start < 1 || start > 12) {
    return `Choose a starting class between 1 and 12 for ${subjectName}.`;
  }
  if (!Number.isInteger(end) || end < 1 || end > 12) {
    return `Choose an ending class between 1 and 12 for ${subjectName}.`;
  }
  if (end < start) {
    return `For ${subjectName}, the last class cannot be before the first.`;
  }

  return null;
}

export function checkPassword(value) {
  const password = String(value || '');

  if (password.length < 6) return 'Choose a password of at least 6 characters.';
  if (password.length > 200) return 'That password is too long.';

  return null;
}

export function checkName(value) {
  const name = String(value || '').trim();

  if (!name) return 'Enter your full name.';
  if (name.length < 2) return 'That name is too short.';
  if (name.length > 120) return 'That name is too long.';

  return null;
}

// Runs a list of checks and returns the first problem, or null.
// Keeps routes readable: one call instead of eight if-statements.
export function firstProblem(...checks) {
  for (const problem of checks) {
    if (problem) return problem;
  }
  return null;
}
