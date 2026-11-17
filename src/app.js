/* JPC File Sorter · v0.5.0-beta · app.js
 * The app shell: top bar, toolbar, Sort and Review views, keyboard, modals.
 * The app never moves, renames or deletes files. It only records decisions.
 */
import { APPROVED_FOLDERS, COMMON_FOLDERS, DEFAULTS, EXCLUDED_FOLDERS, PEOPLE, PROPERTY, TEST_MODE, TEST_MODE_LOCKED } from './config.js';
import { applyScope, loadInventory, subfoldersOf } from './data.js';
import { exportBackup, exportChangePlan, exportDecisions, exportIssues } from './exporter.js';
import { I } from './icons.js';
import { assignKeys, candidateFolders, emptyKeypadState, recordUse, resetNumbers, unrecordUse } from './keypad.js';
import { buildPlan, buildTrees, conflictChecks, countFiles, decisionKept, keptCopy, planByFile, planFingerprint, planForDecision, planSummary } from './plan.js';
import { announce, captureOpener, initA11y, restoreFocus, trapTab } from './a11y.js';
import { Previewer } from './previews.js';
import { Store } from './store.js';
import { maybeKeypadTip, startIntro, startTour, tourActive } from './tutorial.js';
import { esc, today, fmtDateTime, fmtDuration, fmtMonth, fmtSize, folderCrumb, pathParts, topFolder, typeColor, typeKind, uid } from './util.js';

const $ = (sel, root = document) => root.querySelector(sel);
const peopleById = Object.fromEntries(PEOPLE.map((p) => [p.id, p]));
const DEVICE_PERSON_KEY = 'jpcfs_device_person';

const S = {
  pkg: { version: '?' },
  person: null,
  view: 'sort',
  source: 'remaining',
  allFiles: [], files: [], unapproved: {}, dataSource: '',
  currentId: null, shownAt: Date.now(),
  manualKept: {},
  allFoldersOpen: false, folderFilter: '', folderHl: 0,
  confirm: null,
  issues: { person: '', status: '' },
  review: { tab: 'changes', queue: 'toreview', folder: 'all', person: '', changed: false, type: '', open: new Set(), query: '', search: '', page: 1 },
  kbdPaused: false,
  modal: null,
  practice: null, // the made-up practice file while someone is trying it: { file, done: folder|null, doneAt }. Never saved.
};
let store;

// ---------- Settings (admin overrides on top of config defaults) ----------
const setting = (k) => (store.settings()[k] ?? DEFAULTS[k]);
const approved = () => store.settings().approvedFolders || APPROVED_FOLDERS;
const excluded = () => store.settings().excludedFolders || EXCLUDED_FOLDERS;
const me = () => peopleById[S.person];
const isAdmin = () => !!me()?.admin;
const prefs = () => (S.person ? store.prefs(S.person) : {});
const mode = () => prefs().mode || 'suggestion';
// The intro shows once per person. People who already finished the old tour have seen enough.
const seenIntro = () => !!(prefs().introSeen || prefs().tourDone);

