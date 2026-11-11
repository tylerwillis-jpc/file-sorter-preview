/* JPC File Sorter · v0.4.1-beta · plan.js
 * Kept-copy rule and the simulated change plan. Nothing here performs any action:
 * it only describes what a future cleanup *would* do. See docs/change-plan-schema.md.
 *
 * ONE action model: planForDecision() is the only place actions are worked out. The Review
 * cards, summary totals, before/after trees, conflict checks and the export all use it.
 *
 * Safety rules the plan follows:
 *  - Nothing is deleted: duplicates go to "_Duplicate Hold", mirroring their original path,
 *    with a shortcut to the kept copy left in each old spot.
 *  - Only copies verified identical (the report's content hash, same size) are ever held.
 *    Unverified copies stay where they are.
 *  - The kept copy is never held; a file never ends up with zero copies outside the hold.
 *  - Moves keep the kept copy's own file name (never a silent rename).
 *  - Order: holds first, then the move, then shortcuts, so a move never lands on a copy that's
 *    still there, and no shortcut ever points at itself.
 *  - The kept copy is the one saved with the decision. If it's gone, the file is Blocked.
 *  - Unsure files: no change.
 */
import { DUPLICATE_HOLD_FOLDER, PROPERTY } from './config.js';
import { pathParts, topFolder } from './util.js';

const LIB = PROPERTY.library;
export const SHORTCUT_EXT = '.url'; // proposal: an internet-shortcut file in the old spot (see schema doc)

const baseName = (path) => path.split('/').at(-1);
const lower = (p) => p.toLowerCase();

/**
 * Kept-copy rule: a copy already in the chosen folder (nothing moves) → otherwise the report's KEEP →
 * otherwise the newest. A manual choice overrides the rule. If the manual copy no longer exists,
 * returns { copy: null, missing: true } instead of silently picking another.
 */
export function keptCopy(file, folder, manualPath = null) {
  if (manualPath) {
    const c = file.copies.find((x) => x.path === manualPath);
    return c ? { copy: c, manual: true } : { copy: null, manual: true, missing: true };
  }
  const inFolder = folder ? file.copies.filter((c) => topFolder(c.path) === folder) : [];
  if (inFolder.length) return { copy: newest(inFolder), manual: false, why: 'already in folder' };
  const fromReport = file.copies.find((c) => c.reportKeep);
  if (fromReport) return { copy: fromReport, manual: false, why: 'report KEEP' };
  return { copy: newest(file.copies), manual: false, why: 'newest' };
}
const newest = (copies) => [...copies].sort((a, b) => (b.modified || '').localeCompare(a.modified || ''))[0];

export const holdPath = (path) => [LIB, DUPLICATE_HOLD_FOLDER, ...pathParts(path)].join('/');
export const destinationPath = (folder, name) => [LIB, folder, name].join('/');
export const shortcutPath = (path) => path + SHORTCUT_EXT;
export const verifiedIdentical = (file) => /^identical/.test(file.duplicateCheck || '');

/** The kept copy a decision refers to: the one saved with it, or (older decisions) the rule. */
export function decisionKept(file, decision) {
  if (decision.keptPath) return keptCopy(file, decision.folder, decision.keptPath);
  return keptCopy(file, decision.folder, null);
}

/** Planned actions for one decision, in the order a cleanup would perform them. */
export function planForDecision(file, decision) {
  if (!decision) return [];
  const base = {
    fileId: file.id, file: file.name, folder: decision.folder,
    decisionBy: decision.decidedBy, decidedAt: decision.decidedAt, editedBy: decision.editedBy || '',
    reviewedBy: decision.reviewedBy || '', reviewedAt: decision.reviewedAt || '',
    duplicateCheck: file.duplicateCheck || '', appVersion: decision.appVersion || '',
  };
  const act = (a) => ({ ...base, ...a });
  if (decision.folder === 'Unsure') {
    return file.copies.map((c) => act({ step: 0, action: 'No change', from: c.path, to: c.path, size: c.size, modified: c.modified, note: 'Unsure: stays where it is' }));
  }
  const { copy, missing } = decisionKept(file, decision);
  if (!copy || missing) {
    return [act({ step: 0, action: 'Blocked', from: decision.keptPath || '', to: '', note: 'The kept copy chosen for this decision is no longer in the inventory' })];
  }
  const stays = topFolder(copy.path) === decision.folder;
  const keptTo = stays ? copy.path : destinationPath(decision.folder, baseName(copy.path));
  const others = file.copies.filter((c) => c !== copy);
  const canHold = verifiedIdentical(file);
  const actions = [];
  // 1. Holds first: every other verified-identical copy leaves its spot before anything moves in.
  if (canHold) for (const c of others) actions.push(act({ step: 1, action: 'Hold', from: c.path, to: holdPath(c.path), size: c.size, modified: c.modified }));
  // 2. The kept copy moves (keeping its own name), or stays.
  actions.push(act({ step: 2, action: stays ? 'Stays' : 'Move', from: copy.path, to: keptTo, kept: true, size: copy.size, modified: copy.modified }));
  // 3. Shortcuts in each held copy's old spot, except where the kept copy now is.
  if (canHold) {
    for (const c of others) {
      if (lower(c.path) === lower(keptTo)) continue; // the kept copy now sits here: no self-shortcut
      actions.push(act({ step: 3, action: 'Shortcut', from: shortcutPath(c.path), to: keptTo, note: 'Shortcut to the kept copy, in the held copy\'s old spot' }));
    }
  } else {
    for (const c of others) actions.push(act({ step: 0, action: 'No change', from: c.path, to: c.path, size: c.size, modified: c.modified, note: `Not held: ${file.duplicateCheck || 'not verified identical'}` }));
  }
  return actions;
}

