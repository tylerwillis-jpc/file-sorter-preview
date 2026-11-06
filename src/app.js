/* JPC File Sorter · v0.2.1-beta · app.js
 * The app shell: top bar, toolbar, Sort and Review views, keyboard, modals.
 * The app never moves, renames or deletes files. It only records decisions.
 */
import { APPROVED_FOLDERS, COMMON_FOLDERS, DEFAULTS, EXCLUDED_FOLDERS, PEOPLE, PROPERTY, TEST_MODE, TEST_MODE_LOCKED } from './config.js';
import { applyScope, loadInventory, subfoldersOf } from './data.js';
import { exportBackup, exportChangePlan, exportDecisions, exportIssues } from './exporter.js';
import { I } from './icons.js';
import { assignKeys, candidateFolders, emptyKeypadState, recordUse, resetNumbers, unrecordUse } from './keypad.js';
import { buildPlan, buildTrees, conflictChecks, countFiles, keptCopy, planForDecision, planSummary } from './plan.js';
import { Store } from './store.js';
import { maybeKeypadTip, startTour, tourActive } from './tutorial.js';
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
  review: { tab: 'changes', folder: 'all', person: '', changed: false, unreviewed: false, type: '', open: new Set(), query: '' },
  kbdPaused: false,
  modal: null,
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

// ---------- Boot ----------
async function boot() {
  S.pkg = await fetch('package.json', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({ version: 'unknown' }));
  store = await new Store().init();
  store.on(() => renderStatus());
  S.person = localStorage.getItem(DEVICE_PERSON_KEY) || null;
  if (S.person && !peopleById[S.person]) S.person = null;
  await reloadInventory();
  applyTheme();
  store.backupIfDue();
  render();
  bindGlobalEvents();
  if (!S.person || !prefs().tourDone) openTour();
}

