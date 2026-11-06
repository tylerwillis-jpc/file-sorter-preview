/* JPC File Sorter · v0.2.2-beta · util.js — small shared helpers */

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function fmtSize(bytes) {
  if (bytes == null) return '';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  if (bytes >= 1e3) return Math.round(bytes / 1e3) + ' KB';
  return bytes + ' B';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtMonth(iso) {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? iso + 'T12:00:00' : iso);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}
export function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getHours() % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${d.getHours() < 12 ? 'am' : 'pm'}`;
}
export const today = () => new Date().toISOString().slice(0, 10);

export function fmtDuration(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '—';
  const h = Math.floor(seconds / 3600), m = Math.round((seconds % 3600) / 60);
  if (h >= 24) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h) return `${h}h ${m}m`;
  return `${Math.max(1, m)}m`;
}

/** "Shared Documents/A/B/file.pdf" → ["A","B","file.pdf"] */
export function pathParts(path, library = 'Shared Documents') {
  const parts = path.split('/');
  return parts[0] === library ? parts.slice(1) : parts;
}
export const topFolder = (path) => pathParts(path)[0];
export const parentPath = (path) => path.split('/').slice(0, -1).join('/');
/** Short display form: "PM Construction › City" (folder part, without library or file name). */
export function folderCrumb(path) {
  return pathParts(path).slice(0, -1).join(' › ');
}

export function uid(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const TYPE_COLORS = {
  pdf: '#C2410C', jpg: '#15803D', jpeg: '#15803D', png: '#15803D', gif: '#15803D', heic: '#15803D',
  mp4: '#7C3AED', mov: '#7C3AED', avi: '#7C3AED',
  xlsx: '#047857', xls: '#047857', csv: '#0F766E',
  docx: '#1D4ED8', doc: '#1D4ED8', pptx: '#B45309', msg: '#475569', dwg: '#9D174D', zip: '#57534E',
};
export const typeColor = (t) => TYPE_COLORS[(t || '').toLowerCase()] || '#6E767D';
export const typeKind = (t) => {
  t = (t || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'gif', 'heic', 'tif', 'tiff', 'bmp'].includes(t)) return 'image';
  if (['mp4', 'mov', 'avi', 'wmv', 'm4v'].includes(t)) return 'video';
  if (['xlsx', 'xls', 'csv', 'xlsm'].includes(t)) return 'sheet';
  return 'doc';
};
