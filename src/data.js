/* JPC File Sorter · v0.3.1-beta · data.js
 * Loads the file inventory and prepares the sorting queue.
 * Real data from data/inventory.json when present (this computer only); otherwise made-up sample data.
 * A live Graph scan for files added since the report comes with sign-in (phase 3).
 */
import { APPROVED_FOLDERS, EXCLUDED_FOLDERS, FOLDER_ALIASES, IGNORED_FILE_PATTERNS } from './config.js';
import { SAMPLE_RAW_FILES } from './sample-data.js';
import { pathParts, topFolder } from './util.js';

export const normalizeFolder = (f) => FOLDER_ALIASES[f] || f;
const isIgnored = (name) => IGNORED_FILE_PATTERNS.some((re) => re.test(name));

/**
 * Real data (phase 2): data/inventory.json, built on this computer by scripts/build_inventory.py
 * from the duplicate report. It is never committed or published, so the public preview
 * (and anyone without the file) falls back to the made-up sample data.
 */
async function loadRealInventory() {
  try {
    const res = await fetch('data/inventory.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const { meta, files } = await res.json();
    const lib = 'Shared Documents';
    const base = `${meta.siteBase}/${encodeURIComponent(lib)}/`;
    for (const f of files) {
      for (const c of f.copies) {
        c.url = c.url || base + c.path.split('/').map(encodeURIComponent).join('/');
        c.path = `${lib}/${c.path}`;
      }
    }
    return { raw: files, meta, source: `Duplicate report of ${meta.reportDate} (${meta.uniqueFiles.toLocaleString()} unique files)` };
  } catch {
    return null;
  }
}

export async function loadInventory({ approved = APPROVED_FOLDERS, excluded = EXCLUDED_FOLDERS, sampleOnly = false } = {}) {
  const real = sampleOnly ? null : await loadRealInventory();
  const raw = real ? real.raw : SAMPLE_RAW_FILES;
  const files = [];
  const unapproved = {}; // top-level folder not on the approved list -> number of copies
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
      sample: !real,
      duplicateCheck: copies.length > 1 ? 'confirmed identical' : 'single copy',
      reportNote: r.reportNote ? r.reportNote.replace(/PM Construction/g, 'PM Construction (= Construction & Development)') : '',
      suggestion: approved.includes(pick) ? { ...s, folder: pick, alts } : null,
    });
  }
  return { files, unapproved, real: !!real, meta: real?.meta || null, source: real ? real.source : 'Sample data (made up)' };
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