async function reloadInventory() {
  const inv = await loadInventory({ approved: approved(), excluded: excluded() });
  S.allFiles = inv.files; S.unapproved = inv.unapproved; S.dataSource = inv.source;
  S.files = applyScope(S.allFiles, { scopeFolder: setting('scopeFolder'), scopeSubfolder: setting('scopeSubfolder'), scopeFirstN: setting('scopeFirstN') });
  S.fileById = Object.fromEntries(S.allFiles.map((f) => [f.id, f]));
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

// Preview buffer: keep the next N files' thumbnails and suggestions ready.
const previewCache = new Map();
function preload() {
  const q = available();
  const start = Math.max(0, q.findIndex((f) => f.id === S.currentId));
  for (const f of q.slice(start, start + 1 + setting('preloadCount'))) {
    if (!previewCache.has(f.id)) previewCache.set(f.id, { kind: f.size > setting('largeFileBytes') ? 'placeholder' : typeKind(f.type), ready: true });
  }
}
const preloadedAhead = () => {
  const q = available();
  const i = q.findIndex((f) => f.id === S.currentId);
  return q.slice(i + 1).filter((f) => previewCache.get(f.id)?.ready).length;
};

// ---------- Decisions ----------
function baseRow(f, folder, extra = {}) {
  const sug = f.suggestion;
  return {
    fileId: f.id, fileName: f.name, folder,
    keptPath: S.manualKept[f.id] || null, keptManual: !!S.manualKept[f.id],
    suggestion: sug?.folder || '', confidence: sug?.confidence || '',
    accepted: !!sug && folder === sug.folder,
    decidedBy: S.person, decidedByName: me().name, decidedAt: new Date().toISOString(),
    decisionType: 'single file', mode: mode(), appVersion: S.pkg.version,
    duplicateCheck: f.duplicateCheck, ...extra,
  };
}

function decide(folder) {
  const f = currentFile();
  if (!f || !S.person) return;
  if (folder !== 'Unsure' && !approved().includes(folder)) return;
  const seconds = Math.round((Date.now() - S.shownAt) / 100) / 10;
  const row = baseRow(f, folder, { seconds, markedUnsureBy: folder === 'Unsure' ? me().name : undefined });
  store.saveDecisions([row]);
  if (folder !== 'Unsure') store.setKeypad(S.person, recordUse(keypadState(), folder, setting('keypadLearningFiles')));
  const holds = folder === 'Unsure' ? 0 : f.copies.length - 1;
  S.confirm = folder === 'Unsure'
    ? { tone: 'warn', text: `${f.name} → Unsure pile. Anyone can pick it up later.` }
    : { tone: 'ok', text: `${f.name} → ${folder}.${holds ? ` ${holds} duplicate${holds > 1 ? 's go' : ' goes'} to Duplicate Hold (not deleted).` : ''}` };
  delete S.manualKept[f.id];
  const next = available().find((x) => x.id !== f.id) || null;
  showFile(next);
  render();
}

function undo() {
  if (!S.person) return;
  const res = store.undoLast(S.person);
  if (!res || !res.restored.length) { toast('Nothing of yours to undo.'); return; }
  let ks = keypadState();
  for (const r of res.restored) if (r.removed.folder !== 'Unsure') ks = unrecordUse(ks, r.removed.folder);
  store.setKeypad(S.person, ks);
  const first = res.restored[0];
  const back = decisionsById()[first.fileId];
  S.view = 'sort';
  S.source = back?.folder === 'Unsure' ? 'unsure' : 'remaining';
  showFile(S.fileById[first.fileId]);
  S.confirm = { tone: 'warn', text: res.restored.length > 1 ? `Undid a folder decision: ${res.restored.length} files are back to unsorted.` : `Undid: ${S.fileById[first.fileId].name} is back on screen.` };
  render();
}

// ---------- Keypad ----------
function keypadState() { return store.keypad(S.person) || emptyKeypadState(); }
function keypadLayout(f) {
  const st = keypadState();
  const cands = candidateFolders({ pick: f.suggestion?.folder, alts: f.suggestion?.alts, usage: st.usage, common: COMMON_FOLDERS, approved: approved() });
  const { keys, state } = assignKeys(cands, st);
  if (JSON.stringify(state.homes) !== JSON.stringify(st.homes)) store.setKeypad(S.person, state); // new homes are remembered
  return { keys, state };
}

// ---------- Render: shell ----------
function render() {
  if (tourActive()) document.body.dataset.tour = '1';
  const app = $('#app');
  const f = S.view === 'sort' ? currentFile() : null;
  app.innerHTML = topbar() + toolbar() + `<main>${S.view === 'sort' ? sortView(f) : S.view === 'review' ? reviewView() : issuesView()}</main>` + statusbar();
  if (S.allFoldersOpen) { const inp = $('#folder-filter'); inp?.focus(); inp && (inp.value = S.folderFilter); }
  renderStatus();
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
        <div><b>${sorted.length} / ${scoped.length}</b> files<div class="small">${copiesDone}/${copiesTotal} copies · ${unsure} unsure</div></div>
      </div>
      <button class="icon-btn" data-act="help-menu" aria-label="Help, tour, rules and settings" title="Help">?</button>
      <button class="icon-btn" data-act="theme" aria-label="Switch light or dark" title="${theme === 'dark' ? 'Light mode' : 'Dark mode'}">${theme === 'dark' ? I.sun : I.moon}</button>
      <button class="profile-btn" data-act="profile-menu" data-tour="profile" aria-haspopup="menu">
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
    <div class="tgroup" data-tour="keyboard"><label>Keyboard</label><div class="kbd-ind" id="kbd-ind">${I.keyboard}<i class="led"></i><span>Keyboard on</span></div></div>` : ''}
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

function statusbar() {
  const kc = (k, w) => `<span class="kc sm ${w ? 'wide' : ''}">${k}</span>`;
  const keys = mode() === 'keypad'
    ? `<span>${kc('1')}–${kc('9')} folder</span><span>${kc('Enter', 1)} Claude's pick</span>`
    : `<span>${kc('Enter', 1)} accept</span><span>${kc('1')} ${kc('2')} alternatives</span>`;
  const scopeLabel = setting('scopeFolder') ? `${setting('scopeFolder')}${setting('scopeSubfolder') ? ' › ' + setting('scopeSubfolder') : ''}` : 'All folders';
  return `<footer class="statusbar">
    <div class="keys">${S.view === 'sort' ? `${keys}<span>${kc('/')} all folders</span><span>${kc('.')} unsure</span><span>${kc('0')} undo</span><span>${kc('N')} note</span>` : (S.view === 'review' ? '<span>Review: changes here update the plan and the decisions spreadsheet.</span>' : '<span>Issues are saved in this browser. Export and email them to TW.</span>')}</div>
    <div class="right">
      <a href="#" data-act="settings" title="Test scope: only these files are in the beta${isAdmin() ? '. Click to change.' : ''}">Scope: ${esc(scopeLabel)} · first ${setting('scopeFirstN')}</a>
      <span class="testline">Test mode · Nothing on SharePoint is changed.</span>
      <span class="save-ind" id="save-ind"><i></i><span>Saved</span></span>
      <a href="#" data-act="about">v${esc(S.pkg.version)} · Test mode</a>
    </div>
  </footer>`;
}

function renderStatus() {
  const el = $('#save-ind');
  if (el) {
    const st = store.status;
    el.className = 'save-ind ' + st;
    el.querySelector('span').textContent = st === 'saving' ? 'Saving…' : st === 'offline' ? 'Offline, will sync' : 'Saved';
    el.title = st === 'saved' ? `Every decision is saved immediately (${store.remote.label}).` : '';
  }
  const k = $('#kbd-ind');
  if (k) {
    const a = document.activeElement;
    const typing = a && (a.matches('input, textarea, select') || a.isContentEditable);
    k.classList.toggle('paused', !!typing);
    k.querySelector('span').textContent = typing ? 'Paused while typing' : 'Keyboard on';
  }
}

// ---------- Sort view ----------
function sortView(f) {
  if (!S.person) return `<div class="card empty"><h2>Choose your profile to start</h2><p class="muted">Every decision is saved under your name.</p><button class="btn primary" data-act="profile-menu">Choose profile</button></div>`;
  if (!f) {
    const otherClaims = queue().length - available().length;
    return `<div class="sort-grid"><div class="card empty">
      <div style="font-size:40px">${S.source === 'unsure' ? '🗂️' : '🎉'}</div>
      <h2>${S.source === 'unsure' ? 'The Unsure pile is empty' : 'Nothing left to sort in this scope'}</h2>
      <p class="muted">${otherClaims ? `${otherClaims} file(s) are open with someone else right now.` : S.source === 'remaining' && queue('unsure').length ? `${queue('unsure').length} file(s) are waiting in Unsure.` : 'Check the Review tab to see what the cleanup would do.'}</p>
      <div class="inline" style="justify-content:center">${S.source === 'remaining' && queue('unsure').length ? '<button class="btn" data-act="source" data-val="unsure">Sort from Unsure</button>' : ''}<button class="btn primary" data-act="view" data-val="review">Open Review</button><button class="btn danger" data-act="undo">${I.undo} Undo last decision</button></div>
    </div><div class="col">${whoCard()}${statsCard()}</div></div>`;
  }
  return `<div class="sort-grid">
    <div class="col">${fileCard(f)}${copiesCard(f)}</div>
    <div class="col">${mode() === 'keypad' ? keypadPanel(f) : suggestionPanel(f)}${whoCard()}${statsCard()}</div>
  </div>`;
}

function fileCard(f) {
  const q = queue();
  const d = decisionsById()[f.id];
  const notes = store.notes(f.id);
  const hints = [];
  if (S.source === 'unsure' && d) hints.push(`<span class="hint warn">Marked Unsure by ${esc(d.decidedByName)} · ${fmtDateTime(d.decidedAt)}</span>`);
  if (f.similar?.length) hints.push(`<span class="hint info">Similar files exist (different content): ${f.similar.map((s) => `<button data-act="jump" data-id="${s.id}" title="${esc(s.differences || '')}">${esc(s.name)}</button>`).join(', ')}${f.similar[0].differences ? ` · ${esc(f.similar[0].differences)}` : ''}</span>`);
  if (f.twin) hints.push(`<span class="hint warn" title="Same name and size, different content hash. Never held automatically.">Possible duplicate: review · ${esc(folderCrumb(f.twin.path))} (${esc(f.twin.tier)})</span>`);
  if (f.newSinceReport) hints.push('<span class="hint info">New since report</span>');
  const unapprovedTops = [...new Set(f.copies.map((c) => topFolder(c.path)).filter((t) => !approved().includes(t)))];
  if (unapprovedTops.length) hints.push(`<span class="hint">In a folder that isn't a sorting choice: ${unapprovedTops.map(esc).join(', ')}</span>`);
  if (f.reportNote) hints.push(`<span class="hint">Report note: ${esc(f.reportNote)}</span>`);
  const pv = previewCache.get(f.id) || { kind: 'loading' };
  return `<section class="card" data-tour="file">
    <div class="file-head">
      <span class="ftype" style="background:${typeColor(f.type)}">${esc(f.type.toUpperCase())}</span>
      <div style="min-width:0"><h1>${esc(f.name)}</h1>
      <div class="meta">${fmtSize(f.size)} · ${f.copies.length} ${f.copies.length === 1 ? 'copy' : 'copies'} · ${S.source === 'unsure' ? 'Unsure' : 'Remaining'} · ${q.length} left</div></div>
      <div class="actions"><button class="btn sm" data-act="note" title="Add a note (N)">${I.note} Note <span class="kc sm">N</span></button>
      <button class="btn sm" data-act="folder-decision" title="Send every unsorted file in a folder to one top-level folder">${I.stack} Sort this whole folder</button></div>
    </div>
    ${hints.length ? `<div class="hints">${hints.join('')}</div>` : ''}
    <div class="preview">${previewBody(f, pv)}
      <span class="tag">${pv.kind === 'placeholder' ? 'Large file · no thumbnail' : 'Thumbnail'} · next ${preloadedAhead()} pre-loaded</span>
      ${f.webUrl ? `<a class="open" href="${esc(f.webUrl)}" target="_blank" rel="noopener">Open full file ↗</a>` : '<a class="open" aria-disabled="true" title="Available with real SharePoint data (phase 2)">Open full file ↗</a>'}
    </div>
    ${notes.length ? `<div class="notes-box"><h3>Notes</h3>${notes.map((n) => `<div class="note-item">${esc(n.text)} <div class="by">${esc(n.byName)} · ${fmtDateTime(n.at)}</div></div>`).join('')}</div>` : ''}
  </section>`;
}

function previewBody(f, pv) {
  if (pv.kind === 'loading') return '<div class="pv-loading">Loading thumbnail…</div>';
  if (pv.kind === 'placeholder') return `<div class="pv-placeholder"><div class="big" style="background:${typeColor(f.type)}">${esc(f.type.toUpperCase())}</div><div><b>${esc(f.type.toUpperCase())} · ${fmtSize(f.size)}</b></div><div class="small">Too large to preview here. Use “Open full file” if you need to look.</div></div>`;
  if (pv.kind === 'image') return `<div class="pv-img">${I.image}</div>`;
  if (pv.kind === 'video') return `<div class="pv-img" style="background:linear-gradient(160deg,#2B3440,#55606C)">${I.play}</div>`;
  if (pv.kind === 'sheet') return `<div class="pv-sheet">${Array.from({ length: 30 }, (_, i) => (i % 5 === 0 ? '<b></b>' : '<i></i>')).join('')}</div>`;
  return `<div class="pv-doc"><i class="h"></i><i class="s"></i><i class="gap"></i><i></i><i></i><i style="width:80%"></i><i class="gap"></i><i></i><i style="width:70%"></i><i></i><i style="width:50%"></i></div>`;
}

function copiesCard(f) {
  const target = f.suggestion?.folder || null;
  const { copy: kept, manual } = keptCopy(f, target, S.manualKept[f.id]);
  const n = f.copies.length;
  const head = n > 1
    ? `<h2>${n} copies found · one decision covers all of them</h2><p>One copy is kept and moved to the folder you choose. The other ${n - 1} go${n - 1 === 1 ? 'es' : ''} to Duplicate Hold (not deleted), with a shortcut left behind. The kept copy is picked automatically: change it only if you know another copy is the right version.</p>`
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
    <div class="panel-head"><h2>Decision</h2>${s ? `<span class="conf ${s.confidence}">${s.confidence} confidence</span>` : ''}</div>
    <div class="panel-body">
      <div class="panel-hint">${I.keyboard}<span>Click a button, or press the key shown on it.</span></div>
      ${s ? `<button class="suggest" data-act="pick" data-folder="${esc(s.folder)}"><div><div class="eyebrow">Claude suggests</div><div class="folder">${esc(s.folder)}</div></div><span class="kc wide">Enter</span></button>
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
    <div class="row2"><button class="choice allf ${S.allFoldersOpen ? 'active' : ''}" data-act="all-folders"><span class="kc">/</span>All folders</button>
    <button class="choice unsure" data-act="pick" data-folder="Unsure" ${S.source === 'unsure' ? 'disabled title="Already in the Unsure pile"' : ''}><span class="kc">.</span>Unsure</button></div>
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
    <div class="panel-head"><h2>Keypad</h2>${f.suggestion ? `<span class="conf ${f.suggestion.confidence}">${f.suggestion.confidence} confidence</span>` : ''}</div>
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
      <div class="legend"><span><i class="pickdot"></i>Claude's pick (also <span class="kc sm wide">Enter</span>)</span>${anySpare ? '<span><b class="spare">SPARE</b> folder\'s own key is busy</span>' : ''}${f.suggestion?.reason ? `<span class="muted">${esc(f.suggestion.reason)}</span>` : ''}</div>
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
  const rows = Object.values(decisionsById()).filter((d) => d.decisionType === 'single file' && d.seconds > 0 && filterFn(d));
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
function reviewView() {
  const dec = decisionsById();
  const files = S.files;
  const decisions = Object.values(dec).filter((d) => S.fileById[d.fileId] && files.includes(S.fileById[d.fileId]));
  const sum = planSummary(files, decisions);
  const issues = conflictChecks(files, decisions, { maxPathLength: setting('maxPathLength') });
  const R = S.review;
  return `<div class="review">
    <div class="review-head"><div><h1>Review simulated changes</h1><p>What the cleanup would do with the decisions so far. Test mode: nothing is actually moved or changed.</p></div>
      <button class="btn primary" data-act="export-plan">${I.download} Export change plan</button></div>
    <div class="sum-cards">
      <div class="card"><b>${sum.sorted}</b><span>Files sorted</span></div>
      <div class="card"><b>${sum.move}</b><span>Files that would move</span></div>
      <div class="card"><b>${sum.stays}</b><span>Already in the right folder</span></div>
      <div class="card"><b>${sum.hold}</b><span>Duplicates to hold (not deleted)</span></div>
      <div class="card"><b>${sum.reviewed} / ${sum.total}</b><span>Reviewed</span></div>
    </div>
    <div class="card safety">${I.shield}<div><b>Nothing is permanently deleted.</b> Duplicates go to a Duplicate Hold folder for ${setting('holdDays')} days, with a shortcut left in each old spot, and can be restored from there. They're only deleted after TW or KB signs off and the hold period ends. Only byte-identical copies are held, the kept copy is never held, and a full backup of the property folder is taken before any real cleanup.</div></div>
    ${issues.length ? `<div class="card"><div class="panel-head"><h2>Conflict checks · ${issues.length}</h2><span class="muted small">Things a real cleanup would trip on</span></div>${issues.map((i) => `<div class="issue"><b>${esc(i.kind)}</b> ${esc(S.fileById[i.fileId]?.name)}: ${esc(i.detail)}</div>`).join('')}</div>` : ''}
    <div class="review-tools">
      <div class="seg">${[['changes', 'Changes by file'], ['tree', 'Folder tree: before → after']].map(([v, l]) => `<button data-act="review-tab" data-val="${v}" aria-pressed="${R.tab === v}">${l}</button>`).join('')}</div>
      ${R.tab === 'changes' ? `<div class="filters">
        <select data-act-change="rf-person" aria-label="Filter by person"><option value="">Everyone</option>${PEOPLE.map((p) => `<option value="${p.id}" ${R.person === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
        <select data-act-change="rf-type" aria-label="Filter by decision type"><option value="">Single + folder decisions</option><option value="single file" ${R.type === 'single file' ? 'selected' : ''}>Single files</option><option value="folder decision" ${R.type === 'folder decision' ? 'selected' : ''}>Folder decisions</option></select>
        <label class="chk"><input type="checkbox" data-act-change="rf-changed" ${R.changed ? 'checked' : ''}> Changed from Claude</label>
        <label class="chk"><input type="checkbox" data-act-change="rf-unreviewed" ${R.unreviewed ? 'checked' : ''}> Not yet reviewed</label>
      </div>` : ''}
    </div>
    ${R.tab === 'changes' ? changesByFile(decisions, issues) : folderTrees()}
  </div>`;
}

function changesByFile(decisions, issues) {
  const R = S.review;
  const counts = {};
  for (const d of decisions) counts[d.folder] = (counts[d.folder] || 0) + 1;
  const folders = approved().filter((f) => counts[f]);
  const empty = approved().length - folders.length;
  let list = decisions.filter((d) => R.folder === 'all' || d.folder === R.folder);
  if (R.person) list = list.filter((d) => d.decidedBy === R.person);
  if (R.type) list = list.filter((d) => d.decisionType === R.type);
  if (R.changed) list = list.filter((d) => d.folder !== 'Unsure' && !d.accepted);
  if (R.unreviewed) list = list.filter((d) => !d.reviewedBy);
  list.sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
  const title = R.folder === 'all' ? 'All decisions' : R.folder;
  const issueBy = {};
  issues.forEach((i) => (issueBy[i.fileId] ||= []).push(i));
  return `<div class="review-grid">
    <div class="card dest-list"><div class="lh">Destination folders</div>
      <button class="${R.folder === 'all' ? 'sel' : ''}" data-act="rf-folder" data-val="all">All decisions <span class="count">${decisions.length}</span></button>
      ${folders.map((f) => `<button class="${R.folder === f ? 'sel' : ''}" data-act="rf-folder" data-val="${esc(f)}">${esc(f)} <span class="count">${counts[f]}</span></button>`).join('')}
      <button class="unsure ${R.folder === 'Unsure' ? 'sel' : ''}" data-act="rf-folder" data-val="Unsure">Unsure <span class="count">${counts.Unsure || 0}</span></button>
      <div class="foot">${empty} of ${approved().length} folders receive nothing yet</div>
    </div>
    <div><div class="list-head"><h2>${esc(title)}</h2><span class="muted">${list.length} file${list.length === 1 ? '' : 's'}</span></div>
      ${list.length ? list.map((d) => decisionCard(d, issueBy[d.fileId])).join('') : '<div class="card empty"><p class="muted">No decisions match.</p></div>'}
    </div>
  </div>`;
}

function decisionCard(d, issues = []) {
  const f = S.fileById[d.fileId];
  const acts = planForDecision(f, d).filter((a) => a.action !== 'Shortcut');
  const line = (a) => {
    if (a.action === 'Move') return `${esc(folderCrumb(a.from))} → ${esc(d.folder)}`;
    if (a.action === 'Stays') return `Kept copy already in ${esc(d.folder)}: ${esc(folderCrumb(a.from))}`;
    if (a.action === 'Hold') return `Duplicate in ${esc(folderCrumb(a.from))} → Duplicate Hold (not deleted) · shortcut left behind`;
    return `${esc(folderCrumb(a.from))} · stays where it is`;
  };
  const matches = d.folder === 'Unsure' ? 'marked Unsure' : d.accepted ? 'matches Claude' : `<span class="changed">changed from Claude (${esc(d.suggestion || 'none')})</span>`;
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

function folderTrees() {
  const dec = decisionsById();
  const t = buildTrees(S.files, dec);
  const q = S.review.query.trim().toLowerCase();
  const node = (n, key, depth) => {
    const total = countFiles(n);
    const matchesQ = (x) => !q || x.name.toLowerCase().includes(q);
    const files = n.files.filter(matchesQ);
    const kids = [...n.children.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (q && !files.length && !kids.some((k) => hasMatch(k, q))) return '';
    const isOpen = q ? true : S.review.open.has(key) ? true : depth === 0 && !S.review.open.has('x:' + key);
    const pad = `style="padding-left:${18 + depth * 18}px"`;
    return `<div class="tnode"><div class="trow" data-act="tree-toggle" data-key="${esc(key)}" data-depth="${depth}" ${pad}><span class="tw">${isOpen ? '▼' : '▶'}</span>${I.folder}${esc(n.name)}<span class="count">${total}</span></div>
      ${isOpen ? kids.map((k) => node(k, key + '/' + k.name, depth + 1)).join('') + files.map((fl) => `<div class="tfile" style="padding-left:${36 + depth * 18}px">${I.file}${esc(fl.name)}${fl.tag ? `<span class="ttag ${fl.tag.tone}">${esc(fl.tag.label)}</span>` : ''}</div>`).join('') : ''}</div>`;
  };
  const tops = (root, prefix) => [...root.children.values()].sort((a, b) => a.name.localeCompare(b.name)).map((k) => node(k, prefix + k.name, 0)).join('');
  const changedTops = new Set();
  for (const d of Object.values(dec)) { const f = S.fileById[d.fileId]; if (!f || d.folder === 'Unsure') continue; changedTops.add(d.folder); f.copies.forEach((c) => changedTops.add(topFolder(c.path))); }
  const unchanged = approved().filter((f) => !changedTops.has(f)).length;
  const deletedZero = 0; // the plan never deletes anything
  return `<div class="trees">
    <div class="card tree"><div class="th"><h3>Before · today</h3><p>${esc(PROPERTY.name)}, every copy where it lives now</p></div>
      <div class="search"><input data-act-input="tree-q" placeholder="Search file names" value="${esc(S.review.query)}"></div>
      ${tops(t.before, 'b:')}</div>
    <div class="card tree"><div class="th"><h3>After · simulated cleanup</h3><p>One copy of each sorted file, in its chosen folder</p></div>
      <div class="search"><input data-act-input="tree-q" placeholder="Search file names" value="${esc(S.review.query)}"></div>
      ${tops(t.after, 'a:')}
      ${countFiles(t.notSorted) ? node(t.notSorted, 'a:__notsorted', 0) : ''}
      ${countFiles(t.hold) ? node(t.hold, 'a:__hold', 0) : ''}
      <div class="tree-foot">${unchanged} other folders unchanged · ${t.shortcuts} shortcut${t.shortcuts === 1 ? '' : 's'} left in old locations · ${deletedZero} files deleted</div></div>
  </div>`;
}
function hasMatch(n, q) { return n.files.some((f) => f.name.toLowerCase().includes(q)) || [...n.children.values()].some((k) => hasMatch(k, q)); }

// ---------- Modals ----------
function openModal(html, { wide = false, onClose } = {}) {
  closeModal();
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeModal(); });
  document.body.appendChild(ov);
  S.modal = { el: ov, onClose };
  setTimeout(() => ov.querySelector('[autofocus]')?.focus() || ov.querySelector('input, textarea, select, button')?.focus(), 0);
  renderStatus();
  return ov;
}
function closeModal() {
  if (!S.modal) return;
  S.modal.el.remove();
  const cb = S.modal.onClose;
  S.modal = null;
  cb?.();
  renderStatus();
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
  const f = currentFile();
  if (!f) return;
  const anchor = $('[data-act="note"]')?.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'note-pop';
  pop.style.top = `${(anchor?.bottom || 120) + 8}px`;
  pop.style.left = `${Math.max(16, (anchor?.right || 400) - 360)}px`;
  pop.innerHTML = `<input id="note-input" maxlength="300" placeholder="Short note about ${esc(f.name)}" aria-label="Note"><div class="muted"><span class="kc sm wide">Enter</span> save and keep this file · <span class="kc sm">Esc</span> cancel</div>`;
  document.body.appendChild(pop);
  const inp = pop.querySelector('input');
  const done = () => { pop.remove(); S.modal = null; renderStatus(); };
  S.modal = { el: pop, onClose: null };
  inp.focus();
  inp.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); done(); }
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = inp.value.trim();
      if (text) store.addNote(f.id, { text, by: S.person, byName: me().name, at: new Date().toISOString(), appVersion: S.pkg.version });
      done(); render(); if (text) toast('Note saved.');
    }
  });
  inp.addEventListener('blur', () => setTimeout(() => pop.isConnected && done(), 150));
}

