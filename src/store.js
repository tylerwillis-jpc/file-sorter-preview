/* JPC File Sorter · v0.4.1-beta · store.js
 * The data layer. Every change is saved immediately — no save button.
 *
 * How saving works (this browser, until phase 3):
 *  - Every change re-reads the latest saved copy, applies just that one change, bumps a revision
 *    number and writes it back. A tab holding old data can therefore never overwrite newer work
 *    from another tab, and other tabs pick up each change through the browser's `storage` event.
 *  - If a write fails (for example, the browser's storage is full), nothing is changed in memory,
 *    the status shows "Not saved", and the caller is told so it can stop and warn the person.
 *    The app never reports "Saved" for work that isn't stored.
 *
 * Phase 3 swaps this for SharePoint Lists (one row per write, with conflict checks).
 * Test Mode: everything is stored under the TEST_ namespace; live locations are never touched.
 */
import { DATA_NAMESPACE, TEST_MODE } from './config.js';
import { today, uid } from './util.js';

const DAILY_KEEP = 14;   // daily backups kept
const RESET_KEEP = 3;    // pre-reset backups kept

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

const emptyDb = () => ({
  rev: 0,          // bumped on every saved change
  decisions: {},   // fileId -> current decision row (row.eventId = the event that produced it)
  history: [],     // decision events in order, used for "undo my last decision"
  notes: {},       // fileId -> [{by, at, text, appVersion}]
  issues: [],      // {id,type,happened,expected,person,at,appVersion,view,mode,fileId,fileName,status,notes[]}
  keypad: {},      // personId -> keypad state
  prefs: {},       // personId -> {mode, theme, tourDone, keypadTipSeen, shortcutsOff, ...}
  settings: {},    // admin overrides of config DEFAULTS
  claims: {},      // fileId -> {by, at}
  approvals: [],   // plan approvals: {id, by, byName, at, fingerprint, decisions, actions, scope, inventoryId}
});

export class Store {
  constructor({ namespace = DATA_NAMESPACE } = {}) {
    this.ns = namespace;
    this.label = 'this browser';
    this.db = emptyDb();
    this.status = 'saved'; // saved | error
    this.error = '';
    this.listeners = new Set();
  }

  async init() {
    this.db = { ...emptyDb(), ...(readJSON(this.key('db'), null) || {}) };
    // Older versions kept a second full copy and a "pending" flag; they're no longer used.
    localStorage.removeItem(this.key('local_copy'));
    localStorage.removeItem(this.key('pending'));
    // Another tab saved a change: take it, so this tab never works from stale data.
    window.addEventListener('storage', (e) => {
      if (e.key !== this.key('db') || !e.newValue) return;
      try { this.db = { ...emptyDb(), ...JSON.parse(e.newValue) }; this.emit('external'); } catch { /* ignore a partial write */ }
    });
    return this;
  }

  key(k) { return `${this.ns}jpcfs_${k}`; }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(why = 'change') { this.listeners.forEach((fn) => fn(this, why)); }

  /**
   * Apply one change to the LATEST saved data and save it.
   * Returns { ok, result }. On failure nothing changes (in memory or in storage).
   */
  mutate(fn) {
    const fresh = readJSON(this.key('db'), null);
    const base = { ...emptyDb(), ...structuredClone(fresh || this.db) }; // a true copy: a failed save must leave nothing behind
    const result = fn(base);
    base.rev = (base.rev || 0) + 1;
    base.savedAt = new Date().toISOString();
    if (!writeJSON(this.key('db'), base)) {
      if (fresh) this.db = { ...emptyDb(), ...fresh }; // keep exactly what is stored
      this.status = 'error';
      this.error = "This browser's storage is full, so the last change was not saved.";
      this.emit('error');
      return { ok: false, result };
    }
    this.db = base;
    this.status = 'saved';
    this.error = '';
    this.emit('change');
    return { ok: true, result };
  }

