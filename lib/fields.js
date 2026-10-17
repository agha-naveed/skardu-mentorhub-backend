// ============================================================
// Academic fields
// ============================================================
// In Class 9, Class 10, 1st year (11) and 2nd year (12) a student
// follows a field. They are stored as keys; the label is for people.
// ============================================================
export const FIELDS = {
  engineering: 'Engineering',
  medical: 'Medical',
  computer_science: 'Computer Science',
};
export const FIELD_KEYS = Object.keys(FIELDS);
export const FIELD_CLASS_MIN = 9;
export const FIELD_CLASS_MAX = 12;

export const hasFields = (classLevel) =>
  Number.isInteger(Number(classLevel)) && Number(classLevel) >= FIELD_CLASS_MIN && Number(classLevel) <= FIELD_CLASS_MAX;

export const fieldLabel = (key) => FIELDS[key] || null;

// One value, as a student or a video carries it.
// Returns { value } (null = none) or { error }.
export function cleanField(input, classLevel) {
  if (input === undefined || input === null || input === '') return { value: null };
  if (!FIELD_KEYS.includes(input)) return { error: 'Choose Engineering, Medical or Computer Science.' };
  if (classLevel != null && !hasFields(classLevel)) return { value: null };   // not applicable: quietly none
  return { value: input };
}

// The list a tutor ticks for a subject. Empty, or all three, both mean
// "every field" and are stored as NULL — which is also what every row
// that existed before this feature has.
export function cleanFieldList(input, classFrom, classTo) {
  if (input === undefined || input === null) return { value: null };
  const list = Array.isArray(input) ? input : [input];
  if (list.some((f) => !FIELD_KEYS.includes(f))) return { error: 'Choose Engineering, Medical or Computer Science.' };
  const unique = [...new Set(list)];
  if (unique.length === 0 || unique.length === FIELD_KEYS.length) return { value: null };
  // A subject taught only for Class 1-8 has no fields.
  if (Number(classTo) < FIELD_CLASS_MIN || Number(classFrom) > FIELD_CLASS_MAX) return { value: null };
  return { value: unique };
}