function openFolderDecision() {
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
  const filesIn = (p) => S.files.filter((x) => !decisionsById()[x.id] && !store.claimedByOther(x.id, S.person, setting('claimIdleMinutes')) && x.copies.some((c) => (pathParts(c.path).join('/')).startsWith(p + '/')));
  const update = () => {
    const p = ov.querySelector('#fd-path').value;
    const list = filesIn(p);
    ov.querySelector('#fd-info').innerHTML = `<b>${list.length} unsorted file${list.length === 1 ? '' : 's'}</b> in ${esc(p.replace(/\//g, ' › '))}${list.length ? `: ${list.slice(0, 6).map((x) => esc(x.name)).join(', ')}${list.length > 6 ? `, and ${list.length - 6} more` : ''}` : ''}`;
    ov.querySelector('#fd-go').textContent = `Send ${list.length} file${list.length === 1 ? '' : 's'} to ${ov.querySelector('#fd-dest').value}`;
    ov.querySelector('#fd-go').disabled = !list.length;
  };
  ov.querySelector('#fd-path').onchange = update;
  ov.querySelector('#fd-dest').onchange = update;
  update();
  ov.querySelector('#fd-go').onclick = () => {
    const p = ov.querySelector('#fd-path').value;
    const dest = ov.querySelector('#fd-dest').value;
    const list = filesIn(p);
    const batchId = uid('folder');
    const at = new Date().toISOString();
    const seconds = Math.round(((Date.now() - S.shownAt) / 1000 / list.length) * 10) / 10;
    const rows = list.map((x) => ({ ...baseRow(x, dest), keptPath: S.manualKept[x.id] || null, decidedAt: at, decisionType: 'folder decision', folderDecisionPath: p, batchId, seconds }));
    store.saveDecisions(rows, { batchId });
    let ks = keypadState();
    rows.forEach(() => { ks = recordUse(ks, dest, setting('keypadLearningFiles')); });
    store.setKeypad(S.person, ks);
    S.confirm = { tone: 'ok', text: `Folder decision: ${rows.length} files from ${p.replace(/\//g, ' › ')} → ${dest}.` };
    closeModal();
    showFile(available()[0] || null);
    render();
  };
}