  // ---- Decisions ---------------------------------------------------------
  decision(fileId) { return this.db.decisions[fileId] || null; }

  /** rows: decision rows (one per file). A folder decision saves many rows as one undoable event. */
  saveDecisions(rows) {
    if (!rows.length) return { ok: false, result: null };
    return this.mutate((db) => {
      const event = { id: uid('ev'), by: rows[0].decidedBy, at: rows[0].decidedAt, items: [] };
      for (const r of rows) {
        event.items.push({ fileId: r.fileId, previous: db.decisions[r.fileId] || null });
        db.decisions[r.fileId] = { ...r, eventId: event.id, test: TEST_MODE ? 'Yes' : 'No' };
        delete db.claims[r.fileId];
      }
      db.history.push(event);
      return event;
    });
  }

  /**
   * Undo the person's most recent decision event. Only rows that still hold exactly that event's
   * decision are restored: if anyone has since edited or reviewed a row, it is left alone.
   * Returns { restored: [{fileId, removed}], blocked: [{fileId, by}] } or null if nothing to undo.
   */
  undoLast(personId) {
    const res = this.mutate((db) => {
      for (let i = db.history.length - 1; i >= 0; i--) {
        const ev = db.history[i];
        if (ev.by !== personId || ev.undone) continue;
        const restored = [], blocked = [];
        for (const it of ev.items) {
          const cur = db.decisions[it.fileId];
          const legacyMatch = cur && !cur.eventId && cur.decidedBy === personId && cur.decidedAt === ev.at && !cur.editedBy && !cur.reviewedBy;
          if (cur && (cur.eventId === ev.id || legacyMatch)) {
            if (it.previous) db.decisions[it.fileId] = it.previous; else delete db.decisions[it.fileId];
            restored.push({ fileId: it.fileId, removed: cur });
          } else if (cur) {
            blocked.push({ fileId: it.fileId, by: cur.editedBy || cur.reviewedByName || cur.reviewedBy || cur.decidedByName || '' });
          }
        }
        ev.undone = true;
        return { event: ev, restored, blocked };
      }
      return null;
    });
    return res.ok ? res.result : { error: true };
  }

  /** Review-tab edit or review mark. It becomes a new revision, so the original sorter's Undo can't erase it. */
  editDecision(fileId, patch) {
    return this.mutate((db) => {
      const cur = db.decisions[fileId];
      if (!cur) return false;
      db.decisions[fileId] = { ...cur, ...patch, eventId: uid('edit') };
      return true;
    });
  }

  /** A reviewer approves exactly this plan (identified by its fingerprint). */
  approvePlan(rec) { return this.mutate((db) => { (db.approvals ||= []).push(rec); }); }
  approvals() { return this.db.approvals || []; }

  // ---- Notes, issues, claims, prefs, keypad, settings -----------------
  notes(fileId) { return this.db.notes[fileId] || []; }
  addNote(fileId, note) { return this.mutate((db) => { (db.notes[fileId] ||= []).push(note); }); }

  issues() { return this.db.issues || []; }
  addIssue(row) { return this.mutate((db) => { (db.issues ||= []).push(row); }); }
  updateIssue(id, patch) { return this.mutate((db) => { const i = (db.issues || []).find((x) => x.id === id); if (i) Object.assign(i, patch); }); }
  addIssueNote(id, note) { return this.mutate((db) => { const i = (db.issues || []).find((x) => x.id === id); if (i) (i.notes ||= []).push(note); }); }

