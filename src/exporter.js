/* JPC File Sorter · v0.4.1-beta · exporter.js
 * .xlsx exports (SheetJS, loaded in index.html). Every export starts with an "Info" row
 * carrying the app version, and file names include the date and version.
 */
import { TEST_MODE } from './config.js';
import { decisionKept } from './plan.js';
import { today } from './util.js';

const prefix = () => (TEST_MODE ? 'TEST_' : '');

function download(name, sheets, info) {
  const XLSX = window.XLSX;
  if (!XLSX) { alert('The spreadsheet library did not load. Check your connection and try again.'); return; }
  const wb = XLSX.utils.book_new();
  for (const [sheetName, header, rows] of sheets) {
    const aoa = [[`Info: ${info}`], [], header, ...rows.map((r) => header.map((h) => r[h] ?? ''))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = header.map((h) => ({ wch: Math.min(60, Math.max(10, h.length + 2)) }));
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
  }
  XLSX.writeFile(wb, name);
  return name;
}

const infoLine = (version, person, extra = '') =>
  `JPC File Sorter v${version}${TEST_MODE ? ' · Test mode (nothing on SharePoint is changed)' : ''} · exported ${new Date().toLocaleString()} by ${person}${extra}`;

export const DECISION_COLUMNS = [
  'File name', 'Master copy path', 'All copy paths', 'Copy count', 'Chosen folder', "Claude's suggestion", 'Confidence',
  'Accepted suggestion? (Y/N)', 'Decided by', 'Decided at', 'Note', 'Decision type', 'Duplicate check',
  'Seconds on this file', 'Selection mode', 'Edited in review by', 'Reviewed by', 'Reviewed at', 'App version', 'Test',
];

/** One row per unique file in scope (undecided files have a blank Chosen folder). */
export function decisionRows(files, decisionsById, notesById) {
  return files.map((f) => {
    const d = decisionsById[f.id];
    const kept = d && d.folder !== 'Unsure' ? decisionKept(f, d).copy : null;
    const notes = (notesById[f.id] || []).map((n) => `${n.by}: ${n.text}`).join(' | ');
    return {
      'File name': f.name,
      'Master copy path': kept ? kept.path : '',
      'All copy paths': f.copies.map((c) => c.path).join('; '),
      'Copy count': f.copies.length,
      'Chosen folder': d ? d.folder : '',
      "Claude's suggestion": f.suggestion ? f.suggestion.folder : '',
      Confidence: f.suggestion ? f.suggestion.confidence : '',
      'Accepted suggestion? (Y/N)': d && d.folder !== 'Unsure' ? (d.accepted ? 'Y' : 'N') : '',
      'Decided by': d ? d.decidedByName : '',
      'Decided at': d ? d.decidedAt : '',
      Note: notes,
      'Decision type': d ? d.decisionType : '',
      'Duplicate check': f.duplicateCheck,
      'Seconds on this file': d ? d.seconds : '',
      'Selection mode': d ? d.mode : '',
      'Edited in review by': d ? d.editedBy || '' : '',
      'Reviewed by': d ? d.reviewedBy || '' : '',
      'Reviewed at': d ? d.reviewedAt || '' : '',
      'App version': d ? d.appVersion : '',
      Test: TEST_MODE ? 'Yes' : 'No',
    };
  });
}

export function exportDecisions({ files, decisionsById, notesById, version, person }) {
  const name = `${prefix()}decisions_${today()}_v${version}.xlsx`;
  return download(name, [['Decisions', DECISION_COLUMNS, decisionRows(files, decisionsById, notesById)]], infoLine(version, person));
}

export const PLAN_COLUMNS = ['Step', 'Action', 'File', 'File ID', 'From path', 'To path', 'Kept copy', 'Copy size (bytes)', 'Copy modified', 'Duplicate check',
  'Hold for (days)', 'Decision by', 'Decided at', 'Edited in review by', 'Reviewed by', 'Reviewed at', 'Decision app version', 'SharePoint item ID', 'Content hash', 'Note', 'Test'];
export const CONFLICT_COLUMNS = ['Kind', 'File', 'File ID', 'Detail'];
/**
 * The change plan, one row per planned action, in the order a cleanup would perform them.
 * DRAFT: always available, clearly labelled. APPROVED: only for the exact plan a reviewer approved.
 * See docs/change-plan-schema.md.
 */
export function exportChangePlan({ actions, issues = [], approval, fingerprint, inventoryId, dataMeta, scope, holdDays, version, person, peopleById }) {
  const nameOf = (id) => peopleById[id]?.name || id || '';
  const rows = actions.map((a) => ({
    Step: a.step, Action: a.action, File: a.file, 'File ID': a.fileId, 'From path': a.from, 'To path': a.to, 'Kept copy': a.kept ? 'Yes' : '',
    'Copy size (bytes)': a.size ?? '', 'Copy modified': a.modified || '', 'Duplicate check': a.duplicateCheck,
    'Hold for (days)': a.action === 'Hold' ? holdDays : '', 'Decision by': nameOf(a.decisionBy), 'Decided at': a.decidedAt || '',
    'Edited in review by': a.editedBy, 'Reviewed by': nameOf(a.reviewedBy), 'Reviewed at': a.reviewedAt || '', 'Decision app version': a.appVersion,
    'SharePoint item ID': '', 'Content hash': '', Note: a.note || '', Test: TEST_MODE ? 'Yes' : 'No',
  }));
  const conflicts = issues.map((i) => ({ Kind: i.kind, File: i.fileName || '', 'File ID': i.fileId, Detail: i.detail }));
  const kind = approval ? 'APPROVED' : 'DRAFT';
  const status = approval
    ? `APPROVED by ${approval.byName} at ${approval.at}`
    : 'DRAFT: not approved, do not act on this file';
  const extra = ` · ${status} · plan ${fingerprint} · inventory ${inventoryId}${dataMeta ? ` (report ${dataMeta.reportDate})` : ''} · scope ${scope} · ${issues.length} conflict(s)`
    + ' · simulated only: nothing has been performed · not yet re-checked against live SharePoint (phase 3)';
  const name = `${prefix()}change_plan_${kind}_${today()}_v${version}.xlsx`;
  return download(name, [['Change plan', PLAN_COLUMNS, rows], ['Conflicts', CONFLICT_COLUMNS, conflicts]], infoLine(version, person, extra));
}

export const ISSUE_COLUMNS = ['Issue ID', 'Type', 'What happened', 'What I expected', 'Person', 'Time', 'App version', 'View / mode', 'File', 'Status', 'Notes', 'Test'];
export const ISSUE_NOTE_COLUMNS = ['Issue ID', 'Issue', 'Person', 'Time', 'Note'];
/** One row per issue, plus a second sheet with every note. */
export function exportIssues({ issues, version, person, initialsOf }) {
  const rows = issues.map((r) => ({
    'Issue ID': r.id, Type: r.type, 'What happened': r.happened, 'What I expected': r.expected || '',
    Person: initialsOf(r.person), Time: r.at, 'App version': r.appVersion, 'View / mode': r.where,
    File: r.fileName || '', Status: r.status, Notes: (r.notes || []).length, Test: TEST_MODE ? 'Yes' : 'No',
  }));
  const notes = issues.flatMap((r) => (r.notes || []).map((n) => ({
    'Issue ID': r.id, Issue: r.happened.slice(0, 80), Person: initialsOf(n.by), Time: n.at, Note: n.text,
  })));
  return download(`${prefix()}issues_${today()}_v${version}.xlsx`, [['Issues', ISSUE_COLUMNS, rows], ['Notes', ISSUE_NOTE_COLUMNS, notes]], infoLine(version, person));
}

export function exportBackup({ date, backup, files, notesById, version, person }) {
  const rows = decisionRows(files, backup.decisions || {}, backup.notes || notesById);
  return download(`${prefix()}decisions_${date}_backup_v${version}.xlsx`, [['Decisions', DECISION_COLUMNS, rows]], infoLine(version, person, ` · backup taken ${backup.at}`));
}