export function buildPlan(files, decisions) {
  const byId = new Map(files.map((f) => [f.id, f]));
  const actions = [];
  for (const d of decisions) { const f = byId.get(d.fileId); if (f) actions.push(...planForDecision(f, d)); }
  return actions;
}

export function planSummary(files, decisions) {
  const byId = new Map(files.map((f) => [f.id, f]));
  let sorted = 0, move = 0, stays = 0, hold = 0, shortcuts = 0, reviewed = 0, unsure = 0, blocked = 0;
  for (const d of decisions) {
    const f = byId.get(d.fileId);
    if (!f) continue;
    if (d.reviewedBy) reviewed++;
    if (d.folder === 'Unsure') { unsure++; continue; }
    sorted++;
    for (const a of planForDecision(f, d)) {
      if (a.action === 'Move') move++;
      else if (a.action === 'Stays') stays++;
      else if (a.action === 'Hold') hold++;
      else if (a.action === 'Shortcut') shortcuts++;
      else if (a.action === 'Blocked') blocked++;
    }
  }
  return { sorted, move, stays, hold, shortcuts, reviewed, unsure, blocked, total: decisions.length };
}

/**
 * Things a real cleanup would trip on, checked against the WHOLE library (not just the test scope).
 * Works out where every file would end up after the cleanup, then flags any spot two different
 * files would share, paths that are too long, kept copies that are gone, and decisions that no
 * longer match a file in the inventory. Runs in one pass using lookup tables.
 *   allFiles:  every file in the inventory
 *   decisions: decisions to check (the plan's scope)
 *   allDecisionsById: every decision, so other sorted files are placed where they'd really end up
 */
export function conflictChecks(allFiles, decisions, { maxPathLength = 400, sitePath = '', allDecisionsById = null } = {}) {
  const byId = new Map(allFiles.map((f) => [f.id, f]));
  const decById = allDecisionsById || Object.fromEntries(decisions.map((d) => [d.fileId, d]));
  const checkIds = new Set(decisions.map((d) => d.fileId));
  const issues = [];
  const final = new Map(); // lowercase path -> Set of fileIds that would be there after the cleanup
  const place = (path, fileId) => { const k = lower(path); if (!final.has(k)) final.set(k, { path, ids: new Set() }); final.get(k).ids.add(fileId); };
  const planned = new Map();
  for (const f of allFiles) {
    const d = decById[f.id];
    const acts = d ? planForDecision(f, d) : [];
    planned.set(f.id, acts);
    if (!d || d.folder === 'Unsure' || acts.some((a) => a.action === 'Blocked')) { for (const c of f.copies) place(c.path, f.id); continue; }
    for (const a of acts) {
      if (a.action === 'Move' || a.action === 'Stays' || a.action === 'Hold') place(a.to, f.id);
      else if (a.action === 'Shortcut') place(a.from, f.id);
      else if (a.action === 'No change') place(a.to, f.id);
    }
  }
  for (const d of decisions) {
    const f = byId.get(d.fileId);
    if (!f) { issues.push({ fileId: d.fileId, fileName: d.fileName, kind: 'Not in current inventory', detail: 'This decision\'s file is not in the loaded inventory (moved, renamed or removed since). It needs reconciling.' }); continue; }
    for (const a of planned.get(f.id) || []) {
      if (a.action === 'Blocked') issues.push({ fileId: f.id, kind: 'Kept copy missing', detail: a.note });
      const len = sitePath.length + 1 + (a.action === 'Shortcut' ? a.from : a.to).length;
      if (a.action !== 'No change' && a.action !== 'Blocked' && len > maxPathLength) issues.push({ fileId: f.id, kind: 'Path too long', detail: `${len} characters including the site address (limit ${maxPathLength}): ${a.action === 'Shortcut' ? a.from : a.to}` });
    }
  }
  for (const { path, ids } of final.values()) {
    if (ids.size < 2) continue;
    const involved = [...ids];
    for (const id of involved) {
      if (!checkIds.has(id)) continue;
      const others = involved.filter((x) => x !== id).map((x) => byId.get(x)?.name || x);
      issues.push({ fileId: id, kind: 'Same name, same folder', detail: `${path} would also hold a different file (${others.slice(0, 3).join(', ')}${others.length > 3 ? '…' : ''})` });
    }
  }
  return issues;
}

