/* JPC File Sorter · v0.3.1-beta · plan.js
 * Kept-copy rule and the simulated change plan. Nothing here performs any action:
 * it only describes what a future cleanup *would* do.
 *
 * Safety rules the plan follows:
 *  - Nothing is deleted: duplicates go to "_Duplicate Hold", mirroring their original path,
 *    with a shortcut to the kept copy left in each old spot.
 *  - Only confirmed byte-identical copies (same content hash) are ever held.
 *  - The kept copy is never held; a file never ends up with zero copies outside the hold.
 *  - Unsure files: no change.
 */
import { DUPLICATE_HOLD_FOLDER, PROPERTY } from './config.js';
import { pathParts, topFolder } from './util.js';

const LIB = PROPERTY.library;

/**
 * Kept-copy rule: a copy already in the chosen folder (nothing moves) → otherwise the report's KEEP →
 * otherwise the newest. A manual choice overrides the rule.
 */
export function keptCopy(file, folder, manualPath = null) {
  if (manualPath) {
    const c = file.copies.find((x) => x.path === manualPath);
    if (c) return { copy: c, manual: true };
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

/** Planned actions for one decision. */
export function planForDecision(file, decision) {
  if (!decision) return [];
  const base = { fileId: file.id, file: file.name, decisionBy: decision.decidedBy, reviewedBy: decision.reviewedBy || '', reviewedAt: decision.reviewedAt || '' };
  if (decision.folder === 'Unsure') {
    return file.copies.map((c) => ({ ...base, action: 'No change', from: c.path, to: c.path, note: 'Unsure: stays where it is' }));
  }
  const { copy } = keptCopy(file, decision.folder, decision.keptPath);
  const actions = [];
  const keptTo = topFolder(copy.path) === decision.folder ? copy.path : destinationPath(decision.folder, file.name);
  if (topFolder(copy.path) === decision.folder) actions.push({ ...base, action: 'Stays', from: copy.path, to: copy.path, kept: true });
  else actions.push({ ...base, action: 'Move', from: copy.path, to: keptTo, kept: true });
  for (const c of file.copies) {
    if (c === copy) continue;
    // Only confirmed identical copies are held. (Every copy in a duplicate group is hash-confirmed.)
    if (file.duplicateCheck === 'split: not identical') continue;
    actions.push({ ...base, action: 'Hold', from: c.path, to: holdPath(c.path) });
    actions.push({ ...base, action: 'Shortcut', from: c.path, to: keptTo, note: 'Shortcut to the kept copy left in the old spot' });
  }
  return actions;
}

export function buildPlan(files, decisions) {
  const byId = Object.fromEntries(files.map((f) => [f.id, f]));
  const actions = [];
  for (const d of decisions) if (byId[d.fileId]) actions.push(...planForDecision(byId[d.fileId], d));
  return actions;
}

export function planSummary(files, decisions) {
  const byId = Object.fromEntries(files.map((f) => [f.id, f]));
  let sorted = 0, move = 0, stays = 0, hold = 0, shortcuts = 0, reviewed = 0, unsure = 0;
  for (const d of decisions) {
    const f = byId[d.fileId];
    if (!f) continue;
    if (d.reviewedBy) reviewed++;
    if (d.folder === 'Unsure') { unsure++; continue; }
    sorted++;
    for (const a of planForDecision(f, d)) {
      if (a.action === 'Move') move++;
      else if (a.action === 'Stays') stays++;
      else if (a.action === 'Hold') hold++;
      else if (a.action === 'Shortcut') shortcuts++;
    }
  }
  return { sorted, move, stays, hold, shortcuts, reviewed, unsure, total: decisions.length };
}

/** Things a real cleanup would trip on. */
export function conflictChecks(files, decisions, { maxPathLength = 400, missing = new Set() } = {}) {
  const byId = Object.fromEntries(files.map((f) => [f.id, f]));
  const issues = [];
  const landing = {}; // dest path (lowercase) -> fileIds
  for (const d of decisions) {
    const f = byId[d.fileId];
    if (!f || d.folder === 'Unsure') continue;
    for (const a of planForDecision(f, d)) {
      if (a.action === 'Move' || a.action === 'Stays') (landing[a.to.toLowerCase()] ||= []).push(f.id);
      if (a.to.length > maxPathLength) issues.push({ fileId: f.id, kind: 'Path too long', detail: `${a.to.length} characters (limit ${maxPathLength}): ${a.to}` });
      if (a.kept && missing.has(a.from)) issues.push({ fileId: f.id, kind: 'Kept copy missing', detail: `No longer at ${a.from}` });
    }
  }
  // Also: a moved file landing where an unsorted/other file already sits with the same name.
  const existing = new Set(files.flatMap((f) => f.copies.map((c) => c.path.toLowerCase())));
  for (const [dest, ids] of Object.entries(landing)) {
    const uniq = [...new Set(ids)];
    if (uniq.length > 1) uniq.forEach((id) => issues.push({ fileId: id, kind: 'Same name, same folder', detail: `${uniq.length} different files would land at ${dest}` }));
    else if (existing.has(dest)) {
      const owner = files.find((f) => f.copies.some((c) => c.path.toLowerCase() === dest));
      if (owner && owner.id !== uniq[0]) issues.push({ fileId: uniq[0], kind: 'Same name, same folder', detail: `A different file already sits at ${dest}` });
    }
  }
  return issues;
}

/**
 * Folder trees for the Review tab. Returns nested nodes {name, children:Map, files:[]}.
 * before: every copy where it lives today, tagged. after: the simulated result.
 */
export function buildTrees(files, decisionsById) {
  const before = newNode(LIB), after = newNode(LIB);
  const hold = newNode(DUPLICATE_HOLD_FOLDER);
  const notSorted = newNode('Not sorted yet: left exactly where they are');
  let shortcuts = 0;
  for (const f of files) {
    const d = decisionsById[f.id];
    const kept = d && d.folder !== 'Unsure' ? keptCopy(f, d.folder, d.keptPath).copy : null;
    for (const c of f.copies) {
      let tag;
      if (!d) tag = { label: 'not sorted yet', tone: 'muted' };
      else if (d.folder === 'Unsure') tag = { label: 'Unsure', tone: 'warn' };
      else if (c === kept) tag = topFolder(c.path) === d.folder ? { label: 'kept · stays', tone: 'ok' } : { label: `kept → ${d.folder}`, tone: 'info' };
      else tag = { label: 'duplicate → hold', tone: 'danger' };
      insert(before, pathParts(c.path), { name: f.name, fileId: f.id, tag, path: c.path });
    }
    if (!d || d.folder === 'Unsure') {
      for (const c of f.copies) insert(notSorted, pathParts(c.path), { name: f.name, fileId: f.id, tag: d ? { label: 'Unsure', tone: 'warn' } : null, path: c.path });
      continue;
    }
    const stays = topFolder(kept.path) === d.folder;
    const afterParts = stays ? pathParts(kept.path) : [d.folder, f.name];
    insert(after, afterParts, { name: f.name, fileId: f.id, tag: stays ? { label: 'already here', tone: 'ok' } : { label: `from ${pathParts(kept.path).slice(0, -1).join(' › ')}`, tone: 'plain' } });
    for (const c of f.copies) {
      if (c === kept) continue;
      shortcuts++;
      insert(hold, pathParts(c.path), { name: f.name, fileId: f.id, tag: { label: `from ${pathParts(c.path).slice(0, -1).join(' › ')}`, tone: 'plain' } });
    }
  }
  return { before, after, hold, notSorted, shortcuts };
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
