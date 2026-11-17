/* JPC File Sorter · v0.5.0-beta · previews.js
 * Thumbnails, never full files. Keeps the next N files' thumbnails loading in the background
 * so the next file appears instantly after each keystroke.
 *
 * Sources, in order:
 *  1. SharePoint's own preview image service (getpreview.ashx), requested directly by the
 *     browser using the person's existing SharePoint sign-in. Nothing passes through any
 *     other server. Works when the browser is signed in to SharePoint and allows it.
 *  2. (Phase 3) Microsoft Graph /thumbnails once Microsoft sign-in is built.
 *  3. A placeholder with the file type and size (also for very large files).
 */

// The cache keeps at most this many thumbnails. Oldest finished entries go first; a still-loading
// one is only dropped (and its download cancelled) if nothing else can be.
const MAX_CACHE_ENTRIES = 300;

const THUMB_TYPES = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx', 'mp4', 'mov']);

export class Previewer {
  constructor({ largeFileBytes, onReady }) {
    this.largeFileBytes = largeFileBytes;
    this.onReady = onReady;      // called with fileId when a thumbnail finishes (ok or failed)
    this.cache = new Map();      // fileId -> {state: 'loading'|'ok'|'none'|'sample', src, reason}; insertion order = age
  }

  /** Thumbnail URL for one copy, or null if this file shouldn't get one. */
  thumbUrl(file, copy) {
    if (file.sample || !copy?.url) return null;
    if (file.size > this.largeFileBytes) return null;
    if (!THUMB_TYPES.has((file.type || '').toLowerCase())) return null;
    const m = copy.url.match(/^(https:\/\/[^/]+\/sites\/[^/]+)\//i);
    if (!m) return null;
    let full;
    try { full = decodeURIComponent(copy.url); } catch { return null; } // a malformed link just gets a placeholder
    return `${m[1]}/_layouts/15/getpreview.ashx?path=${encodeURIComponent(full)}&resolution=3`;
  }

  get(fileId) { return this.cache.get(fileId); }

  /** Start loading thumbnails for these files (current first). Already-loaded ones are skipped. */
  preload(items) {
    const wanted = new Set();
    for (const { file, copy } of items) {
      wanted.add(file.id);
      if (this.cache.has(file.id)) {
        // Still wanted: move it to the newest end so it is evicted last.
        const e = this.cache.get(file.id);
        this.cache.delete(file.id);
        this.cache.set(file.id, e);
        continue;
      }
      if (file.sample) { this.cache.set(file.id, { state: 'sample' }); continue; }
      const src = this.thumbUrl(file, copy);
      if (!src) {
        this.cache.set(file.id, { state: 'none', reason: file.size > this.largeFileBytes ? 'large' : 'type' });
        continue;
      }
      const img = new Image();
      const entry = { state: 'loading', src, img };
      this.cache.set(file.id, entry);
      img.referrerPolicy = 'no-referrer';
      const done = (ok) => {
        if (entry.state !== 'loading') return; // already timed out or evicted
        // SharePoint answers some unsupported files with a tiny 1×1 image: treat that as "no thumbnail".
        entry.state = ok && img.naturalWidth > 2 ? 'ok' : 'none';
        if (entry.state === 'none') entry.reason = 'unavailable';
        entry.img = null;
        this.onReady?.(file.id);
      };
      img.onload = () => done(true);
      img.onerror = () => done(false);
      setTimeout(() => {
        if (entry.state === 'loading') { entry.state = 'none'; entry.reason = 'timeout'; entry.img = null; this.onReady?.(file.id); }
      }, 15000);
      img.src = src;
    }
    this.evict(wanted);
  }

  /** Keep the cache at MAX_CACHE_ENTRIES: drop the oldest finished entries first, then (only if
   *  needed) the oldest still-loading ones, cancelling their download. Never drops `keep`. */
  evict(keep) {
    let over = this.cache.size - MAX_CACHE_ENTRIES;
    if (over <= 0) return;
    for (const pass of ['finished', 'loading']) {
      for (const [id, e] of this.cache) {
        if (over <= 0) return;
        if (keep.has(id)) continue;
        const loading = e.state === 'loading';
        if ((pass === 'finished') === loading) continue;
        if (loading) {
          e.state = 'evicted';
          const img = e.img;
          e.img = null;
          if (img) { img.onload = null; img.onerror = null; img.src = ''; }
        }
        this.cache.delete(id);
        over--;
      }
    }
  }

  /** How many of these files have a finished thumbnail (or a placeholder ready). */
  readyCount(fileIds) {
    return fileIds.filter((id) => { const e = this.cache.get(id); return e && e.state !== 'loading'; }).length;
  }
}
