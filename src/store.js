/* JPC File Sorter · v0.2.2-beta · store.js
 * The data layer. Every change is saved immediately — no save button.
 *
 * Phase 1 uses a LocalRemote (this browser). Phase 3 swaps in a SharePoint List remote
 * (Microsoft Graph, "File Sorter Beta" site) behind the same interface. Writes go through
 * a queue: if the remote can't be reached, they wait locally and are sent when it's back.
 *
 * Test Mode: everything is stored under the TEST_ namespace; live locations are never touched.
 */
import { DATA_NAMESPACE, TEST_MODE } from './config.js';
import { today } from './util.js';

const KEY = (k) => `${DATA_NAMESPACE}jpcfs_${k}`;
const BACKUP_KEEP = 14;

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

const emptyDb = () => ({
  decisions: {},   // fileId -> current decision row
  history: [],     // decision events in order, used for "undo my last decision"
  notes: {},       // fileId -> [{by, at, text, version}]
  issues: [],      // TEST issues: {id,type,happened,expected,person,at,appVersion,view,mode,fileId,fileName,status,notes[]}
  keypad: {},      // personId -> keypad state
  prefs: {},       // personId -> {mode, theme, tourDone, keypadTipSeen}
  settings: {},    // admin overrides of config DEFAULTS
  claims: {},      // fileId -> {by, at}
  lastBackup: null,
});

/** Phase 1 "remote": the shared tables live in this browser. Same async shape as the Graph remote. */
class LocalRemote {
  constructor() { this.label = 'this browser'; }
  async load() { return readJSON(KEY('db'), null); }
  async write(db) {
    if (!navigator.onLine && this.simulateNetwork) throw new Error('offline');
    if (!writeJSON(KEY('db'), db)) throw new Error('storage full');
  }
}

export class Store {
  constructor(remote = new LocalRemote()) {
    this.remote = remote;
    this.db = emptyDb();
    this.status = 'saved'; // saved | saving | offline
    this.listeners = new Set();
    this.pending = readJSON(KEY('pending'), false);
  }

