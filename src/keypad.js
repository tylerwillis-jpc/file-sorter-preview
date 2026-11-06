/* JPC File Sorter · v0.2.1-beta · keypad.js
 * Sticky keypad numbers. Pure functions: no DOM, no storage. Tested in tests/keypad.test.html.
 *
 * Per-person state: { homes: {folder: number}, usage: {folder: count}, sorted: number, locked: bool }
 *
 * Rules
 *  - A folder's first appearance gives it the lowest free unowned number: its "home".
 *  - It always returns to its home number.
 *  - If the owner of a number isn't on this file, another folder may borrow it ("spare key").
 *  - If a folder has no home available (all 9 owned, or locked), it goes on any free key as a spare.
 *  - After `learningFiles` sorted files, numbers lock to the 9 most-used folders.
 */

export const KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export function emptyKeypadState() {
  return { homes: {}, usage: {}, sorted: 0, locked: false };
}

/** The ~9 most likely folders for a file: Claude's pick, its alternatives, this person's most used, then defaults. */
export function candidateFolders({ pick, alts = [], usage = {}, common = [], approved }) {
  const out = [];
  const add = (f) => { if (f && (!approved || approved.includes(f)) && !out.includes(f) && out.length < 9) out.push(f); };
  add(pick);
  alts.forEach(add);
  Object.entries(usage).sort((a, b) => b[1] - a[1]).forEach(([f]) => add(f));
  common.forEach(add);
  (approved || []).forEach(add);
  return out;
}

/**
 * Lay out candidate folders on keys 1–9.
 * Returns { keys: {n: {folder, spare}}, state } — `state` has any new homes assigned (when not locked).
 */
export function assignKeys(candidates, state) {
  const homes = { ...state.homes };
  const owners = {}; // number -> folder
  for (const [f, n] of Object.entries(homes)) owners[n] = f;
  const keys = {};
  const placed = new Set();

  // 1. Folders with a home number go there.
  for (const f of candidates) {
    const n = homes[f];
    if (n && !keys[n]) { keys[n] = { folder: f, spare: false }; placed.add(f); }
  }
  // 2. Others: claim the lowest free unowned number as home (learning only), else a spare key.
  for (const f of candidates) {
    if (placed.has(f)) continue;
    let n = null, spare = true;
    if (!state.locked && !homes[f]) {
      n = KEYS.find((k) => !owners[k] && !keys[k]);
      if (n) { homes[f] = n; owners[n] = f; spare = false; }
    }
    if (!n) n = KEYS.find((k) => !keys[k]);
    if (!n) break;
    keys[n] = { folder: f, spare };
    placed.add(f);
  }
  return { keys, state: { ...state, homes } };
}

/** Record one sorted file for this person; locks numbers at the threshold. */
export function recordUse(state, folder, learningFiles = 50) {
  const usage = { ...state.usage, [folder]: (state.usage[folder] || 0) + 1 };
  let next = { ...state, usage, sorted: state.sorted + 1 };
  if (!next.locked && next.sorted >= learningFiles) next = lockNumbers(next);
  return next;
}

/** Undo one sorted file (does not unlock). */
export function unrecordUse(state, folder) {
  const usage = { ...state.usage };
  if (usage[folder]) usage[folder] -= 1;
  if (usage[folder] <= 0) delete usage[folder];
  return { ...state, usage, sorted: Math.max(0, state.sorted - 1) };
}

/**
 * Lock: the 9 most-used folders get numbers. A folder keeps its existing number unless a
 * more-used folder already holds it; the rest fill free numbers, lowest first.
 */
export function lockNumbers(state) {
  const ranked = Object.entries(state.usage).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([f]) => f);
  const homes = {};
  const taken = new Set();
  const needNumber = [];
  for (const f of ranked) {
    const n = state.homes[f];
    if (n && !taken.has(n)) { homes[f] = n; taken.add(n); } else needNumber.push(f);
  }
  for (const f of needNumber) {
    const n = KEYS.find((k) => !taken.has(k));
    if (!n) break;
    homes[f] = n; taken.add(n);
  }
  return { ...state, homes, locked: true };
}

export function resetNumbers() {
  return emptyKeypadState();
}
