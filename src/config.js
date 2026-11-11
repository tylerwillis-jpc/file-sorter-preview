/* JPC File Sorter · v0.3.2-beta · config.js
 * All settings live here. The version itself lives only in package.json.
 * Admin-editable settings (folders, scope, etc.) start from these defaults and
 * can be overridden in the Settings panel (stored with the test data).
 */

// Test Mode: locked ON for this version. Only the admin (TW) can change it, and the
// "live" write path is deliberately not built yet.
export const TEST_MODE = true;
export const TEST_MODE_LOCKED = true;

// People are shown by initials only.
export const PEOPLE = [
  { id: 'tw', name: 'TW', initials: 'TW', color: '#0077B3', admin: true, reviewer: true },
  { id: 'kb', name: 'KB', initials: 'KB', color: '#6D4FC2', admin: false, reviewer: true },
  { id: 'ch', name: 'CH', initials: 'CH', color: '#C2531B', admin: false, reviewer: false },
];

// The property being sorted (a SharePoint site). Other properties come later.
export const PROPERTY = {
  name: '1 W Santa Clara SJ',
  siteUrl: '' /* set in the private build only */,
  library: 'Shared Documents',
};

// Approved destination folders. Only these can ever be chosen.
export const APPROVED_FOLDERS = [
  'Accounting', 'Acquisition', 'Bldg Information & Measurements', 'Construction & Development',
  'Contracts', 'Development Reports', 'Environmental', 'Financing', 'Government',
  'Graphics & Images', 'Insurance', 'Leasing & Marketing', 'Legal', 'Ownership',
  'Parking Agreements', 'Permits_License Agreements', 'Physical Reports', 'Property Management',
  'Reports', 'Tenants', 'Title', 'Underwriting', 'Utility Transfer', 'VTA',
];

// Old names that mean an approved folder (e.g. the S drive's "PM Construction").
export const FOLDER_ALIASES = { 'PM Construction': 'Construction & Development' };

// Top-level folders whose files are never shown, counted or planned.
export const EXCLUDED_FOLDERS = ['SharePoint'];

// System files ignored everywhere.
export const IGNORED_FILE_PATTERNS = [/^\.DS_Store$/i, /^Thumbs\.db$/i, /^~\$/, /^desktop\.ini$/i];

export const DEFAULTS = {
  // Test scope: limit the beta to a top-level folder (and optional subfolder) and the first N files.
  scopeFolder: 'Construction & Development',
  scopeSubfolder: '',
  scopeFirstN: 300,
  keypadLearningFiles: 50,      // files sorted before keypad numbers lock
  holdDays: 90,                 // Duplicate Hold period
  claimIdleMinutes: 10,         // a claim is released after this long idle
  preloadCount: 12,             // thumbnails + suggestions kept ready ahead
  largeFileBytes: 150 * 1024 * 1024, // above this, show a placeholder instead of a thumbnail
  claudeCostCapUsd: 25,         // test mode: stop pre-computing suggestions past this (phase 4)
  maxPathLength: 400,           // SharePoint full-path limit, used by conflict checks
};

// Common fallback folders for the keypad when Claude + usage don't fill 9 keys.
export const COMMON_FOLDERS = [
  'Construction & Development', 'Property Management', 'Accounting', 'Bldg Information & Measurements',
  'Contracts', 'Leasing & Marketing', 'Legal', 'Insurance', 'Graphics & Images', 'Permits_License Agreements',
];

export const DUPLICATE_HOLD_FOLDER = '_Duplicate Hold';

// Storage namespace. Test data never shares a location with live data.
export const DATA_NAMESPACE = TEST_MODE ? 'TEST_' : 'LIVE_';