/** A short fingerprint of a plan, so an approval can be tied to exactly this plan. */
export function planFingerprint(actions) {
  let h = 0x811c9dc5;
  const text = actions.map((a) => `${a.fileId}|${a.action}|${a.from}|${a.to}`).sort().join('\n');
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0') + '-' + actions.length;
}

/**
 * Folder trees for the Review tab, built from the same actions as everything else.
 * before: every copy where it lives today, tagged. after: the simulated result.
 */
export function buildTrees(files, decisionsById) {
  const before = newNode(LIB), after = newNode(LIB);
  const hold = newNode(DUPLICATE_HOLD_FOLDER);
  const notSorted = newNode('Not sorted yet: left exactly where they are');
  const leftInPlace = newNode('Not verified identical: left where they are');
  let shortcuts = 0;
  for (const f of files) {
    const d = decisionsById[f.id];
    const acts = d ? planForDecision(f, d) : [];
    const byFrom = new Map(acts.filter((a) => a.action !== 'Shortcut').map((a) => [a.from, a]));
    for (const c of f.copies) {
      const a = byFrom.get(c.path);
      let tag;
      if (!d) tag = { label: 'not sorted yet', tone: 'muted' };
      else if (d.folder === 'Unsure') tag = { label: 'Unsure', tone: 'warn' };
      else if (acts.some((x) => x.action === 'Blocked')) tag = { label: 'blocked', tone: 'danger' };
      else if (!a) tag = { label: '?', tone: 'muted' };
      else if (a.action === 'Stays') tag = { label: 'kept · stays', tone: 'ok' };
      else if (a.action === 'Move') tag = { label: `kept → ${d.folder}`, tone: 'info' };
      else if (a.action === 'Hold') tag = { label: 'duplicate → hold', tone: 'danger' };
      else tag = { label: 'not verified · stays', tone: 'warn' };
      insert(before, pathParts(c.path), { name: baseName(c.path), fileId: f.id, tag, path: c.path });
    }
    if (!d || d.folder === 'Unsure' || acts.some((x) => x.action === 'Blocked')) {
      for (const c of f.copies) insert(notSorted, pathParts(c.path), { name: baseName(c.path), fileId: f.id, tag: d ? { label: d.folder === 'Unsure' ? 'Unsure' : 'blocked', tone: 'warn' } : null, path: c.path });
      continue;
    }
    for (const a of acts) {
      if (a.action === 'Stays') insert(after, pathParts(a.to), { name: baseName(a.to), fileId: f.id, tag: { label: 'already here', tone: 'ok' } });
      else if (a.action === 'Move') insert(after, pathParts(a.to), { name: baseName(a.to), fileId: f.id, tag: { label: `from ${pathParts(a.from).slice(0, -1).join(' › ')}`, tone: 'plain' } });
      else if (a.action === 'Hold') insert(hold, pathParts(a.from), { name: baseName(a.from), fileId: f.id, tag: { label: `from ${pathParts(a.from).slice(0, -1).join(' › ')}`, tone: 'plain' } });
      else if (a.action === 'Shortcut') shortcuts++;
      else if (a.action === 'No change') insert(leftInPlace, pathParts(a.from), { name: baseName(a.from), fileId: f.id, tag: { label: 'not verified', tone: 'warn' } });
    }
  }
  return { before, after, hold, notSorted, leftInPlace, shortcuts };
}
function newNode(name) { return { name, children: new Map(), files: [] }; }
function insert(root, parts, file) {
  let node = root;
  for (const seg of parts.slice(0, -1)) {
    if (!node.children.has(seg)) node.children.set(seg, newNode(seg));
    node = node.children.get(seg);
  }
  node.files.push(file);
}
export function countFiles(node) {
  let n = node.files.length;
  for (const c of node.children.values()) n += countFiles(c);
  return n;
}