// ---------- Boot ----------
async function boot() {
  S.pkg = await fetch('package.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ version: 'unknown' }));
  store = await new Store().init();
  previewer = new Previewer({ largeFileBytes: DEFAULTS.largeFileBytes, onReady: onThumbReady });
  store.on((st, why) => { renderStatus(); if (why === 'external') onExternalChange(); });
  S.person = localStorage.getItem(DEVICE_PERSON_KEY) || null;
  if (S.person && !peopleById[S.person]) S.person = null;
  await reloadInventory();
  applyTheme();
  store.backupDaily();
  render();
  bindGlobalEvents();
  if (!S.person) openProfilePicker();
  else if (!seenIntro()) openIntro();
}

async function reloadInventory() {
  const inv = await loadInventory({ approved: approved(), excluded: excluded() });
  S.allFiles = inv.files; S.unapproved = inv.unapproved; S.dataSource = inv.source; S.realData = inv.real; S.dataMeta = inv.meta;
  S.sugName = S.allFiles.some((f) => f.suggestion && !f.suggestion.placeholder) ? 'Claude' : 'suggestion';
  S.files = applyScope(S.allFiles, { scopeFolder: setting('scopeFolder'), scopeSubfolder: setting('scopeSubfolder'), scopeFirstN: setting('scopeFirstN') });
  S.fileById = Object.fromEntries(S.allFiles.map((f) => [f.id, f]));
  S.inventoryId = inv.inventoryId;
  migrateLegacyIds(inv.legacyIds || {});
}

/** Files used to be keyed by the report's group number. Move any saved records onto the new stable ids (once). */
function migrateLegacyIds(map) {
  const db = store.db;
  const stale = Object.keys(map).filter((old) => db.decisions[old] || db.notes[old] || db.claims[old] || db.history.some((e) => e.items.some((i) => i.fileId === old)));
  if (!stale.length) return;
  store.mutate((d) => {
    for (const old of stale) {
      const id = map[old];
      for (const k of ['decisions', 'notes', 'claims']) if (d[k][old] && !d[k][id]) { d[k][id] = d[k][old]; if (k === 'decisions') d[k][id].fileId = id; delete d[k][old]; }
      for (const e of d.history) for (const it of e.items) if (it.fileId === old) { it.fileId = id; if (it.previous) it.previous.fileId = id; }
    }
  });
}

/** Another tab saved a change. Redraw, unless the person is typing or in a dialog (then redraw afterwards). */
function onExternalChange() {
  const a = document.activeElement;
  if (S.modal || tourActive() || (a && a.matches('input, textarea, select'))) { S.redrawLater = true; return; }
  render();
}

// ---------- Queue ----------
const decisionsById = () => store.db.decisions;
function queue(source = S.source) {
  const dec = decisionsById();
  if (source === 'unsure') return S.files.filter((f) => dec[f.id]?.folder === 'Unsure');
  return S.files.filter((f) => !dec[f.id]);
}
function available(source = S.source) {
  return queue(source).filter((f) => !store.claimedByOther(f.id, S.person, setting('claimIdleMinutes')));
}
function currentFile() {
  if (S.practice) return S.practice.file; // practice never touches the real queue, claims or store
  const avail = available();
  let f = avail.find((x) => x.id === S.currentId);
  if (!f) {
    f = avail[0] || null;
    if (f?.id !== S.currentId) showFile(f);
  }
  return f;
}
function showFile(f) {
  S.currentId = f ? f.id : null;
  S.shownAt = Date.now();
  S.allFoldersOpen = false; S.folderFilter = '';
  if (S.person) store.claim(S.currentId, S.person);
  preload();
}

// Preview buffer: keep the next N files' thumbnails loading in the background (thumbnails only, never full files).
let previewer;
function preload() {
  const q = available();
  const start = Math.max(0, q.findIndex((f) => f.id === S.currentId));
  previewer.preload(q.slice(start, start + 1 + setting('preloadCount')).map((f) => ({ file: f, copy: f.copies[0] })));
}
const preloadedAhead = () => {
  const q = available();
  const i = q.findIndex((f) => f.id === S.currentId);
  return previewer.readyCount(q.slice(i + 1, i + 1 + setting('preloadCount')).map((f) => f.id));
};
/** A thumbnail finished loading: refresh only the preview box if it's the file on screen. */
function onThumbReady(fileId) {
  const box = document.getElementById('preview');
  const f = S.fileById[fileId];
  if (box && fileId === S.currentId && f) box.outerHTML = previewBox(f);
  else if (box && S.currentId) { const tag = box.querySelector('.tag'); if (tag) tag.textContent = previewTag(S.fileById[S.currentId]); }
}

// ---------- Decisions ----------
function baseRow(f, folder, extra = {}) {
  const sug = f.suggestion;
  // Save exactly which copy is kept (for the folder actually chosen), so the plan can't change after review.
  const kept = folder === 'Unsure' ? null : keptCopy(f, folder, S.manualKept[f.id] || null).copy;
  return {
    fileId: f.id, fileName: f.name, folder,
    keptPath: kept?.path || null, keptManual: !!S.manualKept[f.id], keptSize: kept?.size ?? null, keptModified: kept?.modified || null,
    copyPaths: f.copies.map((c) => c.path), inventoryId: S.inventoryId,
    suggestion: sug?.folder || '', confidence: sug?.confidence || '',
    accepted: !!sug && folder === sug.folder,
    decidedBy: S.person, decidedByName: me().name, decidedAt: new Date().toISOString(),
    decisionType: 'single file', mode: mode(), appVersion: S.pkg.version,
    duplicateCheck: f.duplicateCheck, ...extra,
  };
}

const MIN_LOOK_MS = 250; // a pick this soon after a new file appears is a double-press, not a decision

function decide(folder) {
  const f = currentFile();
  if (!f || !S.person) return;
  if (folder !== 'Unsure' && !approved().includes(folder)) return;
  if (Date.now() - S.shownAt < MIN_LOOK_MS) return;
  if (S.practice) { decidePractice(folder); return; } // nothing below this line runs for the practice file
  const seconds = Math.round((Date.now() - S.shownAt) / 100) / 10;
  const row = baseRow(f, folder, { seconds, markedUnsureBy: folder === 'Unsure' ? me().name : undefined });
  if (!store.saveDecisions([row]).ok) { showSaveError(); return; }
  if (folder !== 'Unsure') store.setKeypad(S.person, recordUse(keypadState(), folder, setting('keypadLearningFiles')));
  const holds = folder === 'Unsure' ? 0 : f.copies.length - 1;
  S.confirm = folder === 'Unsure'
    ? { tone: 'warn', text: `${f.name} → Unsure pile. Anyone can pick it up later.` }
    : { tone: 'ok', text: `${f.name} → ${folder}.${holds ? ` Kept copy: ${folderCrumb(row.keptPath) || 'top level'}. ${holds} duplicate${holds > 1 ? 's go' : ' goes'} to Duplicate Hold (not deleted).` : ''}` };
  delete S.manualKept[f.id];
  const next = available().find((x) => x.id !== f.id) || null;
  showFile(next);
  render();
  announce(`Sorted to ${folder}. ${next ? `Next: ${next.name}.` : 'All done in this pile.'}`);
}

// ---------- Practice file ----------
// A made-up file shown in the real sort screen. It lives only in S.practice (memory): decisions on it never reach
// store.saveDecisions, keypad counts, claims, history or localStorage, and it is not in S.files, so counts, Review
// and exports never see it.
function practiceFile() {
  const name = 'Practice - Roof Inspection 2021.pdf';
  const pick = 'Bldg Information & Measurements';
  const alts = ['Construction & Development', 'Property Management'].filter((f) => approved().includes(f));
  return {
    id: 'practice', name, type: 'pdf', size: 1.3e6, sample: true, practice: true,
    copies: [{ path: `${PROPERTY.library}/Practice/${name}`, modified: '2021-06-15' }],
    excludedCopies: 0, duplicateCheck: 'single copy', reportNote: '',
    suggestion: { folder: pick, confidence: 'High', placeholder: true, alts, reason: 'Made-up example: a roof inspection report describes the building, so it goes here.' },
  };
}
function startPractice() {
  S.view = 'sort'; S.confirm = null; S.allFoldersOpen = false; S.folderFilter = '';
  const file = practiceFile();
  S.practice = { file, done: null, doneAt: 0 };
  S.shownAt = Date.now();
  previewer.preload([{ file, copy: file.copies[0] }]); // memory cache only: gives it the sample drawing
  render();
  announce("Practice file. This decision won't be saved.");
}
function decidePractice(folder) {
  if (!S.practice || S.practice.done) return;
  S.practice.done = folder; S.practice.doneAt = Date.now();
  S.allFoldersOpen = false; S.folderFilter = '';
  render();
  announce(`Done. That would send it to ${folder === 'Unsure' ? 'the Unsure pile' : folder}. Real files start now.`);
}
/** Leave practice (Start sorting, Enter, Escape, or leaving the Sort screen) and go to the real queue. */
function endPractice(quiet = false) {
  if (!S.practice) return;
  S.practice = null; S.allFoldersOpen = false; S.folderFilter = '';
  const avail = available();
  showFile(avail.find((x) => x.id === S.currentId) || avail[0] || null); // re-holds the real file; restarts the double-press guard
  render();
  if (!quiet) announce(S.currentId ? `Real files start now. ${S.fileById[S.currentId]?.name || ''}` : 'Real files start now.');
}
function practiceBanner() {
  const p = S.practice;
  if (!p) return '';
  if (p.done) {
    const where = p.done === 'Unsure' ? 'the Unsure pile' : p.done;
    return `<div class="practice-banner done"><span>${I.check}</span><span><b>Done.</b> That would send it to ${esc(where)}. Real files start now.</span><button class="btn primary sm" data-act="practice-done">Start sorting <span class="kc sm wide">Enter</span></button></div>`;
  }
  return `<div class="practice-banner"><span><b>Practice file:</b> this decision won't be saved.</span><button class="btn sm" data-act="practice-done" title="Leave practice and start on real files (Esc)">Skip practice <span class="kc sm">Esc</span></button></div>`;
}

function undo() {
  if (S.practice) { toast("Practice only: nothing was saved, so there is nothing to undo."); return; }
  if (!S.person) return;
  const res = store.undoLast(S.person);
  if (res?.error) { showSaveError(); return; }
  if (!res) { toast('Nothing of yours to undo.'); return; }
  if (!res.restored.length) {
    const by = res.blocked.map((b) => b.by).filter(Boolean)[0];
    toast(`Your last decision was changed in Review${by ? ` by ${by}` : ''} since, so it wasn't undone.`);
    return;
  }
  let ks = keypadState();
  for (const r of res.restored) if (r.removed.folder !== 'Unsure') ks = unrecordUse(ks, r.removed.folder);
  store.setKeypad(S.person, ks);
  const first = res.restored[0];
  const back = decisionsById()[first.fileId];
  const file = S.fileById[first.fileId];
  S.view = 'sort';
  S.source = back?.folder === 'Unsure' ? 'unsure' : 'remaining';
  const onScreen = file && S.files.includes(file);
  if (onScreen) showFile(file);
  const name = file?.name || first.removed.fileName || 'The file';
  S.confirm = { tone: 'warn', text: res.restored.length > 1 ? `Undid a folder decision: ${res.restored.length} files are back to unsorted.`
    : onScreen ? `Undid: ${name} is back on screen.` : `Undid: ${name} is unsorted again (it's outside the current test scope).` };
  if (res.blocked.length) S.confirm.text += ` ${res.blocked.length} file${res.blocked.length > 1 ? 's were' : ' was'} left alone because someone changed them in Review.`;
  render();
  announce(res.restored.length > 1 ? `Undone: ${res.restored.length} files.` : `Undone: ${name}.`);
}

// ---------- Keypad ----------
function keypadState() { return store.keypad(S.person) || emptyKeypadState(); }
function keypadLayout(f) {
  const st = keypadState();
  const cands = candidateFolders({ pick: f.suggestion?.folder, alts: f.suggestion?.alts, usage: st.usage, common: COMMON_FOLDERS, approved: approved() });
  const { keys } = assignKeys(cands, st); // drawing never changes saved state
  return { keys, state: st };
}

// ---------- Render: shell ----------
function render() {
  if (tourActive()) document.body.dataset.tour = '1';
  const app = $('#app');
  const f = S.view === 'sort' ? currentFile() : null;
  app.innerHTML = topbar() + toolbar() + `<main>${S.view === 'sort' ? sortView(f) : S.view === 'review' ? reviewView() : issuesView()}</main>` + statusbar();
  if (S.allFoldersOpen) { const inp = $('#folder-filter'); inp?.focus(); inp && (inp.value = S.folderFilter); }
  renderStatus();
  syncExpanded();
}

/** Redraw in place: an edit in Review must not throw the person back to the top of the page. */
function renderKeepScroll() {
  const y = window.scrollY;
  render();
  window.scrollTo(0, y);
}

function topbar() {
  const p = me();
  const dec = decisionsById();
  const scoped = S.files;
  const sorted = scoped.filter((f) => dec[f.id] && dec[f.id].folder !== 'Unsure');
  const unsure = scoped.filter((f) => dec[f.id]?.folder === 'Unsure').length;
  const copiesTotal = scoped.reduce((n, f) => n + f.copies.length, 0);
  const copiesDone = sorted.reduce((n, f) => n + f.copies.length, 0);
  const pct = scoped.length ? (sorted.length / scoped.length) * 100 : 0;
  const theme = document.documentElement.dataset.theme;
  return `<header class="topbar">
    <div class="brand">
      <img src="public/brand/jpc-logo-horizontal-white.svg" alt="Jay Paul Company">
      <div class="divider"></div>
      <div style="min-width:0"><div class="title">File Sorter</div><div class="sub">${esc(PROPERTY.name)} · ${approved().length} folders</div></div>
    </div>
    <div class="test-badge" title="Test Mode is on: decisions go to a test spreadsheet. Nothing on SharePoint is changed."><i class="dot"></i><b>TEST MODE</b><span>· read-only</span></div>
    <div class="top-right">
      <div class="progress" title="${copiesDone} of ${copiesTotal} copies resolved · ${unsure} Unsure">
        <div class="bar"><i style="width:${pct}%"></i></div>
        <div><b title="Files sorted in this test scope">${sorted.length} / ${scoped.length} files</b><div class="small">${copiesDone}/${copiesTotal} copies · ${unsure} unsure</div></div>
      </div>
      <button class="icon-btn" data-act="help-menu" aria-label="Help, intro, tour, rules and settings" aria-haspopup="menu" aria-expanded="false" title="Help">?</button>
      <button class="icon-btn" data-act="theme" aria-label="Switch light or dark" title="${theme === 'dark' ? 'Light mode' : 'Dark mode'}">${theme === 'dark' ? I.sun : I.moon}</button>
      <button class="profile-btn" data-act="profile-menu" data-tour="profile" aria-haspopup="menu" aria-expanded="false">
        ${p ? avatar(p) : '<span class="avatar" style="background:#4B5966">?</span>'}
        <span><div class="lbl">Sorting as</div><div class="nm">${p ? esc(p.name) : 'Choose'}</div></span>
        <span style="width:16px;opacity:.7">${I.chevron}</span>
      </button>
    </div>
  </header>`;
}
const avatar = (p, cls = '') => `<span class="avatar ${cls}" style="background:${p.color}" title="${esc(p.name)}">${p.initials}</span>`;

function toolbar() {
  const dec = decisionsById();
  const reviewCount = Object.keys(dec).filter((id) => S.fileById[id] && S.files.includes(S.fileById[id])).length;
  const seg = (group, items) => `<div class="seg" role="group">${items.map(([val, label, count, blue]) =>
    `<button data-act="${group}" data-val="${val}" aria-pressed="${isOn(group, val)}">${label}${count != null ? ` <span class="count ${blue ? 'blue' : ''}">${count}</span>` : ''}</button>`).join('')}</div>`;
  const sortOnly = S.view === 'sort';
  return `<nav class="toolbar">
    <div class="tgroup" data-tour="view"><label>View</label>${seg('view', [['sort', 'Sort'], ['review', 'Review', reviewCount, true], ['issues', 'Issues', store.issues().length, true]])}</div>
    ${sortOnly ? `<div class="tgroup" data-tour="source"><label>Sort from</label>${seg('source', [['remaining', 'Remaining', queue('remaining').length, true], ['unsure', 'Unsure', queue('unsure').length]])}</div>
    <div class="tgroup" data-tour="mode"><label>Selection mode</label>${seg('mode', [['suggestion', 'Suggestion'], ['keypad', 'Keypad']])}</div>
    <div class="tgroup" data-tour="keyboard"><label>Keyboard</label><button class="kbd-ind" id="kbd-ind" data-act="toggle-shortcuts" title="Turn single-key shortcuts on or off">${I.keyboard}<i class="led"></i><span>Keyboard on</span></button></div>` : ''}
    <div class="spacer"></div>
    <div class="tgroup"><label>Beta</label><div class="inline">
      <button class="btn warn" data-act="report" data-tour="report">${I.chat} Report issue</button>
      <button class="btn" data-act="export">${I.download} Export .xlsx</button>
    </div></div>
  </nav>`;
}
function isOn(group, val) {
  if (group === 'view') return S.view === val;
  if (group === 'source') return S.source === val;
  if (group === 'mode') return mode() === val;
  return false;
}

/** 'Claude' only when real Claude suggestions exist; placeholder suggestions are called 'suggestion'. Worked out once per inventory load. */
const sugName = () => S.sugName || 'suggestion';
const scopeLabel = () => (setting('scopeFolder') ? `${setting('scopeFolder')}${setting('scopeSubfolder') ? ' › ' + setting('scopeSubfolder') : ''}` : 'All folders');
const fmtDay = (iso) => { const d = new Date(String(iso).length === 10 ? iso + 'T12:00:00' : iso); return isNaN(d) ? String(iso || '') : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };

/** Slim bar at the top of the Sort view: what is being sorted, which data, and where decisions are saved. */
function contextBar() {
  const label = esc(scopeLabel());
  const scope = isAdmin() ? `<button class="linkish" data-act="settings" title="Change the test scope"><b>${label}</b></button>` : `<b>${label}</b>`;
  const data = S.realData ? `Real data · report ${esc(fmtDay(S.dataMeta?.reportDate))}` : 'Sample data (made up)';
  return `<div class="context-bar">
    <span class="cb-scope">Sorting ${scope} · ${queue('remaining').length} of ${S.files.length} files left</span>
    <span class="cb-chip" title="${esc(S.dataSource || '')}">${data}</span>
    <span class="save-ind cb-save" data-ok="Saved in this browser"><i></i><span>Saved in this browser</span></span>
  </div>`;
}

function statusbar() {
  const kc = (k, w) => `<span class="kc sm ${w ? 'wide' : ''}">${k}</span>`;
  const keys = mode() === 'keypad'
    ? `<span>${kc('1')}–${kc('9')} folder</span><span>${kc('Enter', 1)} ${sugName() === 'Claude' ? "Claude's pick" : 'suggested pick'}</span>`
    : `<span>${kc('Enter', 1)} accept</span><span>${kc('1')} ${kc('2')} alternatives</span>`;
  return `<footer class="statusbar">
    <div class="keys">${S.view === 'sort' ? `${keys}<span>${kc('/')} all folders</span><span>${kc('.')} unsure</span><span>${kc('0')} undo</span><span>${kc('N')} note</span>` : (S.view === 'review' ? '<span>Review: changes here update the plan and the decisions spreadsheet.</span>' : '<span>Issues are saved in this browser. Export and email them to TW.</span>')}</div>
    <div class="right">
      <span class="testline">Test mode · Nothing on SharePoint is changed.</span>
      <span class="save-ind" id="save-ind" data-ok="Saved"><i></i><span>Saved</span></span>
      <a href="#" data-act="about">v${esc(S.pkg.version)} · Test mode</a>
    </div>
  </footer>`;
}

function renderStatus() {
  document.querySelectorAll('.save-ind').forEach((el) => {
    const st = store.status;
    el.classList.remove('saving', 'offline', 'error', 'ok', 'saved');
    if (st) el.classList.add(st);
    el.querySelector('span').textContent = st === 'error' ? 'Not saved' : el.dataset.ok || 'Saved';
    el.title = st === 'error' ? store.error : `Every decision is saved immediately (${store.label}).`;
  });
  const k = $('#kbd-ind');
  if (k) {
    const a = document.activeElement;
    const typing = a && (a.matches('input, textarea, select') || a.isContentEditable);
    const off = !!prefs().shortcutsOff;
    k.classList.toggle('paused', !!typing && !off);
    k.classList.toggle('off', off);
    k.setAttribute('aria-pressed', String(!off));
    k.querySelector('span').textContent = off ? 'Keyboard off · click to turn on' : typing ? 'Paused while typing' : 'Keyboard on';
  }
}

// ---------- Sort view ----------
function sortView(f) {
  if (!S.person) return `<div class="card empty"><h2>Choose your profile to start</h2><p class="muted">Every decision is saved under your initials.</p><button class="btn primary" data-act="profile-menu">Choose profile</button></div>`;
  if (!f) {
    const otherClaims = queue().length - available().length;
    return `<div class="sort-grid">${contextBar()}<div class="card empty">
      <div style="font-size:40px">${S.source === 'unsure' ? '🗂️' : '🎉'}</div>
      <h2>${S.source === 'unsure' ? 'The Unsure pile is empty' : 'Nothing left to sort in this scope'}</h2>
      <p class="muted">${otherClaims ? `${otherClaims} file(s) are open with someone else right now.` : S.source === 'remaining' && queue('unsure').length ? `${queue('unsure').length} file(s) are waiting in Unsure.` : 'Check the Review tab to see what the cleanup would do.'}</p>
      <div class="inline" style="justify-content:center">${S.source === 'remaining' && queue('unsure').length ? '<button class="btn" data-act="source" data-val="unsure">Sort from Unsure</button>' : ''}<button class="btn primary" data-act="view" data-val="review">Open Review</button><button class="btn danger" data-act="undo">${I.undo} Undo last decision</button></div>
    </div><div class="col">${whoCard()}${statsCard()}</div></div>`;
  }
  return `<div class="sort-grid">
    ${contextBar()}
    <div class="col">${practiceBanner()}${fileCard(f)}${copiesCard(f)}</div>
    <div class="col">${mode() === 'keypad' ? keypadPanel(f) : suggestionPanel(f)}${whoCard()}${statsCard()}</div>
  </div>`;
}

function fileCard(f) {
  const q = queue();
  const d = decisionsById()[f.id];
  const notes = store.notes(f.id);
  const hints = [];
  if (S.source === 'unsure' && d) hints.push(`<span class="hint warn">Marked Unsure by ${esc(d.decidedByName)} · ${fmtDateTime(d.decidedAt)}</span>`);
  if (f.similar?.length && !f.practice) hints.push(`<span class="hint info">Similar files exist (different content): ${f.similar.map((s) => `<button data-act="jump" data-id="${s.id}" title="${esc(s.differences || '')}">${esc(s.name)}</button>`).join(', ')}${f.similar[0].differences ? ` · ${esc(f.similar[0].differences)}` : ''}</span>`);
  if (f.twin) hints.push(`<span class="hint warn" title="Same name and size, different content hash. Never held automatically.">Possible duplicate: review · ${esc(folderCrumb(f.twin.path))} (${esc(f.twin.tier)})</span>`);
  if (f.newSinceReport) hints.push('<span class="hint info">New since report</span>');
  const unapprovedTops = [...new Set(f.copies.map((c) => topFolder(c.path)).filter((t) => !approved().includes(t)))];
  if (unapprovedTops.length && !f.practice) hints.push(`<span class="hint">In a folder that isn't a sorting choice: ${unapprovedTops.map(esc).join(', ')}</span>`);
  if (f.reportNote) hints.push(`<span class="hint">Report note: ${esc(f.reportNote)}</span>`);
  return `<section class="card" data-tour="file">
    <div class="file-head">
      <span class="ftype" style="background:${typeColor(f.type)}">${esc(f.type.toUpperCase())}</span>
      <div style="min-width:0"><h1>${esc(f.name)}</h1>
      <div class="meta">${fmtSize(f.size)} · ${f.copies.length} ${f.copies.length === 1 ? 'copy' : 'copies'} · ${f.practice ? 'Practice' : `${S.source === 'unsure' ? 'Unsure' : 'Remaining'} · ${q.length} left`}</div></div>
      ${f.practice ? '' : `<div class="actions"><button class="btn sm" data-act="note" title="Add a note (N)">${I.note} Note <span class="kc sm">N</span></button>
      <button class="btn sm" data-act="folder-decision" title="Send every unsorted file in a folder to one top-level folder">${I.stack} Sort this whole folder</button></div>`}
    </div>
    ${hints.length ? `<div class="hints">${hints.join('')}</div>` : ''}
    ${previewBox(f)}
    ${notes.length ? `<div class="notes-box"><h3>Notes</h3>${notes.map((n) => `<div class="note-item">${esc(n.text)} <div class="by">${esc(n.byName)} · ${fmtDateTime(n.at)}</div></div>`).join('')}</div>` : ''}
  </section>`;
}

function previewTag(f) {
  const e = previewer.get(f.id);
  const what = !e || e.state === 'loading' ? 'Loading thumbnail' : e.state === 'ok' ? 'Thumbnail' : e.state === 'sample' ? 'Sample preview'
    : e.reason === 'large' ? 'Large file · no thumbnail' : 'No thumbnail';
  return `${what} · next ${preloadedAhead()} pre-loaded`;
}

function previewBox(f) {
  const kept = keptCopy(f, f.suggestion?.folder || null, S.manualKept[f.id]).copy;
  const e = previewer.get(f.id);
  // No thumbnail to show (or still loading) for a real file: a compact row instead of the big empty box.
  if (!f.sample && (!e || e.state === 'loading' || e.state === 'none')) {
    const type = (f.type || 'file').toUpperCase();
    const why = !e || e.state === 'loading' ? 'Loading preview…' : e.reason === 'large' ? 'Too large to preview' : 'No preview here';
    const help = e?.state === 'none' && e.reason === 'unavailable' ? ' <a href="#" class="pr-help" data-act="thumb-help">How to fix</a>' : '';
    const btn = kept?.url
      ? `<a class="btn sm" href="${esc(kept.url)}" target="_blank" rel="noopener" title="Opens the kept copy in SharePoint in a new tab">Open preview ↗</a>`
      : '<a class="btn sm" aria-disabled="true" title="There is no real file to open">Open preview ↗</a>';
    return `<div class="preview-row" id="preview"><span class="ftype" style="background:${typeColor(f.type)}">${esc(type)}</span><span class="pr-text"><b>${esc(type)} · ${fmtSize(f.size)}</b> <span class="muted">· ${why}</span>${help}</span>${btn}</div>`;
  }
  const open = kept.url
    ? `<a class="open" href="${esc(kept.url)}" target="_blank" rel="noopener" title="Opens the kept copy in SharePoint in a new tab">Open full file ↗</a>`
    : '<a class="open" aria-disabled="true" title="Sample data: there is no real file to open">Open full file ↗</a>';
  return `<div class="preview" id="preview">${previewBody(f, previewer.get(f.id))}<span class="tag">${esc(previewTag(f))}</span>${open}</div>`;
}

/** Steps to let this page show SharePoint thumbnails (a browser privacy setting the person changes themselves). */
function openThumbHelp() {
  const site = location.origin;
  openModal(`${modalHead('Thumbnails not showing?')}<div class="content">
    <p style="margin:0">Thumbnails come straight from SharePoint, using your own SharePoint sign-in. Most browsers block that sign-in on other sites' pages by default, to stop tracking. You can allow it for <b>this page only</b>. Nothing else changes.</p>
    <div class="settings-sec"><h3>Chrome</h3><ol>
      <li>Open a new tab and go to <code>chrome://settings/cookies</code></li>
      <li>Under <b>Allowed to use third-party cookies</b>, click <b>Add</b>.</li>
      <li>Enter <code>${esc(site)}</code> and click <b>Add</b>.</li>
      <li>Come back here and reload the page.</li></ol></div>
    <div class="settings-sec"><h3>Microsoft Edge</h3><ol>
      <li>Go to <code>edge://settings/content/cookies</code></li>
      <li>Next to <b>Allow</b>, click <b>Add</b>.</li>
      <li>Enter <code>${esc(site)}</code>, tick <b>Include third-party cookies on this site</b>, and click <b>Add</b>.</li>
      <li>Reload this page.</li></ol></div>
    <div class="settings-sec"><h3>Safari</h3><p style="margin:0">Safari can only turn this off for every site (Settings → Privacy → “Prevent cross-site tracking”), so we don't recommend it. Use Chrome or Edge for File Sorter, or wait for Microsoft sign-in, which shows thumbnails without this setting.</p></div>
    <p class="muted small" style="margin:0">You also need to be signed in to SharePoint in this browser. Open any SharePoint page once if you're not sure.</p>
  </div><footer><button class="btn" data-act="close-modal">Close</button></footer>`, { wide: true });
}

function previewBody(f, e) {
  if (!e || e.state === 'loading') return '<div class="pv-loading">Loading thumbnail…</div>';
  if (e.state === 'ok') return `<img class="pv-thumb" src="${esc(e.src)}" alt="Thumbnail of ${esc(f.name)}" referrerpolicy="no-referrer">`;
  if (e.state === 'none') {
    const why = e.reason === 'large' ? 'Too large to preview here.' : e.reason === 'type' ? 'No preview for this file type.'
      : 'No thumbnail. If none load, your browser may be blocking SharePoint here. <a href="#" data-act="thumb-help">How to fix</a>.';
    return `<div class="pv-placeholder"><div class="big" style="background:${typeColor(f.type)}">${esc((f.type || '?').toUpperCase())}</div><div><b>${esc((f.type || 'file').toUpperCase())} · ${fmtSize(f.size)}</b></div><div class="small">${why} Use “Open full file” if you need to look.</div></div>`;
  }
  // Sample data: simple drawings by file kind.
  const kind = f.size > setting('largeFileBytes') ? 'large' : typeKind(f.type);
  if (kind === 'large') return `<div class="pv-placeholder"><div class="big" style="background:${typeColor(f.type)}">${esc(f.type.toUpperCase())}</div><div><b>${esc(f.type.toUpperCase())} · ${fmtSize(f.size)}</b></div><div class="small">Too large to preview here.</div></div>`;
  if (kind === 'image') return `<div class="pv-img">${I.image}</div>`;
  if (kind === 'video') return `<div class="pv-img" style="background:linear-gradient(160deg,#2B3440,#55606C)">${I.play}</div>`;
  if (kind === 'sheet') return `<div class="pv-sheet">${Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? '<b></b>' : '<i></i>')).join('')}</div>`;
  return `<div class="pv-doc"><i class="h"></i><i class="s"></i><i class="gap"></i><i></i><i></i><i style="width:80%"></i><i class="gap"></i><i></i><i style="width:70%"></i><i></i><i style="width:50%"></i></div>`;
}

function copiesCard(f) {
  const target = f.suggestion?.folder || null;
  const { copy: kept, manual } = keptCopy(f, target, S.manualKept[f.id]);
  const n = f.copies.length;
  const head = n > 1
    ? `<h2>${n} copies found · one decision covers all of them</h2><p>One copy is kept and moved to the folder you choose. The other ${n - 1} go${n - 1 === 1 ? 'es' : ''} to Duplicate Hold (not deleted), with a shortcut left behind. The kept copy is picked automatically: change it only if you know another copy is the right version.</p>${new Set(f.copies.map((c) => topFolder(c.path))).size > 1 ? `<p class="muted small">Kept copy shown for the suggested folder${target ? ` (${esc(target)})` : ''}. If you choose a different folder, a copy already in that folder is kept instead.</p>` : ''}`
    : `<h2>1 copy · no duplicates</h2><p>This file only exists in one place.</p>`;
  const rows = f.copies.map((c) => {
    const isKept = c === kept;
    const parts = pathParts(c.path);
    const pathHtml = `${esc(PROPERTY.library)}/<span class="seg-top">${esc(parts[0])}</span>/${esc(parts.slice(1).join('/'))}`;
    const right = isKept
      ? `<span class="pill">Kept copy · ${manual ? 'your choice' : 'auto'}</span>${manual ? '<button class="btn sm ghost" data-act="kept-auto">Use auto</button>' : ''}`
      : `<span class="to-hold">→ Duplicate Hold</span><button class="btn sm" data-act="keep" data-path="${esc(c.path)}">Keep this one instead</button>`;
    return `<div class="copy-row ${isKept ? 'kept' : ''}">${I.folder}<div><div class="path">${pathHtml}</div><div class="when">Modified ${fmtMonth(c.modified)}${c.reportKeep ? ' · report suggests KEEP' : ''}</div></div><div class="right">${n > 1 ? right : ''}</div></div>`;
  }).join('');
  return `<section class="card" data-tour="copies"><div class="copies-head">${head}</div>${rows}</section>`;
}

function confirmBar() {
  if (!S.confirm) return '';
  return `<div class="confirm ${S.confirm.tone === 'warn' ? 'warn' : ''}">${I.check}<div>${esc(S.confirm.text)}</div></div>`;
}

function suggestionPanel(f) {
  const s = f.suggestion;
  const alts = s?.alts || [];
  return `<section class="card" data-tour="decision">
    <div class="panel-head"><h2 tabindex="-1">Decision</h2>${s ? `<span class="conf ${s.confidence}">${s.confidence} confidence</span>` : ''}</div>
    <div class="panel-body">
      <div class="panel-hint">${I.keyboard}<span>Click a button, or press the key shown on it.</span></div>
      ${s ? `<button class="suggest" data-act="pick" data-folder="${esc(s.folder)}"><div><div class="eyebrow">${s.placeholder ? 'Placeholder suggestion' : 'Claude suggests'}</div><div class="folder">${esc(s.folder)}</div></div><span class="kc wide">Enter</span></button>
      <div class="reason">${esc(s.reason)}${s.rule ? `<br><span class="rule">Rule used: ${esc(s.rule)}</span>` : ''}</div>`
      : '<div class="reason">No suggestion yet for this file. Pick a folder from the list.</div>'}
      ${alts.map((a, i) => `<button class="choice" data-act="pick" data-folder="${esc(a)}"><span class="kc">${i + 1}</span>${esc(a)}</button>`).join('')}
      ${commonButtons()}
      ${S.allFoldersOpen ? allFoldersList() : ''}
    </div>${confirmBar()}
  </section>`;
}

function commonButtons() {
  return `<div data-tour="unsure-undo" style="display:flex;flex-direction:column;gap:10px">
    <div class="row2"><button class="choice allf ${S.allFoldersOpen ? 'active' : ''}" data-act="all-folders" aria-expanded="${S.allFoldersOpen}"><span class="kc">/</span>All folders</button>
    <button class="choice unsure" data-act="pick" data-folder="Unsure" ${S.source === 'unsure' && !S.practice ? 'disabled title="Already in the Unsure pile"' : ''}><span class="kc">.</span>Unsure</button></div>
    <button class="choice undo" data-act="undo">${I.undo} Undo last decision <span class="kc">0</span></button>
  </div>`;
}

function allFoldersList() {
  return `<div class="folder-filter">${I.search}<input id="folder-filter" placeholder="Filter ${approved().length} folders" autocomplete="off" aria-label="Filter folders"></div>
    <div class="folder-list" id="folder-list">${folderListItems()}</div>`;
}
function filteredFolders() {
  const q = S.folderFilter.trim().toLowerCase();
  return approved().filter((f) => !q || f.toLowerCase().includes(q) || (q.includes('pm const') && f === 'Construction & Development'));
}
function folderListItems() {
  const list = filteredFolders();
  if (!list.length) return '<div class="muted" style="padding:12px">No folder matches.</div>';
  return list.map((f, i) => `<button data-act="pick" data-folder="${esc(f)}" class="${i === S.folderHl ? 'hl' : ''}">${esc(f)}${f === 'Construction & Development' ? '<span class="tag">also “PM Construction”</span>' : ''}</button>`).join('');
}

function keypadPanel(f) {
  const { keys, state } = keypadLayout(f);
  const pick = f.suggestion?.folder;
  const n = setting('keypadLearningFiles');
  const learn = state.locked
    ? '<div class="learn locked">Numbers locked. Folders keep their keys from now on.</div>'
    : `<div class="learn">Learning your numbers · ${state.sorted} of ${n} sorted. Keys may still shift.</div>`;
  const order = [7, 8, 9, 4, 5, 6, 1, 2, 3];
  const anySpare = Object.values(keys).some((k) => k.spare);
  return `<section class="card" data-tour="decision">
    <div class="panel-head"><h2 tabindex="-1">Keypad</h2>${f.suggestion ? `<span class="conf ${f.suggestion.confidence}">${f.suggestion.confidence} confidence</span>` : ''}</div>
    <div class="panel-body">
      <div class="panel-hint">${I.keyboard}<span>Click a folder, or press its number (number row or number pad).</span></div>
      ${learn}
      <div class="keypad" id="keypad">${order.map((k) => {
        const slot = keys[k];
        if (!slot) return `<button class="kkey" disabled><div class="top"><span class="kc">${k}</span></div><span class="muted">—</span></button>`;
        const isPick = slot.folder === pick;
        return `<button class="kkey ${isPick ? 'pick' : ''}" data-act="pick" data-folder="${esc(slot.folder)}" title="${slot.spare ? 'Spare key: this folder\'s own key is busy or it has no number of its own' : 'Home key'}">
          <div class="top"><span class="kc">${k}</span>${isPick ? '<i class="pickdot"></i>' : ''}${slot.spare ? '<span class="spare">SPARE</span>' : ''}</div><span>${esc(slot.folder)}</span></button>`;
      }).join('')}</div>
      <div class="legend"><span><i class="pickdot"></i>${f.suggestion?.placeholder ? 'Suggested pick' : "Claude's pick"} (also <span class="kc sm wide">Enter</span>)</span>${anySpare ? '<span><b class="spare">SPARE</b> folder\'s own key is busy</span>' : ''}${f.suggestion?.reason ? `<span class="muted">${esc(f.suggestion.reason)}</span>` : ''}</div>
      ${commonButtons()}
      ${S.allFoldersOpen ? allFoldersList() : ''}
    </div>${confirmBar()}
  </section>`;
}

function whoCard() {
  const claims = store.db.claims;
  const idle = setting('claimIdleMinutes');
  const rows = PEOPLE.map((p) => {
    const entry = Object.entries(claims).find(([, c]) => c.by === p.id && Date.now() - new Date(c.at).getTime() < idle * 60e3);
    const what = entry ? `Has open: ${esc(S.fileById[entry[0]]?.name || 'a file')}` : 'Not sorting right now';
    return `<div class="who-row">${avatar(p, 'sm')}<div><b>${esc(p.name)}</b>${p.id === S.person ? ' (you)' : ''}<div class="what">${what}</div></div></div>`;
  }).join('');
  return `<details class="card collapsible" ${prefs().whoOpen ? 'open' : ''} data-act-toggle="whoOpen">
    <summary>Who's sorting right now<span class="right"><span class="avatars">${PEOPLE.map((p) => avatar(p, 'sm')).join('')}</span><span class="chev">▶</span></span></summary>
    <div class="body"><div class="muted">Each open file is held for that person, so no two people sort the same file. A hold is released after ${idle} minutes idle or when they close the app.</div>${rows}
    <div class="muted small">Phase 1 runs in this browser only. Shared sorting arrives with sign-in in phase 3.</div></div>
  </details>`;
}

function speedStats(filterFn = () => true) {
  const rows = Object.values(decisionsById()).filter((d) => S.fileById[d.fileId] && d.decisionType === 'single file' && d.seconds > 0 && filterFn(d));
  const avg = rows.length ? rows.reduce((n, d) => n + Math.min(d.seconds, 600), 0) / rows.length : 0; // cap outliers at 10 min
  return { n: rows.length, avg, perHour: avg ? 3600 / avg : 0 };
}
function statsCard() {
  const all = speedStats();
  const remaining = queue('remaining').length + queue('unsure').length;
  const byMode = ['suggestion', 'keypad'].map((m) => ({ m, ...speedStats((d) => d.mode === m) }));
  return `<details class="card collapsible" ${prefs().statsOpen ? 'open' : ''} data-act-toggle="statsOpen">
    <summary>Speed<span class="right"><span class="muted small">${all.n ? `${all.avg.toFixed(1)} s / file` : 'no data yet'}</span><span class="chev">▶</span></span></summary>
    <div class="body">
      <div class="stats-grid">
        <div class="stat"><b>${all.n ? all.avg.toFixed(1) + 's' : '—'}</b><span>avg per file</span></div>
        <div class="stat"><b>${all.n ? Math.round(all.perHour) : '—'}</b><span>files / hour</span></div>
        <div class="stat"><b>${all.n ? fmtDuration(remaining * all.avg) : '—'}</b><span>to finish ${remaining} left</span></div>
      </div>
      <table class="mini"><tr><th>Mode</th><th>Files</th><th>Avg</th><th>Per hour</th></tr>
      ${byMode.map((r) => `<tr><td>${r.m === 'suggestion' ? 'Suggestion' : 'Keypad'}</td><td>${r.n}</td><td>${r.n ? r.avg.toFixed(1) + 's' : '—'}</td><td>${r.n ? Math.round(r.perHour) : '—'}</td></tr>`).join('')}</table>
      <div class="muted small">Timed from when a file appears to when it's decided. ${isAdmin() ? 'Per-person breakdown is in Settings.' : ''}</div>
    </div>
  </details>`;
}

// ---------- Review view ----------
const PAGE_SIZE = 50;          // decision cards per page
const SEARCH_DEBOUNCE_MS = 200;
const TREE_MATCH_CAP = 300;    // most matching files drawn per tree while searching
const fmtN = (n) => Number(n).toLocaleString('en-US');

/**
 * The plan for the current scope: actions, totals, conflicts, approval state, plus the lists Review draws from.
 * Cached: it is only worked out again when the saved data (store revision), the inventory, the scope or the
 * settings change. Every Review redraw, export and approval reads the same object.
 */
let planCache = null;
function planState() {
  const db = store.db, maxLen = setting('maxPathLength');
  const c = planCache;
  if (c && c.db === db && c.rev === db.rev && c.files === S.files && c.allFiles === S.allFiles && c.inv === S.inventoryId && c.maxLen === maxLen) return c.P;
  const P = computePlan(maxLen);
  planCache = { db, rev: db.rev, files: S.files, allFiles: S.allFiles, inv: S.inventoryId, maxLen, P };
  return P;
}

function computePlan(maxLen) {
  const dec = decisionsById();
  const all = Object.values(dec);
  const inScope = new Set(S.files.map((f) => f.id));
  const decisions = all.filter((d) => inScope.has(d.fileId));
  const orphans = all.filter((d) => !S.fileById[d.fileId]); // decisions whose file isn't in this inventory
  const plans = planByFile(S.allFiles, all);                 // each decision planned once, shared below
  const actions = buildPlan(S.files, decisions, plans);
  const sum = planSummary(S.files, decisions, plans);
  // Site part of the path counts toward SharePoint's limit. Sample data has no site, so assume a typical length.
  const sitePath = S.dataMeta?.siteBase ? new URL(S.dataMeta.siteBase).pathname : 'x'.repeat(21);
  const issues = conflictChecks(S.allFiles, [...decisions, ...orphans], { maxPathLength: maxLen, sitePath, allDecisionsById: dec, plans });
  const fingerprint = planFingerprint(actions);
  const approval = store.approvals().filter((a) => a.fingerprint === fingerprint && a.inventoryId === S.inventoryId).at(-1) || null;
  const lastApproval = store.approvals().at(-1) || null;
  const unreviewed = decisions.filter((d) => !d.reviewedBy).length;
  const gates = [
    { ok: decisions.length > 0, text: decisions.length ? `${decisions.length} decision${decisions.length === 1 ? '' : 's'} in the plan` : 'No decisions yet' },
    { ok: unreviewed === 0, text: unreviewed ? `${unreviewed} not yet reviewed` : 'Every decision reviewed' },
    { ok: issues.length === 0, text: issues.length ? `${issues.length} conflict${issues.length === 1 ? '' : 's'} to resolve` : 'No conflicts (checked against the whole library)' },
    { ok: null, text: 'Live SharePoint re-check: arrives with sign-in (phase 3)' },
  ];
  // Lists for the Changes tab, worked out once per plan rather than once per redraw.
  const issueBy = new Map();
  for (const i of issues) { if (!issueBy.has(i.fileId)) issueBy.set(i.fileId, []); issueBy.get(i.fileId).push(i); }
  const sorted = [...decisions].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  const folderCounts = {};
  for (const d of decisions) folderCounts[d.folder] = (folderCounts[d.folder] || 0) + 1;
  const orphanEntries = orphans.map((d) => ({ orphan: true, fileId: d.fileId, fileName: d.fileName }));
  const P = { decisions, actions, sum, issues, fingerprint, approval, lastApproval, gates, canApprove: gates.every((g) => g.ok !== false),
    issueBy, sorted, folderCounts, orphanEntries,
    queues: { toreview: unreviewed, conflicts: issueBy.size, reviewed: decisions.length - unreviewed, all: decisions.length },
    finished: decisions.length > 0 && unreviewed === 0 && issues.length === 0 };
  let trees = null;
  Object.defineProperty(P, 'trees', { get: () => trees || (trees = computeTrees(dec)) }); // only the Folder tree tab needs these
  return P;
}

function computeTrees(dec) {
  const t = buildTrees(S.files, dec);
  const changedTops = new Set();
  for (const d of Object.values(dec)) { const f = S.fileById[d.fileId]; if (!f || d.folder === 'Unsure') continue; changedTops.add(d.folder); f.copies.forEach((c) => changedTops.add(topFolder(c.path))); }
  return { t, unchanged: approved().filter((f) => !changedTops.has(f)).length };
}

function reviewView() {
  flushPendingSearch(); // a half-debounced search box is applied before the page is redrawn
  const P = planState();
  S.plan = P;
  const { sum, issues } = P;
  const R = S.review;
  const reviewer = !!me()?.reviewer;
  const status = P.approval
    ? `<b class="ok-text">Approved</b> by ${esc(P.approval.byName)} · ${fmtDateTime(P.approval.at)} · this exact plan`
    : P.lastApproval ? '<b class="warn-text">Draft</b> · the plan changed since the last approval, so it needs approving again' : '<b class="warn-text">Draft</b> · not approved yet';
  const queues = [['toreview', 'To review'], ['conflicts', 'Conflicts'], ['reviewed', 'Reviewed'], ['all', 'All']];
  return `<div class="review">
    <div class="review-head"><div><h1>Review simulated changes</h1><p>What the cleanup would do with the decisions so far. Test mode: nothing is actually moved or changed.</p></div></div>
    <div class="card approval">
      <div class="ap-main"><div class="ap-status">Plan status: ${status}</div>
        <ul class="gates">${P.gates.map((g) => `<li class="${g.ok === true ? 'ok' : g.ok === false ? 'no' : 'na'}">${g.ok === true ? '✓' : g.ok === false ? '✗' : '–'} ${esc(g.text)}</li>`).join('')}</ul></div>
      <div class="ap-actions">
        <button class="btn" data-act="export-plan" data-kind="draft">${I.download} Export draft plan</button>
        ${P.approval ? `<button class="btn primary" data-act="export-plan" data-kind="approved">${I.download} Export approved plan</button>`
          : `<button class="btn primary" data-act="approve-plan" ${reviewer && P.canApprove ? '' : 'disabled'} title="${reviewer ? (P.canApprove ? 'Approve exactly this plan' : 'Every check above must pass first') : 'Only TW or KB can approve'}">${I.check} Approve plan</button>`}
      </div>
    </div>
    ${P.finished ? `<section class="card finished" aria-label="Finished reviewing">${I.check}<div><b>Everything is reviewed.</b> ${P.approval ? 'This exact plan is approved. Next: export the approved plan.' : 'Next: TW or KB approves the plan.'}</div>
      <button class="btn" data-act="goto-approval">${P.approval ? 'Show the export step' : 'Show the approval step'}</button></section>` : ''}
    <div class="sum-cards">
      <div class="card"><b>${sum.sorted}</b><span>Files sorted</span></div>
      <div class="card"><b>${sum.move}</b><span>Files that would move</span></div>
      <div class="card"><b>${sum.stays}</b><span>Already in the right folder</span></div>
      <div class="card"><b>${sum.hold}</b><span>Duplicates to hold (not deleted)</span></div>
      <div class="card"><b>${sum.reviewed} / ${sum.total}</b><span>Reviewed</span></div>
    </div>
    <div class="card safety">${I.shield}<div><b>Nothing is permanently deleted.</b> Duplicates go to a Duplicate Hold folder for ${setting('holdDays')} days, with a shortcut left in each old spot, and can be restored from there. They're only deleted after TW or KB signs off and the hold period ends. Only copies verified identical are held, the kept copy is never held and keeps its own file name, and a full backup of the property folder is taken before any real cleanup.</div></div>
    ${issues.length ? `<div class="card"><div class="panel-head"><h2>Conflict checks · ${issues.length}</h2><span class="muted small">Checked against the whole library, not just the test scope</span></div>${issues.slice(0, 50).map((i) => `<div class="issue"><b>${esc(i.kind)}</b> ${esc(S.fileById[i.fileId]?.name || i.fileName || i.fileId)}: ${esc(i.detail)}</div>`).join('')}${issues.length > 50 ? `<div class="issue">…and ${issues.length - 50} more (all are in the draft export)</div>` : ''}</div>` : ''}
    <div class="review-tools">
      <div class="seg">${[['changes', 'Changes by file'], ['tree', 'Folder tree: before → after']].map(([v, l]) => `<button data-act="review-tab" data-val="${v}" aria-pressed="${R.tab === v}">${l}</button>`).join('')}</div>
      ${R.tab === 'changes' ? `<div class="seg" role="group" aria-label="Queue">${queues.map(([v, l]) => `<button data-act="rv-queue" data-val="${v}" aria-pressed="${R.queue === v}">${l} (${fmtN(P.queues[v])})</button>`).join('')}</div>
      <input type="search" class="rv-search" data-act-input="rv-q" placeholder="Search file name or path" aria-label="Search decisions by file name or path" value="${esc(R.search)}" autocomplete="off">
      <div class="filters">
        <select data-act-change="rf-person" aria-label="Filter by person"><option value="">Everyone</option>${PEOPLE.map((p) => `<option value="${p.id}" ${R.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select data-act-change="rf-type" aria-label="Filter by decision type"><option value="">Single + folder decisions</option><option value="single file" ${R.type === 'single file' ? 'selected' : ''}>Single files</option><option value="folder decision" ${R.type === 'folder decision' ? 'selected' : ''}>Folder decisions</option></select>
        <label class="chk"><input type="checkbox" data-act-change="rf-changed" ${R.changed ? 'checked' : ''}> Changed from suggestion</label>
      </div>` : ''}
    </div>
    ${R.tab === 'changes' ? changesByFile(P) : folderTrees(P)}
  </div>`;
}

// ---------- Review: the decision list (queues, search, paging) ----------
const searchText = new WeakMap(); // file -> lower-case name and every copy's path, built once per file
function haystack(f) {
  let h = searchText.get(f);
  if (h === undefined) { h = `${f.name}\n${f.copies.map((c) => c.path).join('\n')}`.toLowerCase(); searchText.set(f, h); }
  return h;
}

/** The entries (decisions, plus orphans in the Conflicts queue) that match the queue, filters and search box. */
function reviewList(P) {
  const R = S.review;
  let list = P.sorted;
  if (R.queue === 'toreview') list = list.filter((d) => !d.reviewedBy);
  else if (R.queue === 'reviewed') list = list.filter((d) => d.reviewedBy);
  else if (R.queue === 'conflicts') list = list.filter((d) => P.issueBy.has(d.fileId));
  if (R.folder !== 'all') list = list.filter((d) => d.folder === R.folder);
  if (R.person) list = list.filter((d) => d.decidedBy === R.person);
  if (R.type) list = list.filter((d) => d.decisionType === R.type);
  if (R.changed) list = list.filter((d) => d.folder !== 'Unsure' && !d.accepted);
  const words = R.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) list = list.filter((d) => { const f = S.fileById[d.fileId]; const h = f ? haystack(f) : ''; return words.every((w) => h.includes(w)); });
  // Conflicts about decisions whose file is no longer in the inventory have no card of their own; list them here.
  if (R.queue === 'conflicts' && R.folder === 'all' && !R.person && !R.type && !R.changed) {
    const extra = P.orphanEntries.filter((o) => !words.length || words.every((w) => String(o.fileName || o.fileId).toLowerCase().includes(w)));
    if (extra.length) list = [...list, ...extra];
  }
  return list;
}

function changesByFile(P) {
  const R = S.review;
  const folders = approved().filter((f) => P.folderCounts[f]);
  const empty = approved().length - folders.length;
  return `<div class="review-grid">
    <div class="card dest-list"><div class="lh">Destination folders</div>
      <button class="${R.folder === 'all' ? 'sel' : ''}" data-act="rf-folder" data-val="all">All decisions <span class="count">${P.decisions.length}</span></button>
      ${folders.map((f) => `<button class="${R.folder === f ? 'sel' : ''}" data-act="rf-folder" data-val="${esc(f)}">${esc(f)} <span class="count">${P.folderCounts[f]}</span></button>`).join('')}
      <button class="unsure ${R.folder === 'Unsure' ? 'sel' : ''}" data-act="rf-folder" data-val="Unsure">Unsure <span class="count">${P.folderCounts.Unsure || 0}</span></button>
      <div class="foot">${empty} of ${approved().length} folders receive nothing yet</div>
    </div>
    <div id="rv-results">${reviewResults(P)}</div>
  </div>`;
}

/** The heading, pager and (at most PAGE_SIZE) cards. Redrawn on its own while typing in the search box or changing page. */
function reviewResults(P) {
  const R = S.review;
  const list = reviewList(P);
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  R.page = Math.min(Math.max(1, R.page), pages); // editing a card keeps the page; it only moves if the list got shorter
  const from = (R.page - 1) * PAGE_SIZE, to = Math.min(list.length, from + PAGE_SIZE);
  const title = R.folder === 'all' ? 'All decisions' : R.folder;
  const pager = list.length > PAGE_SIZE ? `<nav class="pager" aria-label="Pages of decisions"><span class="pg-info">Showing ${fmtN(from + 1)}–${fmtN(to)} of ${fmtN(list.length)}</span>
      <span class="pg-btns"><button class="btn" data-act="rv-page" data-val="prev" ${R.page <= 1 ? 'disabled' : ''}>Previous</button><button class="btn" data-act="rv-page" data-val="next" ${R.page >= pages ? 'disabled' : ''}>Next</button></span></nav>` : '';
  const none = R.queue === 'toreview' && P.queues.toreview === 0 ? 'Nothing is left to review.' : 'No decisions match.';
  return `<div class="list-head"><h2>${esc(title)}</h2><span class="muted">${fmtN(list.length)} file${list.length === 1 ? '' : 's'}</span></div>
    ${pager}
    ${list.length ? list.slice(from, to).map((d) => (d.orphan ? orphanCard(d, P.issueBy.get(d.fileId)) : decisionCard(d, P.issueBy.get(d.fileId)))).join('') : `<div class="card empty"><p class="muted">${none}</p></div>`}
    ${list.length > 8 ? pager : ''}`;
}

function orphanCard(o, issues = []) {
  return `<article class="card dcard"><div class="dh"><div><div class="t">${esc(o.fileName || o.fileId)}</div><div class="s">Not in the current inventory</div></div></div>
    ${issues.map((i) => `<div class="issue"><b>${esc(i.kind)}</b> ${esc(i.detail)}</div>`).join('')}</article>`;
}

function decisionCard(d, issues = []) {
  const f = S.fileById[d.fileId];
  const acts = planForDecision(f, d);
  const nm = (p) => esc(p.split('/').at(-1));
  const line = (a) => {
    if (a.action === 'Move') return `${esc(folderCrumb(a.from))} → ${esc(d.folder)} · keeps its name: ${nm(a.from)}`;
    if (a.action === 'Stays') return `Kept copy already in ${esc(d.folder)}: ${esc(folderCrumb(a.from))}`;
    if (a.action === 'Hold') return `Duplicate in ${esc(folderCrumb(a.from))} → Duplicate Hold (not deleted)`;
    if (a.action === 'Shortcut') return `Shortcut left in ${esc(folderCrumb(a.from))}, pointing to the kept copy`;
    if (a.action === 'Blocked') return esc(a.note);
    return `${esc(folderCrumb(a.from))} · stays where it is${a.note ? ` (${esc(a.note)})` : ''}`;
  };
  const sugWord = f.suggestion?.placeholder ? 'suggestion' : 'Claude';
  const matches = d.folder === 'Unsure' ? 'marked Unsure' : d.accepted ? `matches ${sugWord}` : `<span class="changed">changed from ${sugWord} (${esc(d.suggestion || 'none')})</span>`;
  const reviewer = d.reviewedBy ? peopleById[d.reviewedBy]?.name : null;
  return `<article class="card dcard">
    <div class="dh"><span class="ftype" style="background:${typeColor(f.type)}">${esc(f.type.toUpperCase())}</span>
      <div><div class="t">${esc(f.name)}</div><div class="s">${d.folder === 'Unsure' ? 'Sent to Unsure' : `Sorted into ${esc(d.folder)}`} by ${esc(d.decidedByName)} · ${matches}${d.decisionType === 'folder decision' ? ` · folder decision (${esc(folderCrumb(d.folderDecisionPath + '/x'))})` : ''}${d.editedBy ? ` · edited in review by ${esc(d.editedBy)}` : ''}</div></div>
      <button class="btn ${reviewer ? 'reviewed' : ''}" data-act="mark-reviewed" data-id="${d.fileId}">${reviewer ? `${I.check} Reviewed by ${esc(reviewer)} · ${fmtDateTime(d.reviewedAt)}` : 'Mark reviewed'}</button></div>
    <div class="actions-list">${acts.map((a) => `<div class="act"><span class="atag ${a.action.replace(' ', '')}">${a.action}</span><span>${line(a)}</span></div>`).join('')}</div>
    ${issues.map((i) => `<div class="issue"><b>${esc(i.kind)}</b> ${esc(i.detail)}</div>`).join('')}
    <div class="df">Folder <select class="inp" data-act-change="edit-folder" data-id="${d.fileId}">${['Unsure', ...approved()].map((o) => `<option ${o === d.folder ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select> Changing it here updates the plan and the decisions spreadsheet.</div>
  </article>`;
}

// ---------- Review: folder trees ----------
const treeTotals = new WeakMap(); // tree node -> files under it (the trees are rebuilt only when the plan changes)
const totalOf = (n) => { let t = treeTotals.get(n); if (t === undefined) { t = countFiles(n); treeTotals.set(n, t); } return t; };
const lcName = (fl) => fl.lc ?? (fl.lc = fl.name.toLowerCase());

/**
 * One tree (before or after) as HTML: the top folders under `root`, then any `extras` ([node, key]) after them.
 * While searching, only folders on the way to a match are drawn, and at most TREE_MATCH_CAP files.
 * Returns { html, matches, shown } (matches and shown are 0 when not searching).
 */
function treeHtml(root, prefix, q, extras = []) {
  const hits = new Map(); // node -> matching files in its subtree
  if (q) {
    const walk = (n) => { let c = 0; for (const f of n.files) if (lcName(f).includes(q)) c++; for (const k of n.children.values()) c += walk(k); hits.set(n, c); return c; };
    for (const k of root.children.values()) walk(k);
    for (const [n] of extras) walk(n);
  }
  const budget = { left: TREE_MATCH_CAP };
  const node = (n, key, depth) => {
    if (q && (!hits.get(n) || budget.left <= 0)) return '';
    const total = totalOf(n);
    const kids = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    const isOpen = q ? true : S.review.open.has(key) ? true : depth === 0 && !S.review.open.has('x:' + key);
    const pad = `style="padding-left:${18 + depth * 18}px"`;
    let inner = '';
    if (isOpen) {
      inner = kids.map((k) => node(k, key + '/' + k.name, depth + 1)).join('');
      for (const fl of n.files) {
        if (q) { if (!lcName(fl).includes(q) || budget.left <= 0) continue; budget.left--; }
        inner += `<div class="tfile" style="padding-left:${36 + depth * 18}px">${I.file}${esc(fl.name)}${fl.tag ? `<span class="ttag ${fl.tag.tone}">${esc(fl.tag.label)}</span>` : ''}</div>`;
      }
    }
    return `<div class="tnode"><div class="trow" role="button" tabindex="0" aria-expanded="${isOpen}" aria-label="${esc(n.name)}, ${total} file${total === 1 ? '' : 's'}" data-act="tree-toggle" data-key="${esc(key)}" data-depth="${depth}" ${pad}><span class="tw" aria-hidden="true">${isOpen ? '▼' : '▶'}</span>${I.folder}${esc(n.name)}<span class="count">${total}</span></div>${inner}</div>`;
  };
  const tops = [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((k) => node(k, prefix + k.name, 0)).join('');
  const html = tops + extras.filter(([n]) => totalOf(n)).map(([n, key]) => node(n, key, 0)).join('');
  const matches = q ? [...root.children.values()].reduce((sum, k) => sum + hits.get(k), 0) + extras.reduce((sum, [n]) => sum + hits.get(n), 0) : 0;
  return { html, matches, shown: q ? TREE_MATCH_CAP - budget.left : 0 };
}

/** The "Before" and "After" tree bodies. Redrawn on their own while typing in the tree search box. */
function treeBodies(P) {
  const { t, unchanged } = P.trees;
  const q = S.review.query.trim().toLowerCase();
  const deletedZero = 0; // the plan never deletes anything
  const note = (r) => (q && r.matches > r.shown ? `<div class="tree-note">Showing the first ${fmtN(r.shown)} of ${fmtN(r.matches)} matching files. Type more to narrow the search.</div>` : '');
  const before = treeHtml(t.before, 'b:', q);
  const after = treeHtml(t.after, 'a:', q, [[t.notSorted, 'a:__notsorted'], [t.hold, 'a:__hold'], [t.leftInPlace, 'a:__left']]);
  return {
    before: before.html + note(before),
    after: after.html + note(after)
      + `<div class="tree-foot">${unchanged} other folders unchanged · ${t.shortcuts} shortcut${t.shortcuts === 1 ? '' : 's'} left in old locations · ${deletedZero} files deleted</div>`,
  };
}

function folderTrees(P) {
  const b = treeBodies(P);
  const search = `<div class="search"><input type="search" data-act-input="tree-q" placeholder="Search file names" aria-label="Search file names in the folder tree" value="${esc(S.review.query)}" autocomplete="off"></div>`;
  return `<div class="trees">
    <div class="card tree"><div class="th"><h3>Before · today</h3><p>${esc(PROPERTY.name)}, every copy where it lives now</p></div>
      ${search}
      <div class="tree-body" data-tree="before">${b.before}</div></div>
    <div class="card tree"><div class="th"><h3>After · simulated cleanup</h3><p>One copy of each sorted file, in its chosen folder</p></div>
      ${search}
      <div class="tree-body" data-tree="after">${b.after}</div></div>
  </div>`;
}

// ---------- Review: debounced search boxes ----------
// Typing never redraws the whole page. After a short pause, only the list (or the two trees) is redrawn.
const pending = { list: null, tree: null };
function applyListSearch(value) {
  S.review.search = value; S.review.page = 1;
  const box = $('#rv-results');
  if (box) box.innerHTML = reviewResults(planState());
}
function applyTreeSearch(value) {
  S.review.query = value;
  const bodies = document.querySelectorAll('.tree-body');
  if (!bodies.length) return;
  const b = treeBodies(planState());
  for (const el of bodies) el.innerHTML = el.dataset.tree === 'before' ? b.before : b.after;
  for (const i of document.querySelectorAll('[data-act-input="tree-q"]')) if (i.value !== value) i.value = value; // keep both boxes alike
}
function debounceSearch(kind, value) {
  clearTimeout(pending[kind]?.timer);
  const fn = kind === 'list' ? applyListSearch : applyTreeSearch;
  pending[kind] = { value, timer: setTimeout(() => { pending[kind] = null; fn(value); }, SEARCH_DEBOUNCE_MS) };
}
/** Apply any search the person has typed but that hasn't fired yet (called before a full redraw, so nothing typed is lost). */
function flushPendingSearch() {
  for (const kind of ['list', 'tree']) {
    const p = pending[kind];
    if (!p) continue;
    clearTimeout(p.timer); pending[kind] = null;
    if (kind === 'list') { S.review.search = p.value; S.review.page = 1; } else S.review.query = p.value;
  }
}

const scopeText = () => (setting('scopeFolder') ? `${setting('scopeFolder')}${setting('scopeSubfolder') ? ' › ' + setting('scopeSubfolder') : ''}` : 'All folders') + ` · first ${setting('scopeFirstN')}`;

// ---------- Modals ----------
/** A write failed: say so plainly and offer the export, rather than pretending it saved. */
function showSaveError() {
  announce(`Not saved. ${store.error || 'The last change could not be saved.'}`, { assertive: true });
  openModal(`${modalHead('Not saved')}<div class="content">
    <p style="margin:0"><b>${esc(store.error || 'The last change could not be saved.')}</b> Nothing was lost from before it, but new decisions can't be saved in this browser right now.</p>
    <p style="margin:0">Please export your decisions now, then tell TW (Report issue).</p>
  </div><footer><button class="btn" data-act="close-modal">Close</button><button class="btn primary" data-act="export">Export .xlsx now</button></footer>`);
}

// Every dialog goes through openModal/closeModal, so the accessibility behaviour lives here once:
// role=dialog + aria-modal + aria-labelledby (the first <h2>), the page behind is inert, focus moves in
// (first form control, else the footer's main button), Tab is trapped (see bindGlobalEvents), Escape closes
// unless the dialog is locked, and focus goes back to whatever opened it (keyboard use only, see a11y.js).
const FOCUS_FALLBACK = '[data-tour="decision"] h2'; // where focus lands if the opener was redrawn away
let menuReturn = null; // a menu item opened a dialog: the dialog should return focus to the menu's button
const takeMenuReturn = () => { const m = menuReturn; menuReturn = null; return m && Date.now() - m.at < 3000 ? m.op : null; };

function openModal(html, { wide = false, onClose, locked = false } = {}) {
  const prev = S.modal;
  const opener = prev ? prev.opener : (takeMenuReturn() || captureOpener());
  if (prev) closeModal(false); // replaced by another dialog: the first opener still gets focus back at the end
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
  const box = ov.firstElementChild;
  const title = $('h2', box);
  if (title) { title.id = 'modal-title'; box.setAttribute('aria-labelledby', 'modal-title'); }
  if (!locked) ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
  $('#app').inert = true;
  S.modal = { el: ov, onClose, locked, opener, inert: true };
  (ov.querySelector('[autofocus]') || $('.content input, .content select, .content textarea', ov) || $('.content button', ov)
    || $('footer .primary', ov) || $('footer button', ov) || $('.x', ov) || box).focus();
  renderStatus();
  return ov;
}
function closeModal(restore = true) {
  const m = S.modal;
  if (!m) return;
  m.el.remove();
  S.modal = null;
  if (m.inert) $('#app').inert = false;
  m.onClose?.();
  renderStatus();
  if (restore) restoreFocus(m.opener, FOCUS_FALLBACK);
}
const modalHead = (title) => `<header><h2>${title}</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>`;

// ---------- Report issue ----------
const ISSUE_TYPES = ['Bug', 'Confusing', 'Idea'];
const ISSUE_STATUSES = ['Open', 'Fixed', "Won't fix"];
const initialsOf = (id) => peopleById[id]?.initials || '?';
function whereNow() {
  if (S.view === 'sort') return `Sort / ${mode() === 'keypad' ? 'Keypad' : 'Suggestion'}`;
  return S.view === 'review' ? 'Review' : 'Issues';
}

function openReport() {
  const f = S.view === 'sort' ? currentFile() : null;
  const now = new Date();
  const where = whereNow();
  let type = 'Bug';
  const attached = [`v${S.pkg.version}`, me() ? me().initials : 'no profile', where, f ? `File: ${f.name}` : null, fmtDateTime(now.toISOString())].filter(Boolean).join(' · ');
  const ov = openModal(`<header><h2>Report an issue</h2><button class="x" data-act="close-modal" aria-label="Close">×</button></header>
    <div class="content">
      <div class="muted small">Attached automatically: ${esc(attached)}</div>
      <div class="field"><span>Type</span><div class="seg" id="is-type" role="group" style="display:grid">${ISSUE_TYPES.map((t) => `<button type="button" data-type="${t}" aria-pressed="${t === type}">${t}</button>`).join('')}</div></div>
      <label class="field"><span>What happened</span><textarea id="is-what" autofocus></textarea></label>
      <label class="field"><span>What I expected (optional)</span><textarea id="is-exp" style="min-height:60px"></textarea></label>
    </div>
    <footer><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="is-save">Save to Issues</button></footer>`);
  ov.querySelector('#is-type').onclick = (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    type = b.dataset.type;
    ov.querySelectorAll('#is-type button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  };
  ov.querySelector('#is-save').onclick = () => {
    const what = ov.querySelector('#is-what');
    const happened = what.value.trim();
    if (!happened) { what.focus(); what.placeholder = 'Please say what happened (required)'; what.style.borderColor = 'var(--danger)'; return; }
    store.addIssue({ id: uid('issue'), type, happened, expected: ov.querySelector('#is-exp').value.trim(), person: S.person, at: now.toISOString(), appVersion: S.pkg.version, where, view: S.view, mode: mode(), fileId: f?.id || '', fileName: f?.name || '', status: 'Open', notes: [], test: TEST_MODE ? 'Yes' : 'No' });
    closeModal();
    if (S.view === 'issues') render(); else { render(); toast('Saved to the Issues tab.'); }
  };
}

// ---------- Issues view ----------
function issuesView() {
  const I2 = S.issues;
  const all = store.issues();
  const list = all.filter((r) => (!I2.person || r.person === I2.person) && (!I2.status || r.status === I2.status)).slice().reverse();
  const tw = initialsOf('tw');
  const seg = (act, items, cur) => `<div class="seg" role="group">${items.map(([v, l]) => `<button data-act="${act}" data-val="${esc(v)}" aria-pressed="${cur === v}">${esc(l)}</button>`).join('')}</div>`;
  return `<div class="review">
    <div class="review-head"><div><h1>Issues</h1><p>Problems, ideas and comments from testing. In this preview they're saved in your browser only.</p></div>
      <div class="inline" style="margin-left:auto"><button class="btn warn" data-act="report">${I.chat} Report issue</button><button class="btn primary" data-act="export-issues" ${all.length ? '' : 'disabled title="No issues to export yet"'}>${I.download} Export issues</button></div></div>
    <div class="card howto"><h2>How to send your issues to ${esc(tw)}</h2><ol class="workflow">
      <li><span>Click <b>Export issues</b> (top right). A spreadsheet downloads, named like <code>TEST_issues_${today()}_v${esc(S.pkg.version)}.xlsx</code>. It's usually in your Downloads folder.</span></li>
      <li><span>Start a new email to ${esc(tw)} and attach that file.</span></li>
      <li><span>Use the subject <b>"File Sorter issues – your initials"</b> and send. The export always includes everything you've logged, so it's fine to send it more than once.</span></li>
    </ol></div>
    <div class="review-tools">
      <div class="tgroup"><label>Person</label>${seg('if-person', [['', 'All'], ...PEOPLE.map((p) => [p.id, p.initials])], I2.person)}</div>
      <div class="tgroup"><label>Status</label>${seg('if-status', [['', 'All'], ...ISSUE_STATUSES.map((x) => [x, x])], I2.status)}</div>
      <span class="muted" style="align-self:flex-end;padding-bottom:8px">${list.length} of ${all.length} issue${all.length === 1 ? '' : 's'}</span>
    </div>
    ${list.length ? list.map(issueCard).join('') : `<div class="card empty"><p class="muted">${all.length ? 'No issues match these filters.' : 'No issues yet. Use Report issue whenever something is odd, confusing, or could be better.'}</p></div>`}
  </div>`;
}

function issueCard(r) {
  const meta = [initialsOf(r.person), fmtDateTime(r.at), `v${r.appVersion}`, r.where, r.fileName].filter(Boolean).map(esc).join(' · ');
  return `<article class="card icard">
    <div class="ih"><span class="itype ${r.type}">${esc(r.type.toUpperCase())}</span><span class="muted">${meta}</span>
      <label class="istatus">Status <select class="inp" data-act-change="issue-status" data-id="${r.id}">${ISSUE_STATUSES.map((x) => `<option ${x === r.status ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label></div>
    <div class="ibody"><div><div class="ilabel">What happened</div><div>${esc(r.happened)}</div></div>
      <div><div class="ilabel">What I expected</div><div>${r.expected ? esc(r.expected) : '<span class="muted">—</span>'}</div></div></div>
    <div class="inotes"><div class="ilabel">Notes and comments</div>
      ${(r.notes || []).map((n) => `<div class="inote"><b>${esc(initialsOf(n.by))}</b><span>${esc(n.text)}</span><span class="muted small">${fmtDateTime(n.at)}</span></div>`).join('')}
      <form class="inote-add" data-issue="${r.id}"><input class="inp" name="note" placeholder="Add a note or comment" autocomplete="off" aria-label="Add a note or comment"><button class="btn">Add note</button></form>
    </div>
  </article>`;
}

function openNote() {
  if (S.practice) { toast("Notes aren't used in practice."); return; }
  const f = currentFile();
  if (!f) return;
  const opener = captureOpener();
  const anchor = $('[data-act="note"]')?.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'note-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-modal', 'true');
  pop.setAttribute('aria-label', `Note about ${f.name}`);
  pop.style.top = `${(anchor?.bottom || 120) + 8}px`;
  pop.style.left = `${Math.max(16, (anchor?.right || 400) - 360)}px`;
  pop.innerHTML = `<input id="note-input" maxlength="300" placeholder="Short note about ${esc(f.name)}" aria-label="Note">
    <div class="note-actions"><span class="muted"><span class="kc sm wide">Enter</span> save · <span class="kc sm">Esc</span> cancel</span>
    <button class="btn sm" data-n="cancel">Cancel</button><button class="btn sm primary" data-n="save">Save note</button></div>`;
  document.body.appendChild(pop);
  const inp = pop.querySelector('input');
  const done = () => closeModal();
  const save = () => {
    const text = inp.value.trim();
    if (text && !store.addNote(f.id, { text, by: S.person, byName: me().name, at: new Date().toISOString(), appVersion: S.pkg.version }).ok) { done(); showSaveError(); return; }
    done(); render(); if (text) toast('Note saved.');
  };
  S.modal = { el: pop, onClose: null, opener };
  inp.focus();
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.isComposing) return; // let IME composition finish
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    if (e.key === 'Enter') { e.preventDefault(); save(); }
  });
  pop.querySelector('[data-n="save"]').onclick = save;
  pop.querySelector('[data-n="cancel"]').onclick = done;
  // Clicking elsewhere keeps the draft open (it's never silently thrown away).
}

// The one selection rule for a folder decision. The preview and the apply step both call this,
// so what the modal promises is exactly what gets written. Excluded folders never reach S.allFiles
// (they are dropped when the inventory loads), so they cannot appear here.
function folderBatch(p) {
  const inFolder = (x) => x.copies.some((c) => (pathParts(c.path).join('/')).startsWith(p + '/'));
  const inScope = new Set(S.files.map((x) => x.id));
  const included = [];
  const excludedFiles = [];
  for (const x of S.allFiles) {
    if (!inFolder(x)) continue;
    if (!inScope.has(x.id)) excludedFiles.push({ file: x, reason: 'outside the test scope' });
    else if (decisionsById()[x.id]) excludedFiles.push({ file: x, reason: 'already decided' });
    else if (store.claimedByOther(x.id, S.person, setting('claimIdleMinutes'))) excludedFiles.push({ file: x, reason: 'claimed by another person' });
    else included.push(x);
  }
  return { included, excluded: excludedFiles };
}

function openFolderDecision() {
  if (S.practice) return;
  const f = currentFile();
  if (!f) return;
  // Every folder level (below the library) that holds a copy of this file.
  const levels = [];
  for (const c of f.copies) {
    const parts = pathParts(c.path).slice(0, -1);
    for (let i = parts.length; i >= 1; i--) { const p = parts.slice(0, i).join('/'); if (!levels.includes(p)) levels.push(p); }
  }
  const pick = f.suggestion?.folder || approved()[0];
  const ov = openModal(`${modalHead('Sort this whole folder')}
    <div class="content">
      <p class="muted" style="margin:0">One decision sends every unsorted file in the folder (and its subfolders) to one top-level folder. Files with copies elsewhere still get one decision each, and every row is marked “folder decision” so it can be spot-checked. You can undo it with <span class="kc sm">0</span>.</p>
      <label class="field"><span>Folder</span><select id="fd-path">${levels.map((l) => `<option value="${esc(l)}">${esc(l.replace(/\//g, ' › '))}</option>`).join('')}</select></label>
      <div class="attached" id="fd-info"></div>
      <label class="field"><span>Send them all to</span><select id="fd-dest">${approved().map((o) => `<option ${o === pick ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
    </div>
    <footer><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" id="fd-go">Send files</button></footer>`, { wide: true });
  const plural = (n) => `file${n === 1 ? '' : 's'}`;
  // Show the copy that sits under the chosen folder (falls back to the first copy).
  const where = (x, p) => esc(folderCrumb((x.copies.find((c) => pathParts(c.path).join('/').startsWith(p + '/')) || x.copies[0]).path));
  const row = (x, extra) => `<li><span class="fd-name">${esc(x.name)}</span><span class="fd-path muted">${where(x, ov.querySelector('#fd-path').value)}${x.copies.length > 1 ? ` · ${x.copies.length} copies` : ''}</span>${extra ? `<span class="fd-why">${esc(extra)}</span>` : ''}</li>`;
  const update = () => {
    const p = ov.querySelector('#fd-path').value;
    const dest = ov.querySelector('#fd-dest').value;
    const { included: list, excluded: skipped } = folderBatch(p);
    const reasons = {};
    for (const e of skipped) reasons[e.reason] = (reasons[e.reason] || 0) + 1;
    const why = Object.entries(reasons).map(([r, n]) => `${n} ${r}`).join(', ');
    const shown = list.slice(0, 200);
    ov.querySelector('#fd-info').innerHTML = `<div><b>${list.length} ${plural(list.length)} will go to ${dest ? esc(dest) : 'the folder you choose'}.</b>${skipped.length ? ` ${skipped.length} ${plural(skipped.length)} ${skipped.length === 1 ? 'is' : 'are'} excluded (${esc(why)}).` : ''}</div>
      ${list.length ? `<ul class="fd-list" aria-label="Files that will be sent">${shown.map((x) => row(x)).join('')}${list.length > shown.length ? `<li class="fd-more muted">…and ${list.length - shown.length} more</li>` : ''}</ul>` : ''}
      ${skipped.length ? `<details class="fd-ex"${ov.querySelector('#fd-info details')?.open ? ' open' : ''}><summary>Excluded (${skipped.length})</summary><ul class="fd-list">${skipped.slice(0, 200).map((e) => row(e.file, e.reason)).join('')}${skipped.length > 200 ? `<li class="fd-more muted">…and ${skipped.length - 200} more</li>` : ''}</ul></details>` : ''}`;
    ov.querySelector('#fd-go').textContent = `Send ${list.length} ${plural(list.length)}${dest ? ` to ${dest}` : ''}`;
    ov.querySelector('#fd-go').disabled = !list.length || !dest;
  };
  ov.querySelector('#fd-path').onchange = update;
  ov.querySelector('#fd-dest').onchange = update;
  update();
  ov.querySelector('#fd-go').onclick = () => {
    const p = ov.querySelector('#fd-path').value;
    const dest = ov.querySelector('#fd-dest').value;
    const list = folderBatch(p).included;
    if (!list.length) { update(); toast('No unsorted files left in that folder.'); return; }
    const batchId = uid('folder');
    const at = new Date().toISOString();
    const seconds = Math.round(((Date.now() - S.shownAt) / 1000 / list.length) * 10) / 10;
    const rows = list.map((x) => ({ ...baseRow(x, dest), decidedAt: at, decisionType: 'folder decision', folderDecisionPath: p, batchId, seconds }));
    if (!store.saveDecisions(rows).ok) { closeModal(); showSaveError(); return; }
    store.setKeypad(S.person, recordUse(keypadState(), dest, setting('keypadLearningFiles'))); // one choice, counted once
    S.confirm = { tone: 'ok', text: `Folder decision: ${rows.length} files from ${p.replace(/\//g, ' › ')} → ${dest}.` };
    closeModal();
    showFile(available()[0] || null);
    render();
    announce(`Sent ${rows.length} file${rows.length === 1 ? '' : 's'} to ${dest}.`);
  };
}

async function openRules() {
  const md = await fetch('sorting-rules.md', { cache: 'no-store' }).then((r) => r.text()).catch(() => 'Could not load the rulebook.');
  openModal(`${modalHead('Sorting rules')}<div class="content rules-md">${miniMarkdown(md)}</div><footer><span class="muted small" style="margin-right:auto">Edit <code>sorting-rules.md</code> to change these. In phase 4, Claude will get this rulebook with every suggestion.</span><button class="btn" data-act="close-modal">Close</button></footer>`, { wide: true });
}
function miniMarkdown(md) {
  const out = [];
  let inList = false;
  for (const raw of md.split('\n')) {
    const line = esc(raw).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    const li = /^\s*[-*] (.*)/.exec(line);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${li[1]}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    const h = /^(#{1,3}) (.*)/.exec(line);
    if (h) out.push(`<h${h[1].length}>${h[2]}</h${h[1].length}>`);
    else if (line.trim() && !line.startsWith('&lt;!--')) out.push(`<p>${line}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function openAbout() {
  openModal(`${modalHead('About File Sorter')}<div class="content">
    <div><b>Version ${esc(S.pkg.version)}</b> · released ${esc(S.pkg.releaseDate || '')}</div>
    <div class="attached">Test mode is on. Decisions go to test storage (${esc(store.label)}). The app never moves, renames or deletes any file. Data: ${esc(S.dataSource)}.</div>
    <div><b>What's new</b><ul>${(S.pkg.whatsNew || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>
  </div><footer><button class="btn" data-act="close-modal">Close</button></footer>`);
}

function openSettings() {
  const admin = isAdmin();
  const st = store.settings();
  const ks = keypadState();
  const folderOpts = ['', ...approved()];
  const subs = setting('scopeFolder') ? Object.keys(subfoldersOf(S.allFiles, setting('scopeFolder'))).sort() : [];
  const people = PEOPLE.map((p) => ({ p, s: speedStats((d) => d.decidedBy === p.id), sm: speedStats((d) => d.decidedBy === p.id && d.mode === 'suggestion'), kp: speedStats((d) => d.decidedBy === p.id && d.mode === 'keypad') }));
  const ov = openModal(`${modalHead('Settings')}<div class="content">
    <div class="settings-sec"><h3>Test Mode <span class="locked-pill">ON · locked for this version</span></h3>
      <div class="muted">Decisions, notes, claims and issues go to test storage only. The app asks Microsoft only for read access to files. ${TEST_MODE_LOCKED ? 'Going live is a later version: only TW can switch it, and the live write steps are not built yet.' : ''}</div></div>
    <div class="settings-sec"><h3>Test scope</h3>
      <div class="inline"><label class="field"><span>Top-level folder</span><select id="sc-folder" ${admin ? '' : 'disabled'}>${folderOpts.map((o) => `<option value="${esc(o)}" ${o === (setting('scopeFolder') || '') ? 'selected' : ''}>${o ? esc(o) : 'All folders'}</option>`).join('')}</select></label>
      <label class="field"><span>Subfolder</span><select id="sc-sub" ${admin ? '' : 'disabled'}><option value="">All subfolders</option>${subs.map((o) => `<option ${o === setting('scopeSubfolder') ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></label>
      <label class="field"><span>First N files</span><input id="sc-n" type="number" min="1" value="${setting('scopeFirstN')}" style="width:110px" ${admin ? '' : 'disabled'}></label></div>
      <small class="muted">${S.files.length} file(s) in scope out of ${S.allFiles.length}. ${admin ? '' : 'Only TW can change the scope.'}</small></div>
    <div class="settings-sec"><h3>My keypad numbers</h3>
      <div class="muted">${ks.locked ? 'Your numbers are locked.' : `Learning: ${ks.sorted} of ${setting('keypadLearningFiles')} files sorted.`} Home numbers: ${Object.entries(ks.homes).sort((a, b) => a[1] - b[1]).map(([f, n]) => `${n} ${esc(f)}`).join(' · ') || 'none yet'}</div>
      <div class="inline"><button class="btn sm" id="kp-reset">Reset my numbers</button>${admin ? `<label class="inline small">Learning period <input id="kp-n" type="number" min="5" value="${setting('keypadLearningFiles')}" style="width:80px" class="inp"> files</label>` : ''}</div></div>
    ${admin ? `
    <div class="settings-sec"><h3>Approved destination folders (${approved().length})</h3>
      <textarea id="ap-list" class="inp" rows="7" style="width:100%">${esc(approved().join('\n'))}</textarea>
      <small class="muted">One per line. Only these can ever be chosen.</small>
      ${Object.keys(S.unapproved).length ? `<div class="attached"><b>Top-level folders not on the list</b> (their files are sorted like any other; the folder is never a choice): ${Object.entries(S.unapproved).map(([k, v]) => `${esc(k)} (${v})`).join(', ')}</div>` : ''}
      <label class="field"><span>Excluded folders</span><input id="ex-list" value="${esc(excluded().join(', '))}"><small>Comma-separated. Their files are never shown, counted or planned.</small></label></div>
    <div class="settings-sec"><h3>Claude API cost cap (phase 4)</h3>
      <div class="inline">Stop pre-computing suggestions after $<input id="cap" type="number" min="0" value="${setting('claudeCostCapUsd')}" style="width:90px" class="inp"> · running cost so far: <b>$${(st.claudeSpendUsd || 0).toFixed(2)}</b></div></div>
    <div class="settings-sec"><h3>Speed by person and mode</h3>
      <table class="mini"><tr><th>Person</th><th>Files</th><th>Avg</th><th>Suggestion</th><th>Keypad</th></tr>${people.map(({ p, s, sm, kp }) => `<tr><td>${esc(p.name)}</td><td>${s.n}</td><td>${s.n ? s.avg.toFixed(1) + 's' : '—'}</td><td>${sm.n ? `${sm.avg.toFixed(1)}s (${sm.n})` : '—'}</td><td>${kp.n ? `${kp.avg.toFixed(1)}s (${kp.n})` : '—'}</td></tr>`).join('')}</table></div>
    <div class="settings-sec"><h3>Backups and reset</h3>
      <div class="muted">The first copy of each day is kept as that day's backup (last ${14} days) and is never overwritten. The latest end-of-session copy is kept separately. Click one to download it.</div>
      ${(() => { const b = store.listBackups(); return `<div class="inline">${b.daily.slice(0, 7).map((d) => `<button class="btn sm" data-backup="daily" data-id="${d}">${d}</button>`).join('') || '<span class="muted">No daily backups yet.</span>'}
        ${b.session ? '<button class="btn sm" data-backup="session" data-id="session">Latest session</button>' : ''}</div>
        ${b.reset.length ? `<div class="inline small muted">Before reset: ${b.reset.map((r) => `<button class="btn sm" data-backup="reset" data-id="${esc(r)}">${esc(r.slice(0, 16).replace('T', ' '))}</button>`).join('')}</div>` : ''}`; })()}
      <div><button class="btn sm danger" id="reset-test">Reset test data…</button></div></div>` : '<div class="muted small">Folder lists, cost cap, speed by person, backups and reset are admin settings (TW).</div>'}
  </div><footer><button class="btn" data-act="close-modal">Close</button>${admin ? '<button class="btn primary" id="set-save">Save settings</button>' : ''}</footer>`, { wide: true });

  ov.querySelector('#kp-reset').onclick = () => {
    if (!confirm('Reset your keypad numbers? The learning period starts again.')) return;
    store.setKeypad(S.person, resetNumbers()); closeModal(); render(); toast('Keypad numbers reset.');
  };
  ov.querySelector('#sc-folder').onchange = (e) => { const sub = ov.querySelector('#sc-sub'); sub.innerHTML = '<option value="">All subfolders</option>' + Object.keys(subfoldersOf(S.allFiles, e.target.value)).sort().map((o) => `<option>${esc(o)}</option>`).join(''); };
  if (!admin) return;
  ov.querySelectorAll('[data-backup]').forEach((b) => (b.onclick = () => {
    const backup = store.readBackup(b.dataset.backup, b.dataset.id);
    if (!backup) return toast('That backup could not be read.');
    const label = b.dataset.backup === 'daily' ? b.dataset.id : b.dataset.backup === 'session' ? 'session' : `before-reset_${b.dataset.id.slice(0, 10)}`;
    exportBackup({ date: label, backup, files: S.allFiles, notesById: store.db.notes, version: S.pkg.version, person: me().name }); // all files, not just the scope
  }));
  ov.querySelector('#reset-test').onclick = () => {
    if (!confirm('Reset test data? This clears all TEST decisions, notes, claims and issues for everyone. A backup is saved first.')) return;
    const res = store.resetTestData();
    if (!res.ok) { alert(res.reason); return; }
    closeModal(); S.confirm = null; showFile(null); render(); toast('Test data reset. A full backup was saved first (Settings → Backups).');
  };
  ov.querySelector('#set-save').onclick = async () => {
    const list = ov.querySelector('#ap-list').value.split('\n').map((x) => x.trim()).filter(Boolean);
    store.setSettings({
      scopeFolder: ov.querySelector('#sc-folder').value, scopeSubfolder: ov.querySelector('#sc-sub').value,
      scopeFirstN: Math.max(1, +ov.querySelector('#sc-n').value || DEFAULTS.scopeFirstN),
      keypadLearningFiles: Math.max(5, +ov.querySelector('#kp-n').value || DEFAULTS.keypadLearningFiles),
      approvedFolders: list.length ? list : APPROVED_FOLDERS,
      excludedFolders: ov.querySelector('#ex-list').value.split(',').map((x) => x.trim()).filter(Boolean),
      claudeCostCapUsd: Math.max(0, +ov.querySelector('#cap').value || 0),
    });
    await reloadInventory();
    closeModal(); showFile(available()[0] || null); render(); toast('Settings saved.');
  };
}

// ---------- Menus ----------
let menuOpener = null; // the control that opened the open menu (keyboard use only)
function openMenu(anchorEl, html, label) {
  if ($('#menu')?.dataset.for === anchorEl.dataset.act) { closeMenu(); return; } // the button toggles its menu
  closeMenu();
  menuOpener = captureOpener();
  const r = anchorEl.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu'; m.id = 'menu';
  m.dataset.for = anchorEl.dataset.act;
  m.setAttribute('role', 'menu');
  if (label) m.setAttribute('aria-label', label);
  m.innerHTML = html;
  m.querySelectorAll('button').forEach((b) => b.setAttribute('role', 'menuitem'));
  m.querySelectorAll('.sep').forEach((x) => x.setAttribute('role', 'separator'));
  m.style.top = `${r.bottom + 6}px`;
  m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.appendChild(m);
  syncExpanded();
  if (menuOpener) m.querySelector('button')?.focus(); // keyboard users land on the first item
  setTimeout(() => document.addEventListener('mousedown', outsideMenu), 0);
}
function outsideMenu(e) {
  const m = $('#menu');
  if (m && !e.target.closest('#menu') && !e.target.closest(`[data-act="${m.dataset.for}"]`)) closeMenu();
}
function closeMenu() {
  const m = $('#menu');
  if (!m) return;
  m.remove();
  document.removeEventListener('mousedown', outsideMenu);
  syncExpanded();
  if (menuOpener) { menuReturn = { op: menuOpener, at: Date.now() }; restoreFocus(menuOpener, FOCUS_FALLBACK); menuOpener = null; }
}
/** aria-expanded on the buttons that open menus. Called after every redraw too, since the top bar is rebuilt. */
function syncExpanded() {
  const open = $('#menu')?.dataset.for;
  document.querySelectorAll('[data-act="help-menu"], [data-act="profile-menu"]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.act === open)));
}

/** Role line shown under a profile's initials, from the PEOPLE flags. */
const roleOf = (p) => (p.admin ? (p.reviewer ? 'Admin · reviewer' : 'Admin') : p.reviewer ? 'Reviewer' : 'Sorter');

function profileMenu(el) {
  openMenu(el, `${PEOPLE.map((p) => `<button data-act="set-person" data-val="${p.id}">${avatar(p, 'sm')} <span class="role">${esc(roleOf(p))}</span>${p.id === S.person ? `<span class="check">${I.check.replace('<svg', '<svg width="16" height="16"')}</span>` : ''}</button>`).join('')}
    <div class="sep"></div><div class="note">Beta: pick your name. After the beta, your Microsoft sign-in sets this automatically.</div>`, 'Profile');
}
function helpMenu(el) {
  openMenu(el, `<button data-act="tour">Show me around</button><button data-act="intro">Show intro</button><button data-act="rules">Sorting rules</button><button data-act="thumb-help">Thumbnails not showing?</button><button data-act="settings">${isAdmin() ? 'Settings (admin)' : 'Settings'}</button><div class="sep"></div><button data-act="about">About · v${esc(S.pkg.version)}</button>`, 'Help');
}

function setPerson(id) {
  S.practice = null;
  if (S.person && S.person !== id) store.releaseClaims(S.person);
  S.person = id;
  localStorage.setItem(DEVICE_PERSON_KEY, id);
  applyTheme();
  showFile(available()[0] || null);
  render();
}

function applyTheme() {
  const t = prefs().theme || 'light'; // light unless the person chose dark
  document.documentElement.dataset.theme = t;
}

let toastTimer;
function toast(text) {
  $('.toast')?.remove();
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = text; t.setAttribute('role', 'status');
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 3200);
}

/** First launch: choose a profile before anything else. The tour starts after. */
function openProfilePicker() {
  const ov = openModal(`<header><h2>Choose your profile</h2></header>
    <div class="content">
      <p style="margin:0">Every decision is saved under your initials, the file you have open is held for you, and your keypad numbers are your own. So this comes first.</p>
      <div class="profiles">${PEOPLE.map((p) => `<button data-pick="${p.id}"><span class="avatar lg" style="background:${p.color}">${esc(p.initials)}</span><span class="role">${esc(roleOf(p))}</span></button>`).join('')}</div>
      <div class="muted small">After the beta, your Microsoft sign-in sets this automatically.</div>
    </div>`, { locked: true });
  ov.querySelector('.profiles').onclick = (e) => {
    const b = e.target.closest('[data-pick]');
    if (!b) return;
    closeModal();
    setPerson(b.dataset.pick);
    if (!seenIntro()) openIntro();
  };
}

/** The short first-run intro. Seen once per person (prefs.introSeen); the ? menu can show it again. */
function openIntro() {
  endPractice(true);
  S.view = 'sort';
  if (!currentFile()) S.source = 'remaining';
  render();
  startIntro({
    opener: takeMenuReturn() || captureOpener(), initials: me()?.initials || '', folderCount: approved().length,
    finish: (how) => {
      if (S.person) store.setPrefs(S.person, { introSeen: true });
      if (how === 'practice') startPractice();
      else if (how === 'tour') openTour(0);
      else render();
    },
  });
}

function openTour(startAt = 0) {
  endPractice(true);
  S.view = 'sort';
  if (!currentFile()) S.source = 'remaining';
  render();
  startTour({
    opener: takeMenuReturn() || captureOpener(), startAt, version: S.pkg.version, propertyName: PROPERTY.name,
    finish: (how) => { if (S.person) store.setPrefs(S.person, { tourDone: how }); render(); },
  });
}

// ---------- Events ----------
const actions = {
  view: (d) => { endPractice(true); S.view = d.val; S.confirm = null; render(); },
  source: (d) => { endPractice(true); S.source = d.val; S.confirm = null; showFile(available()[0] || null); render(); },
  mode: (d) => {
    store.setPrefs(S.person, { mode: d.val }); render();
    if (d.val === 'keypad' && !prefs().keypadTipSeen) { store.setPrefs(S.person, { keypadTipSeen: true }); maybeKeypadTip(setting('keypadLearningFiles')); }
  },
  pick: (d) => decide(d.folder),
  'all-folders': () => toggleAllFolders(),
  undo: () => undo(),
  keep: (d) => { S.manualKept[S.currentId] = d.path; render(); },
  'kept-auto': () => { delete S.manualKept[S.currentId]; render(); },
  note: () => openNote(),
  'folder-decision': () => openFolderDecision(),
  jump: (d) => {
    const f = S.fileById[d.id];
    if (!f || !S.files.includes(f)) return toast('That file is outside the current test scope.');
    const dec = decisionsById()[f.id];
    if (dec && dec.folder !== 'Unsure') return toast(`${f.name} was already sorted into ${dec.folder}.`);
    S.source = dec ? 'unsure' : 'remaining'; showFile(f); render();
  },
  report: () => openReport(),
  'thumb-help': () => { closeMenu(); openThumbHelp(); },
  'export-issues': () => exportIssues({ issues: store.issues(), version: S.pkg.version, person: me()?.initials || '', initialsOf }),
  'if-person': (d) => { S.issues.person = d.val; render(); },
  'if-status': (d) => { S.issues.status = d.val; render(); },
  export: () => exportDecisions({ files: S.files, decisionsById: decisionsById(), notesById: store.db.notes, version: S.pkg.version, person: me()?.name || '' }),
  'export-plan': (d) => {
    const P = S.plan || planState();
    const approved = d.kind === 'approved' && P.approval;
    exportChangePlan({ actions: P.actions, issues: P.issues, approval: approved ? P.approval : null, fingerprint: P.fingerprint, inventoryId: S.inventoryId,
      dataMeta: S.dataMeta, scope: scopeText(), holdDays: setting('holdDays'), version: S.pkg.version, person: me()?.name || '', peopleById });
  },
  'approve-plan': () => {
    const P = planState();
    if (!me()?.reviewer) return toast('Only TW or KB can approve the plan.');
    if (!P.canApprove) return toast('Every check must pass before the plan can be approved.');
    if (!confirm(`Approve this plan? ${P.decisions.length} decisions, ${P.actions.length} planned actions. If anything changes afterwards, it will need approving again.`)) return;
    const res = store.approvePlan({ id: uid('approval'), by: S.person, byName: me().name, at: new Date().toISOString(), fingerprint: P.fingerprint,
      decisions: P.decisions.length, actions: P.actions.length, scope: scopeText(), inventoryId: S.inventoryId, appVersion: S.pkg.version });
    if (!res.ok) return showSaveError();
    render(); toast('Plan approved. You can now export the approved plan.');
  },
  theme: () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    if (S.person) store.setPrefs(S.person, { theme: t });
    render();
  },
  'profile-menu': (d, el) => (S.person ? profileMenu(el) : openProfilePicker()),
  'help-menu': (d, el) => helpMenu(el),
  'set-person': (d) => {
    closeMenu(); setPerson(d.val);
    if (!seenIntro()) openIntro();
  },
  tour: () => { closeMenu(); openTour(0); },
  intro: () => { closeMenu(); openIntro(); },
  'practice-done': () => endPractice(),
  rules: () => { closeMenu(); openRules(); },
  settings: () => { closeMenu(); openSettings(); },
  about: () => { closeMenu(); openAbout(); },
  'close-modal': () => closeModal(),
  'review-tab': (d) => { S.review.tab = d.val; render(); },
  'rf-folder': (d) => { S.review.folder = d.val; S.review.page = 1; render(); },
  'rv-queue': (d) => { S.review.queue = d.val; S.review.page = 1; render(); },
  'rv-page': (d, el, e) => {
    const R = S.review;
    R.page += d.val === 'next' ? 1 : -1; // reviewResults() keeps it within range
    const which = [...document.querySelectorAll('#rv-results .pager')].indexOf(el.closest('.pager')); // top or bottom pager
    $('#rv-results').innerHTML = reviewResults(planState());
    const head = $('#rv-results .list-head');
    if (head) window.scrollTo({ top: Math.max(0, head.getBoundingClientRect().top + window.scrollY - 90) });
    const info = $('#rv-results .pg-info')?.textContent;
    if (info) announce(info);
    // Operated from the keyboard: the pager was redrawn, so put focus back on the same button (or its neighbour at either end).
    if (e && e.detail === 0) {
      const pagers = document.querySelectorAll('#rv-results .pager');
      const nav = pagers[Math.min(Math.max(which, 0), pagers.length - 1)];
      (nav?.querySelector(`[data-val="${d.val}"]:not(:disabled)`) || nav?.querySelector('button:not(:disabled)'))?.focus({ preventScroll: true });
    }
  },
  'goto-approval': () => {
    const card = $('.approval');
    card?.scrollIntoView({ block: 'center' });
    ($('.approval [data-act="approve-plan"]:not([disabled])') || $('.approval [data-act="export-plan"][data-kind="approved"]'))?.focus({ preventScroll: true });
  },
  'mark-reviewed': (d) => {
    if (!me()?.reviewer) return toast('Only TW or KB can mark decisions reviewed.');
    const cur = decisionsById()[d.id];
    if (!cur) return;
    if (cur.reviewedBy) store.editDecision(d.id, { reviewedBy: '', reviewedByName: '', reviewedAt: '' });
    else store.editDecision(d.id, { reviewedBy: S.person, reviewedByName: me().name, reviewedAt: new Date().toISOString() });
    renderKeepScroll();
  },
  'toggle-shortcuts': () => { if (S.person) { store.setPrefs(S.person, { shortcutsOff: !prefs().shortcutsOff }); render(); } },
  'tree-toggle': (d, el, e) => {
    const key = d.key, o = S.review.open;
    const depth0 = d.depth === '0';
    const isOpen = o.has(key) || (depth0 && !o.has('x:' + key));
    if (isOpen) { o.delete(key); if (depth0) o.add('x:' + key); } else { o.add(key); o.delete('x:' + key); }
    render();
    // Operated from the keyboard (click with detail 0): the row was redrawn, so put focus back on it.
    if (e && e.detail === 0) [...document.querySelectorAll('.trow[data-key]')].find((r) => r.dataset.key === key)?.focus({ preventScroll: true });
  },
};

const changeActions = {
  'issue-status': (el) => { store.updateIssue(el.dataset.id, { status: el.value, statusBy: S.person, statusAt: new Date().toISOString() }); render(); },
  'rf-person': (el) => { S.review.person = el.value; S.review.page = 1; render(); },
  'rf-type': (el) => { S.review.type = el.value; S.review.page = 1; render(); },
  'rf-changed': (el) => { S.review.changed = el.checked; S.review.page = 1; render(); },
  'edit-folder': (el) => {
    const id = el.dataset.id;
    const f = S.fileById[id];
    const folder = el.value;
    const cur = decisionsById()[id];
    const kept = folder === 'Unsure' ? null : (cur.keptManual ? decisionKept(f, cur).copy : keptCopy(f, folder).copy);
    store.editDecision(id, { folder, accepted: !!f.suggestion && folder === f.suggestion.folder, keptPath: kept?.path || null, keptSize: kept?.size ?? null, keptModified: kept?.modified || null,
      editedBy: me().name, editedAt: new Date().toISOString(), reviewedBy: '', reviewedByName: '', reviewedAt: '' });
    toast(`${f.name} → ${folder} (edited in review by ${me().name}).`);
    renderKeepScroll(); // same page of the list, same scroll position
  },
};

function toggleAllFolders(force) {
  S.allFoldersOpen = force ?? !S.allFoldersOpen;
  S.folderFilter = ''; S.folderHl = 0;
  render();
}

function bindGlobalEvents() {
  initA11y();
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    fn(el.dataset, el, e);
    // After a mouse click, don't leave focus on the control, so Enter goes back to sorting.
    if (e.detail > 0 && el.isConnected && document.activeElement === el) el.blur();
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('.inote-add');
    if (!form) return;
    e.preventDefault();
    const text = form.note.value.trim();
    if (!text || !S.person) return;
    store.addIssueNote(form.dataset.issue, { by: S.person, at: new Date().toISOString(), text, appVersion: S.pkg.version });
    render();
  });
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act-change]');
    if (el) changeActions[el.dataset.actChange]?.(el);
  });
  document.addEventListener('input', (e) => {
    if (e.target.id === 'folder-filter') {
      S.folderFilter = e.target.value; S.folderHl = 0;
      $('#folder-list').innerHTML = folderListItems();
    }
    if (e.target.dataset.actInput === 'tree-q') debounceSearch('tree', e.target.value);
    if (e.target.dataset.actInput === 'rv-q') debounceSearch('list', e.target.value);
  });
  document.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('[data-act-toggle]');
    if (d && S.person && !!prefs()[d.dataset.actToggle] !== d.open) store.setPrefs(S.person, { [d.dataset.actToggle]: d.open });
    if (d && document.activeElement?.tagName === 'SUMMARY' && !d.matches(':focus-visible')) document.activeElement.blur();
  }, true);
  document.addEventListener('focusin', renderStatus);
  document.addEventListener('focusout', () => setTimeout(renderStatus, 0));
  document.addEventListener('keydown', onKey);
  // Tab stays inside an open dialog. Capture phase, so the note box (which stops its own keys) is covered too.
  document.addEventListener('keydown', (e) => { if (S.modal && !tourActive()) trapTab(e, S.modal.el); }, true);
  // Closing the tab releases this person's hold and keeps an end-of-session copy. Neither rewrites decisions.
  window.addEventListener('beforeunload', () => { if (S.person) store.releaseClaims(S.person); store.backupSession(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.backupSession(); });
  // Activity keeps the hold on the file on screen; it's released after the idle time with no activity.
  const touch = () => { if (S.view === 'sort' && S.person && S.currentId && !S.practice) store.touchClaim(S.currentId, S.person); };
  document.addEventListener('keydown', touch, true);
  document.addEventListener('pointerdown', touch, true);
  document.addEventListener('focusout', () => setTimeout(() => { if (S.redrawLater && !S.modal) { S.redrawLater = false; render(); } }, 0));
}

/** The number pad works with NumLock on or off, and on any keyboard layout. */
const NUMPAD = { Numpad0: '0', Numpad1: '1', Numpad2: '2', Numpad3: '3', Numpad4: '4', Numpad5: '5', Numpad6: '6', Numpad7: '7', Numpad8: '8', Numpad9: '9', NumpadDecimal: '.', NumpadComma: '.', NumpadDivide: '/', NumpadEnter: 'Enter' };

function onKey(e) {
  if (tourActive()) return; // the tour handles its own keys
  if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
  const a = document.activeElement;
  const typing = a && (a.matches('input, textarea, select') || a.isContentEditable);

  if (S.modal) { if (e.key === 'Escape' && !S.modal.locked) { e.preventDefault(); closeModal(); } return; }
  const menu = $('#menu');
  if (menu) {
    const items = [...menu.querySelectorAll('button')], i = items.indexOf(a);
    if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); closeMenu(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && items.length) {
      e.preventDefault();
      const to = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      items[to].focus();
    }
    return;
  }
  // Review tree rows are role=button: Enter or Space opens and closes them.
  if (a && a.matches('.trow[data-act]') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); if (!e.repeat) a.click(); return; }

  // Folder filter box: arrows move, Enter picks, Esc closes.
  if (a && a.id === 'folder-filter') {
    const list = filteredFolders();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.folderHl = Math.max(0, Math.min(list.length - 1, S.folderHl + (e.key === 'ArrowDown' ? 1 : -1)));
      $('#folder-list').innerHTML = folderListItems();
      $('#folder-list .hl')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); if (list[S.folderHl]) decide(list[S.folderHl]); }
    else if (e.key === 'Escape') { e.preventDefault(); toggleAllFolders(false); }
    return;
  }
  if (typing) return; // keyboard shortcuts pause while typing
  if (S.view !== 'sort' || !S.person || prefs().shortcutsOff) return;
  const key = NUMPAD[e.code] || e.key;
  // A focused button or link keeps its own Enter/Space behaviour: never turn it into "accept the suggestion".
  if ((key === 'Enter' || key === ' ') && a && a !== document.body && a.matches('button, a, summary, [tabindex]:not([tabindex="-1"])')) return;
  const shortcut = key === 'Enter' || key === '/' || key === '.' || key === 'n' || key === 'N' || /^[0-9]$/.test(key);
  if (S.practice) {
    if (key === 'Escape' && !S.allFoldersOpen) { e.preventDefault(); endPractice(); return; }
    if (S.practice.done && shortcut) { // after the pick: only Enter does anything (Start sorting), and not within 400 ms of the pick
      e.preventDefault();
      if (key === 'Enter' && !e.repeat && Date.now() - S.practice.doneAt >= 400) endPractice();
      return;
    }
  }
  if (!shortcut) { if (key === 'Escape' && S.allFoldersOpen) toggleAllFolders(false); return; }
  e.preventDefault();
  if (e.repeat) return; // holding a key down never sorts (or undoes) a run of files
  const f = currentFile();
  if (key === '0') { undo(); return; }
  if (!f) return;
  if (key === 'Enter') { if (f.suggestion) decide(f.suggestion.folder); return; }
  if (key === '/') { toggleAllFolders(true); return; }
  if (key === '.') { if (S.source !== 'unsure' || S.practice) decide('Unsure'); return; }
  if (key === 'n' || key === 'N') { openNote(); return; }
  const n = +key;
  if (mode() === 'keypad') { const slot = keypadLayout(f).keys[n]; if (slot) decide(slot.folder); }
  else { const alt = f.suggestion?.alts?.[n - 1]; if (alt && n <= 2) decide(alt); }
}

boot().catch((err) => {
  console.error(err);
  $('#app').innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>File Sorter could not start</h2><pre>${esc(err.stack || err)}</pre></div>`;
});

// Exposed for the tutorial and debugging.
window.__jpcfs = { S, get store() { return store; }, render };