async function openRules() {
  const md = await fetch('sorting-rules.md', { cache: 'no-store' }).then((r) => r.text()).catch(() => 'Could not load the rulebook.');
  openModal(`${modalHead('Sorting rules')}<div class="content rules-md">${miniMarkdown(md)}</div><footer><span class="muted small" style="margin-right:auto">Edit <code>sorting-rules.md</code> to change these. Claude gets the rulebook with every suggestion.</span><button class="btn" data-act="close-modal">Close</button></footer>`, { wide: true });
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
    <div class="attached">Test mode is on. Decisions go to test storage (${esc(store.remote.label)}). The app never moves, renames or deletes any file. Data: ${esc(S.dataSource)}.</div>
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
      <div class="muted">A dated backup of the decisions is saved once a day and at the end of each session.</div>
      <div class="inline">${store.listBackups().filter((b) => /^\d{4}-\d{2}-\d{2}$/.test(b)).slice(0, 7).map((b) => `<button class="btn sm" data-backup="${b}">${b}</button>`).join('') || '<span class="muted">No backups yet.</span>'}</div>
      <div><button class="btn sm danger" id="reset-test">Reset test data…</button></div></div>` : '<div class="muted small">Folder lists, cost cap, speed by person, backups and reset are admin settings (TW).</div>'}
  </div><footer><button class="btn" data-act="close-modal">Close</button>${admin ? '<button class="btn primary" id="set-save">Save settings</button>' : ''}</footer>`, { wide: true });

  ov.querySelector('#kp-reset').onclick = () => {
    if (!confirm('Reset your keypad numbers? The learning period starts again.')) return;
    store.setKeypad(S.person, resetNumbers()); closeModal(); render(); toast('Keypad numbers reset.');
  };
  ov.querySelector('#sc-folder').onchange = (e) => { const sub = ov.querySelector('#sc-sub'); sub.innerHTML = '<option value="">All subfolders</option>' + Object.keys(subfoldersOf(S.allFiles, e.target.value)).sort().map((o) => `<option>${esc(o)}</option>`).join(''); };
  if (!admin) return;
  ov.querySelectorAll('[data-backup]').forEach((b) => (b.onclick = () => exportBackup({ date: b.dataset.backup, backup: store.readBackup(b.dataset.backup), files: S.files, notesById: store.db.notes, version: S.pkg.version, person: me().name })));
  ov.querySelector('#reset-test').onclick = () => {
    if (!confirm('Reset test data? This clears all TEST decisions, notes, claims and issues for everyone. A backup is saved first.')) return;
    const key = store.resetTestData();
    closeModal(); S.confirm = null; showFile(null); render(); toast(`Test data reset. Backup saved as ${key}.`);
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
function openMenu(anchorEl, html) {
  closeMenu();
  const r = anchorEl.getBoundingClientRect();
  const m = document.createElement('div');
  m.className = 'menu'; m.id = 'menu';
  m.innerHTML = html;
  m.style.top = `${r.bottom + 6}px`;
  m.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.appendChild(m);
  setTimeout(() => document.addEventListener('mousedown', outsideMenu), 0);
}
function outsideMenu(e) { if (!e.target.closest('#menu')) closeMenu(); }
function closeMenu() { $('#menu')?.remove(); document.removeEventListener('mousedown', outsideMenu); }

function profileMenu(el) {
  openMenu(el, `${PEOPLE.map((p) => `<button data-act="set-person" data-val="${p.id}">${avatar(p, 'sm')} ${esc(p.name)}${p.id === S.person ? `<span class="check">${I.check.replace('<svg', '<svg width="16" height="16"')}</span>` : ''}</button>`).join('')}
    <div class="sep"></div><div class="note">Beta: pick your name. After the beta, your Microsoft sign-in sets this automatically.</div>`);
}
function helpMenu(el) {
  openMenu(el, `<button data-act="tour">Replay the tour</button><button data-act="rules">Sorting rules</button><button data-act="settings">${isAdmin() ? 'Settings (admin)' : 'Settings'}</button><div class="sep"></div><button data-act="about">About · v${esc(S.pkg.version)}</button>`);
}

function setPerson(id) {
  if (S.person && S.person !== id) store.releaseClaims(S.person);
  S.person = id;
  localStorage.setItem(DEVICE_PERSON_KEY, id);
  applyTheme();
  showFile(available()[0] || null);
  render();
}

function applyTheme() {
  const t = prefs().theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
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

function openTour(startAt = 0) {
  S.view = 'sort';
  if (!currentFile()) S.source = 'remaining';
  render();
  startTour({
    startAt, version: S.pkg.version, people: PEOPLE, person: S.person, propertyName: PROPERTY.name,
    choosePerson: (id) => { setPerson(id); },
    finish: (how) => { if (S.person) store.setPrefs(S.person, { tourDone: how }); render(); },
  });
}

// ---------- Events ----------
const actions = {
  view: (d) => { S.view = d.val; S.confirm = null; render(); },
  source: (d) => { S.source = d.val; S.confirm = null; showFile(available()[0] || null); render(); },
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
  'export-issues': () => exportIssues({ issues: store.issues(), version: S.pkg.version, person: me()?.initials || '', initialsOf }),
  'if-person': (d) => { S.issues.person = d.val; render(); },
  'if-status': (d) => { S.issues.status = d.val; render(); },
  export: () => exportDecisions({ files: S.files, decisionsById: decisionsById(), notesById: store.db.notes, version: S.pkg.version, person: me()?.name || '' }),
  'export-plan': () => {
    const decs = Object.values(decisionsById()).filter((d) => S.fileById[d.fileId] && S.files.includes(S.fileById[d.fileId]));
    exportChangePlan({ actions: buildPlan(S.files, decs), version: S.pkg.version, person: me()?.name || '', peopleById });
  },
  theme: () => {
    const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = t;
    if (S.person) store.setPrefs(S.person, { theme: t });
    render();
  },
  'profile-menu': (d, el) => profileMenu(el),
  'help-menu': (d, el) => helpMenu(el),
  'set-person': (d) => {
    closeMenu(); setPerson(d.val);
    if (!prefs().tourDone) openTour(0);
  },
  tour: () => { closeMenu(); openTour(0); },
  rules: () => { closeMenu(); openRules(); },
  settings: () => { closeMenu(); openSettings(); },
  about: () => { closeMenu(); openAbout(); },
  'close-modal': () => closeModal(),
  'review-tab': (d) => { S.review.tab = d.val; render(); },
  'rf-folder': (d) => { S.review.folder = d.val; render(); },
  'mark-reviewed': (d) => {
    const cur = decisionsById()[d.id];
    if (cur.reviewedBy) store.editDecision(d.id, { reviewedBy: '', reviewedAt: '' });
    else store.editDecision(d.id, { reviewedBy: S.person, reviewedAt: new Date().toISOString() });
    render();
  },
  'tree-toggle': (d) => {
    const key = d.key, o = S.review.open;
    const depth0 = d.depth === '0';
    const isOpen = o.has(key) || (depth0 && !o.has('x:' + key));
    if (isOpen) { o.delete(key); if (depth0) o.add('x:' + key); } else { o.add(key); o.delete('x:' + key); }
    render();
  },
};

const changeActions = {
  'issue-status': (el) => { store.updateIssue(el.dataset.id, { status: el.value, statusBy: S.person, statusAt: new Date().toISOString() }); render(); },
  'rf-person': (el) => { S.review.person = el.value; render(); },
  'rf-type': (el) => { S.review.type = el.value; render(); },
  'rf-changed': (el) => { S.review.changed = el.checked; render(); },
  'rf-unreviewed': (el) => { S.review.unreviewed = el.checked; render(); },
  'edit-folder': (el) => {
    const id = el.dataset.id;
    const f = S.fileById[id];
    const folder = el.value;
    store.editDecision(id, { folder, accepted: !!f.suggestion && folder === f.suggestion.folder, editedBy: me().name, editedAt: new Date().toISOString(), reviewedBy: '', reviewedAt: '' });
    toast(`${f.name} → ${folder} (edited in review by ${me().name}).`);
    render();
  },
};

function toggleAllFolders(force) {
  S.allFoldersOpen = force ?? !S.allFoldersOpen;
  S.folderFilter = ''; S.folderHl = 0;
  render();
}

function bindGlobalEvents() {
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.act];
    if (!fn) return;
    if (el.tagName === 'A') e.preventDefault();
    fn(el.dataset, el, e);
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
    if (e.target.dataset.actInput === 'tree-q') {
      S.review.query = e.target.value;
      const pos = e.target.selectionStart, idx = [...document.querySelectorAll('[data-act-input="tree-q"]')].indexOf(e.target);
      render();
      const again = document.querySelectorAll('[data-act-input="tree-q"]')[idx];
      again?.focus(); again?.setSelectionRange(pos, pos);
    }
  });
  document.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('[data-act-toggle]');
    if (d && S.person) store.db.prefs[S.person] = { ...prefs(), [d.dataset.actToggle]: d.open };
  }, true);
  document.addEventListener('focusin', renderStatus);
  document.addEventListener('focusout', () => setTimeout(renderStatus, 0));
  document.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', () => { if (S.person) store.releaseClaims(S.person); store.backup('end of session'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') store.backup('end of session'); });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!prefs().theme) { applyTheme(); render(); } });
}