  /** Hold this file for this person (and release their other holds). */
  claim(fileId, personId) {
    return this.mutate((db) => {
      for (const [fid, c] of Object.entries(db.claims)) if (c.by === personId && fid !== fileId) delete db.claims[fid];
      if (fileId) db.claims[fileId] = { by: personId, at: new Date().toISOString() };
    });
  }
  /** Mark activity on the held file, so it isn't released while the person is still working on it. */
  touchClaim(fileId, personId) {
    const c = this.db.claims[fileId];
    if (!c || c.by !== personId || Date.now() - new Date(c.at).getTime() < 60e3) return; // at most once a minute
    this.claim(fileId, personId);
  }
  releaseClaims(personId) {
    return this.mutate((db) => { for (const [fid, c] of Object.entries(db.claims)) if (c.by === personId) delete db.claims[fid]; });
  }
  claimedByOther(fileId, personId, idleMinutes) {
    const c = this.db.claims[fileId];
    if (!c || c.by === personId) return null;
    if (Date.now() - new Date(c.at).getTime() > idleMinutes * 60e3) return null; // idle hold released
    return c;
  }

  prefs(personId) { return this.db.prefs[personId] || {}; }
  setPrefs(personId, patch) { return this.mutate((db) => { db.prefs[personId] = { ...(db.prefs[personId] || {}), ...patch }; }); }

  keypad(personId) { return this.db.keypad[personId] || null; }
  setKeypad(personId, state) { return this.mutate((db) => { db.keypad[personId] = state; }); }

  settings() { return this.db.settings; }
  setSettings(patch) { return this.mutate((db) => { db.settings = { ...db.settings, ...patch }; }); }

  // ---- Backups and reset -------------------------------------------------
  snapshot() { return { at: new Date().toISOString(), rev: this.db.rev, decisions: this.db.decisions, notes: this.db.notes, issues: this.issues() }; }

  /** The day's first backup. Once written it is never overwritten. Returns true if a backup exists for today. */
  backupDaily() {
    const key = this.key(`backup_${today()}`);
    if (localStorage.getItem(key)) return true;
    const ok = writeJSON(key, { ...this.snapshot(), reason: 'daily' });
    const daily = this.listBackups().daily;
    daily.slice(DAILY_KEEP).forEach((d) => localStorage.removeItem(this.key(`backup_${d}`)));
    return ok;
  }
  /** The latest copy at the end of a session (one rolling slot, separate from the daily backups). */
  backupSession() { return writeJSON(this.key('session_backup'), { ...this.snapshot(), reason: 'end of session' }); }

  listBackups() {
    const keys = Object.keys(localStorage);
    const daily = keys.map((k) => k.match(new RegExp(`^${this.key('backup_')}(\\d{4}-\\d{2}-\\d{2})$`))).filter(Boolean).map((m) => m[1]).sort().reverse();
    const reset = keys.map((k) => k.match(new RegExp(`^${this.key('reset_backup_')}(.+)$`))).filter(Boolean).map((m) => m[1]).sort().reverse();
    return { daily, reset, session: !!localStorage.getItem(this.key('session_backup')) };
  }
  readBackup(kind, id) {
    if (kind === 'daily') return readJSON(this.key(`backup_${id}`), null);
    if (kind === 'reset') return readJSON(this.key(`reset_backup_${id}`), null);
    return readJSON(this.key('session_backup'), null);
  }

  /**
   * Admin only: clear test decisions, notes, claims and issues. A full backup is written and
   * checked first; if it can't be saved, nothing is reset. Keeps prefs and settings.
   */
  resetTestData() {
    if (!TEST_MODE) throw new Error('Reset is only available in Test Mode');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = this.key(`reset_backup_${stamp}`);
    const full = readJSON(this.key('db'), this.db);
    if (!writeJSON(key, full) || !localStorage.getItem(key)) return { ok: false, reason: 'The backup could not be saved, so nothing was reset.' };
    this.listBackups().reset.slice(RESET_KEEP).forEach((r) => localStorage.removeItem(this.key(`reset_backup_${r}`)));
    const res = this.mutate((db) => {
      const keep = { prefs: db.prefs, settings: db.settings, rev: db.rev };
      Object.assign(db, emptyDb(), keep);
    });
    return res.ok ? { ok: true, backup: stamp } : { ok: false, reason: this.error };
  }
}
