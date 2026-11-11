/* JPC File Sorter · v0.4.1-beta · keypad.js
 * Sticky keypad numbers. Pure functions: no DOM, no storage. Tested in tests/index.html.
 *
 * Per-person state: { homes: {folder: number}, usage: {folder: count}, sorted: number, locked: bool }
 *
 * Rules
 *  - The first time a folder is CHOSEN, it gets the lowest number nobody owns: its "home".
 *    (Folders that are only shown, never chosen, don't take a home number.)
 *  - It always returns to its home number.
 *  - Folders without a home sit on numbers nobody owns yet (not marked spare).
 *  - If the owner of a number isn't on this file, another folder may borrow it ("spare key").
 *  - After `learningFiles` sorted files, numbers lock to the 9 most-used folders.
 *  - Drawing the keypad never changes the saved state.
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
 * Lay out candidate folders on keys 1–9 without changing any state.
 * Returns { keys: {n: {folder, spare}} }.
 */
export function assignKeys(candidates, state) {
  const owners = {}; // number -> folder
  for (const [f, n] of Object.entries(state.homes)) owners[n] = f;
  const keys = {};
  const placed = new Set();
  // 1. Folders with a home number go there.
  for (const f of candidates) {
    const n = state.homes[f];
    if (n && !keys[n]) { keys[n] = { folder: f, spare: false }; placed.add(f); }
  }
  // 2. Others: a number nobody owns yet (not spare), else borrow an absent owner's number (spare).
  for (const f of candidates) {
    if (placed.has(f)) continue;
    let n = KEYS.find((k) => !owners[k] && !keys[k]);
    let spare = false;
    if (!n) { n = KEYS.find((k) => !keys[k]); spare = true; }
    if (!n) break;
    keys[n] = { folder: f, spare };
    placed.add(f);
  }
  return { keys, state };
}

/** Record one choice (a single file, or one folder decision counted once); locks numbers at the threshold. */
export function recordUse(state, folder, learningFiles = 50, files = 1) {
  const usage = { ...state.usage, [folder]: (state.usage[folder] || 0) + 1 };
  const homes = { ...state.homes };
  if (!state.locked && !homes[folder]) {
    const owned = new Set(Object.values(homes));
    const n = KEYS.find((k) => !owned.has(k));
    if (n) homes[folder] = n;
  }
  let next = { ...state, homes, usage, sorted: state.sorted + files };
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