function onKey(e) {
  if (tourActive()) return; // the tour handles its own keys
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const a = document.activeElement;
  const typing = a && (a.matches('input, textarea, select') || a.isContentEditable);

  if (S.modal) { if (e.key === 'Escape') { e.preventDefault(); closeModal(); } return; }
  if ($('#menu')) { if (e.key === 'Escape') closeMenu(); return; }

  // Folder filter box: arrows move, Enter picks, Esc closes.
  if (a && a.id === 'folder-filter') {
    const list = filteredFolders();
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      S.folderHl = Math.max(0, Math.min(list.length - 1, S.folderHl + (e.key === 'ArrowDown' ? 1 : -1)));
      $('#folder-list').innerHTML = folderListItems();
      $('#folder-list .hl')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { e.preventDefault(); if (list[S.folderHl]) decide(list[S.folderHl]); }
    else if (e.key === 'Escape') { e.preventDefault(); toggleAllFolders(false); }
    return;
  }
  if (typing) return; // keyboard shortcuts pause while typing
  if (S.view !== 'sort' || !S.person) return;
  const f = currentFile();
  const key = e.key;
  if (key === '0') { e.preventDefault(); undo(); return; }
  if (!f) return;
  if (key === 'Enter') { e.preventDefault(); if (f.suggestion) decide(f.suggestion.folder); return; }
  if (key === '/') { e.preventDefault(); toggleAllFolders(true); return; }
  if (key === '.' || key === 'Decimal') { e.preventDefault(); if (S.source !== 'unsure') decide('Unsure'); return; }
  if (key === 'n' || key === 'N') { e.preventDefault(); openNote(); return; }
  if (key === 'Escape' && S.allFoldersOpen) { toggleAllFolders(false); return; }
  if (/^[1-9]$/.test(key)) {
    e.preventDefault();
    const n = +key;
    if (mode() === 'keypad') { const slot = keypadLayout(f).keys[n]; if (slot) decide(slot.folder); }
    else { const alt = f.suggestion?.alts?.[n - 1]; if (alt && n <= 2) decide(alt); }
  }
}

boot().catch((err) => {
  console.error(err);
  $('#app').innerHTML = `<div style="padding:40px;font-family:sans-serif"><h2>File Sorter could not start</h2><pre>${esc(err.stack || err)}</pre></div>`;
});

// Exposed for the tutorial and debugging.
window.__jpcfs = { S, get store() { return store; }, render };
