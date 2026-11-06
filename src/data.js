/* JPC File Sorter · v0.2.2-beta · data.js
 * Loads the file inventory and prepares the sorting queue.
 * Phase 1: sample data. Phase 2: the duplicate report (read by header name) + a live Graph scan.
 */
import { APPROVED_FOLDERS, EXCLUDED_FOLDERS, FOLDER_ALIASES, IGNORED_FILE_PATTERNS } from './config.js';
import { SAMPLE_RAW_FILES } from './sample-data.js';
import { pathParts, topFolder } from './util.js';

export const normalizeFolder = (f) => FOLDER_ALIASES[f] || f;
const isIgnored = (name) => IGNORED_FILE_PATTERNS.some((re) => re.test(name));

export async function loadInventory({ approved = APPROVED_FOLDERS, excluded = EXCLUDED_FOLDERS } = {}) {
  const raw = SAMPLE_RAW_FILES;
  const files = [];
  const unapproved = {}; // top-level folder not on the approved list -> file count
  for (const r of raw) {
    if (isIgnored(r.name)) continue;
    const copies = r.copies.filter((c) => !excluded.includes(topFolder(c.path)) && !isIgnored(pathParts(c.path).at(-1)));
    if (!copies.length) continue; // only lived in excluded folders: never shown, counted or planned
    for (const c of copies) {
      const top = topFolder(c.path);
      if (!approved.includes(top)) unapproved[top] = (unapproved[top] || 0) + 1;
    }
    const s = r.suggestion || {};
    const pick = normalizeFolder(s.folder);
    const alts = [...new Set((s.alts || []).map(normalizeFolder))].filter((f) => f !== pick && approved.includes(f)).slice(0, 2);
    files.push({
      ...r,
      copies,
      duplicateCheck: copies.length > 1 ? 'confirmed identical' : 'single copy',
      reportNote: r.reportNote ? r.reportNote.replace(/PM Construction/g, 'PM Construction (= Construction & Development)') : '',
      suggestion: approved.includes(pick) ? { ...s, folder: pick, alts } : null,
    });
  }
  return { files, unapproved, source: 'Sample data (phase 1)' };
}

/** Test scope: files with a copy in the scope folder (and subfolder), first N. */
export function applyScope(files, { scopeFolder, scopeSubfolder, scopeFirstN }) {
  let out = files;
  if (scopeFolder) {
    const prefix = [scopeFolder, scopeSubfolder].filter(Boolean).join('/') + '/';
    out = out.filter((f) => f.copies.some((c) => (pathParts(c.path).join('/') + '').startsWith(prefix)));
  }
  if (scopeFirstN) out = out.slice(0, scopeFirstN);
  return out;
}

/** Every folder path (under the library) that contains any of these files, with counts. */
export function subfoldersOf(files, top) {
  const counts = {};
  for (const f of files) for (const c of f.copies) {
    const parts = pathParts(c.path);
    if (parts[0] !== top) continue;
    if (parts.length > 2) counts[parts[1]] = (counts[parts[1]] || 0) + 1;
  }
  return counts;
}