  async init() {
    const loaded = await this.remote.load();
    this.db = { ...emptyDb(), ...(loaded || {}) };
    window.addEventListener('online', () => this.flush());
    window.addEventListener('offline', () => this.setStatus('offline'));
    if (this.pending) this.flush();
    return this;
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { this.listeners.forEach((fn) => fn(this)); }
  setStatus(s) { if (this.status !== s) { this.status = s; this.emit(); } }

  /** Persist now. If the remote is unreachable, keep a local copy and retry when back online. */
  async commit() {
    this.setStatus('saving');
    writeJSON(KEY('local_copy'), this.db); // always keep a local copy first: never lose work
    try {
      await this.remote.write(this.db);
      this.pending = false; writeJSON(KEY('pending'), false);
      this.setStatus('saved');
    } catch {
      this.pending = true; writeJSON(KEY('pending'), true);
      this.setStatus('offline');
    }
    this.emit();
  }
  async flush() {
    if (!this.pending) return this.setStatus('saved');
    const local = readJSON(KEY('local_copy'), null);
    if (local) this.db = local;
    await this.commit();
  }

  // ---- Decisions ---------------------------------------------------------
  decision(fileId) { return this.db.decisions[fileId] || null; }
  allDecisions() { return Object.values(this.db.decisions); }

  /** rows: decision rows (one per file). `batchId` groups a folder decision so undo removes it together. */
  saveDecisions(rows, { batchId = null } = {}) {
    const event = { id: batchId || rows[0].fileId + '@' + rows[0].decidedAt, by: rows[0].decidedBy, at: rows[0].decidedAt, items: [] };
    for (const r of rows) {
      event.items.push({ fileId: r.fileId, previous: this.db.decisions[r.fileId] || null });
      this.db.decisions[r.fileId] = { ...r, test: TEST_MODE ? 'Yes' : 'No' };
      delete this.db.claims[r.fileId];
    }
    this.db.history.push(event);
    this.commit();
    return event;
  }

  /** Undo the person's most recent decision event (single file or folder decision). */
  undoLast(personId) {
    for (let i = this.db.history.length - 1; i >= 0; i--) {
      const ev = this.db.history[i];
      if (ev.by !== personId || ev.undone) continue;
      // Only undo items that still hold this event's decision (someone may have edited since).
      const restored = [];
      for (const it of ev.items) {
        const cur = this.db.decisions[it.fileId];
        if (cur && cur.decidedBy === personId && cur.decidedAt === ev.at) {
          if (it.previous) this.db.decisions[it.fileId] = it.previous; else delete this.db.decisions[it.fileId];
          restored.push({ fileId: it.fileId, removed: cur });
        }
      }
      ev.undone = true;
      this.commit();
      return { event: ev, restored };
    }
    return null;
  }

  /** Review-tab edit: change the folder, record who edited. */
  editDecision(fileId, patch) {
    const cur = this.db.decisions[fileId];
    if (!cur) return;
    this.db.decisions[fileId] = { ...cur, ...patch };
    this.commit();
  }

  // ---- Notes, issues, claims, prefs, keypad, settings -----------------
  notes(fileId) { return this.db.notes[fileId] || []; }
  addNote(fileId, note) { (this.db.notes[fileId] ||= []).push(note); this.commit(); }

  issues() { return this.db.issues || (this.db.issues = []); }
  addIssue(row) { this.issues().push(row); this.commit(); }
  updateIssue(id, patch) { const i = this.issues().find((x) => x.id === id); if (i) { Object.assign(i, patch); this.commit(); } }
  addIssueNote(id, note) { const i = this.issues().find((x) => x.id === id); if (i) { (i.notes ||= []).push(note); this.commit(); } }

  claim(fileId, personId) {
    // Release this person's other claims; a person holds one file at a time.
    for (const [fid, c] of Object.entries(this.db.claims)) if (c.by === personId && fid !== fileId) delete this.db.claims[fid];
    if (fileId) this.db.claims[fileId] = { by: personId, at: new Date().toISOString() };
    this.commit();
  }
  releaseClaims(personId) {
    for (const [fid, c] of Object.entries(this.db.claims)) if (c.by === personId) delete this.db.claims[fid];
    writeJSON(KEY('db'), this.db);
  }
  claimedByOther(fileId, personId, idleMinutes) {
    const c = this.db.claims[fileId];
    if (!c || c.by === personId) return null;
    if (Date.now() - new Date(c.at).getTime() > idleMinutes * 60e3) return null; // idle claim released
    return c;
  }

  prefs(personId) { return this.db.prefs[personId] || {}; }
  setPrefs(personId, patch) { this.db.prefs[personId] = { ...this.prefs(personId), ...patch }; this.commit(); }

  keypad(personId) { return this.db.keypad[personId] || null; }
  setKeypad(personId, state) { this.db.keypad[personId] = state; this.commit(); }

  settings() { return this.db.settings; }
  setSettings(patch) { this.db.settings = { ...this.db.settings, ...patch }; this.commit(); }

  // ---- Backups and reset -------------------------------------------------
  /** Dated backup of decisions (daily and at the end of each session). */
  backup(reason = 'daily') {
    const date = today();
    const key = KEY(`backup_${date}`);
    writeJSON(key, { at: new Date().toISOString(), reason, decisions: this.db.decisions, notes: this.db.notes, issues: this.issues() });
    this.db.lastBackup = date;
    // keep the last N backups
    const all = this.listBackups();
    all.slice(BACKUP_KEEP).forEach((b) => localStorage.removeItem(KEY(`backup_${b}`)));
    writeJSON(KEY('db'), this.db);
    return key;
  }
  backupIfDue() { if (this.db.lastBackup !== today()) this.backup('daily'); }
  listBackups() {
    const prefix = KEY('backup_');
    return Object.keys(localStorage).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort().reverse();
  }
  readBackup(date) { return readJSON(KEY(`backup_${date}`), null); }

  /** Admin only: clear test decisions, notes, claims and issues (backup first). Keeps prefs and settings. */
  resetTestData() {
    if (!TEST_MODE) throw new Error('Reset is only available in Test Mode');
    const key = KEY(`backup_before_reset_${new Date().toISOString().replace(/[:.]/g, '-')}`);
    writeJSON(key, this.db);
    this.db = { ...emptyDb(), prefs: this.db.prefs, settings: this.db.settings, lastBackup: this.db.lastBackup };
    this.commit();
    return key;
  }
}
