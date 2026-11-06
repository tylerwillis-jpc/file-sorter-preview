/* JPC File Sorter · v0.2.1-beta · sample-data.js
 * Phase 1 sample: made-up files (one each of PDF, JPG, MP4, XLSX, CSV, DOCX and a
 * few more) with fake suggestions. No real company data. Phase 2 replaces this with
 * the duplicate report + live SharePoint scan.
 */

const L = 'Shared Documents';
const p = (...parts) => [L, ...parts].join('/');

export const SAMPLE_RAW_FILES = [
  {
    id: 'f01', name: 'Plan Check Response - Rev 3.pdf', type: 'pdf', size: 2.4e6, group: 'G-0101',
    copies: [
      { path: p('Construction & Development', 'City Comments', 'Plan Check Response - Rev 3.pdf'), modified: '2021-03-18', reportKeep: true },
      { path: p('Construction & Development', 'Permit Fee Receipts', 'Plan Check Response - Rev 3.pdf'), modified: '2021-03-12' },
      { path: p('Construction & Development', 'Closeout Binder', 'Plan Check Response - Rev 3.pdf'), modified: '2021-02-25' },
      { path: p('Reports', 'Plan Check Response - Rev 3.pdf'), modified: '2021-02-20' },
    ],
    suggestion: { folder: 'Permits_License Agreements', confidence: 'High', reason: 'City plan check comments on a building permit submittal.', alts: ['PM Construction', 'Government'] },
    similar: [{ id: 'f12', name: 'Plan Check Response - Rev 2.pdf', differences: 'Rev 2 has the earlier fire-department comments.' }],
  },
  {
    id: 'f02', name: 'Site Walk Photo 014.jpg', type: 'jpg', size: 4.2e6, group: 'G-0102',
    copies: [
      { path: p('Construction & Development', 'Site Photos', 'Site Walk Photo 014.jpg'), modified: '2021-09-14', reportKeep: true },
      { path: p('Graphics & Images', 'Site Walk Photo 014.jpg'), modified: '2021-09-14' },
    ],
    suggestion: { folder: 'Graphics & Images', confidence: 'Medium', reason: 'Construction-era site photo with no clear topic in the file name.', alts: ['Construction & Development', 'Property Management'] },
  },
  {
    id: 'f03', name: 'Roof Warranty - 20 Year.pdf', type: 'pdf', size: 1.1e6, group: 'G-0103',
    copies: [
      { path: p('Construction & Development', 'Closeout Binder', 'Closeout Binder', 'Warranty Copies', 'Roof Warranty - 20 Year.pdf'), modified: '2022-01-10', reportKeep: true },
      { path: p('Construction & Development', 'Warranty Letters', 'Roof Warranty - 20 Year.pdf'), modified: '2022-01-12' },
      { path: p('Property Management', 'Roof Docs Sample', 'Roof Warranty - 20 Year.pdf'), modified: '2022-02-01' },
    ],
    suggestion: { folder: 'Bldg Information & Measurements', confidence: 'High', reason: 'Rule: Warranties → Bldg Information & Measurements.', alts: ['Construction & Development', 'Property Management'], rule: 'Warranties → Bldg Information & Measurements' },
    reportNote: 'Same warranty also attached to the close-out binder.',
  },
  {
    id: 'f04', name: 'Lobby Walkthrough.mp4', type: 'mp4', size: 312e6,
    copies: [{ path: p('Construction & Development', 'Site Photos', 'Lobby Walkthrough.mp4'), modified: '2022-05-03' }],
    suggestion: { folder: 'Graphics & Images', confidence: 'Low', reason: 'Video with no project or topic in the name.', alts: ['Construction & Development', 'Leasing & Marketing'] },
  },
  {
    id: 'f05', name: 'Pay App 07 - Schedule of Values.xlsx', type: 'xlsx', size: 380e3, group: 'G-0105',
    copies: [
      { path: p('Construction & Development', 'General Contractor', 'Pay Applications', 'Pay App 07 - Schedule of Values.xlsx'), modified: '2021-07-30', reportKeep: true },
      { path: p('Accounting', 'Pay App 07 - Schedule of Values.xlsx'), modified: '2021-08-02' },
    ],
    suggestion: { folder: 'Accounting', confidence: 'Medium', reason: 'Rule: Invoices and pay applications → Accounting.', alts: ['Construction & Development', 'Contracts'], rule: 'Invoices and pay applications → Accounting' },
  },
  {
    id: 'f06', name: 'Door Hardware Schedule.csv', type: 'csv', size: 42e3,
    copies: [{ path: p('Construction & Development', 'General Contractor', 'Submittal Log', 'Door Hardware Schedule.csv'), modified: '2021-04-22' }],
    suggestion: { folder: 'Construction & Development', confidence: 'Medium', reason: 'Contractor submittal schedule from the construction phase.', alts: ['Bldg Information & Measurements', 'Property Management'] },
    twin: { name: 'Door Hardware Schedule.csv', path: p('Property Management', 'Hardware Sched Copies', 'Door Hardware Schedule.csv'), tier: 'Tier 1 · near-certain' },
  },
  {
    id: 'f07', name: 'Lease LOI - Retail Suite A.docx', type: 'docx', size: 96e3,
    copies: [{ path: p('Leasing & Marketing', 'Letters of Intent', 'Lease LOI - Retail Suite A.docx'), modified: '2023-03-09' }],
    suggestion: { folder: 'Leasing & Marketing', confidence: 'High', reason: 'Letter of intent for a retail lease.', alts: ['Tenants', 'Legal'] },
  },
  {
    id: 'f08', name: 'Certificate of Insurance - GC.pdf', type: 'pdf', size: 210e3, group: 'G-0108',
    copies: [
      { path: p('Construction & Development', 'General Contractor', 'Certificate of Insurance - GC.pdf'), modified: '2021-01-15', reportKeep: true },
      { path: p('Contracts', 'Certificate of Insurance - GC.pdf'), modified: '2021-01-15' },
    ],
    suggestion: { folder: 'Insurance', confidence: 'High', reason: 'Rule: Certificates of insurance → Insurance.', alts: ['Contracts', 'Construction & Development'], rule: 'Certificates of insurance → Insurance' },
    reportNote: 'Filed under PM Construction on the S drive.',
  },
  {
    id: 'f09', name: 'Phase I ESA Report.pdf', type: 'pdf', size: 8.8e6, group: 'G-0109',
    copies: [
      { path: p('Acquisition', 'DD Materials', 'Phase I ESA Report.pdf'), modified: '2019-06-11', reportKeep: true },
      { path: p('Environmental', 'Phase I ESA Report.pdf'), modified: '2019-06-11' },
    ],
    suggestion: { folder: 'Environmental', confidence: 'High', reason: 'Phase I environmental site assessment.', alts: ['Acquisition', 'Physical Reports'] },
  },
  {
    id: 'f10', name: 'Field Set - As-Built Drawings.pdf', type: 'pdf', size: 24e6, group: 'G-0110',
    copies: [
      { path: p('Construction & Development', 'Record Set Copies', 'Field Set - As-Built Drawings.pdf'), modified: '2022-03-02', reportKeep: true },
      { path: p('Bldg Information & Measurements', 'Field Set - As-Built Drawings.pdf'), modified: '2022-03-02' },
      { path: p('Construction & Development', 'Closeout Binder', 'Field Set - As-Built Drawings.pdf'), modified: '2022-02-27' },
      { path: p('Reports', 'Field Set - As-Built Drawings.pdf'), modified: '2022-02-20' },
    ],
    suggestion: { folder: 'Bldg Information & Measurements', confidence: 'High', reason: 'As-built drawings describe the finished building.', alts: ['Construction & Development', 'Reports'] },
  },
  {
    id: 'f11', name: 'Title Policy - Final.pdf', type: 'pdf', size: 1.6e6,
    copies: [{ path: p('Acquisition', 'Title Policy - Final.pdf'), modified: '2019-08-30' }],
    suggestion: { folder: 'Title', confidence: 'High', reason: 'Final owner’s title insurance policy.', alts: ['Acquisition', 'Legal'] },
  },
  {
    id: 'f12', name: 'Plan Check Response - Rev 2.pdf', type: 'pdf', size: 2.2e6,
    copies: [{ path: p('Construction & Development', 'City Comments', 'Plan Check Response - Rev 2.pdf'), modified: '2021-01-28' }],
    suggestion: { folder: 'Permits_License Agreements', confidence: 'Medium', reason: 'Earlier revision of the city plan check response.', alts: ['Construction & Development', 'Government'] },
    similar: [{ id: 'f01', name: 'Plan Check Response - Rev 3.pdf', differences: 'Rev 2 has the earlier fire-department comments.' }],
  },
  {
    id: 'f13', name: 'Level 2 Floor Plan.pdf', type: 'pdf', size: 3.1e6,
    copies: [{ path: p('Old Plans Sample', 'Level 2 Floor Plan.pdf'), modified: '2020-11-04' }],
    suggestion: { folder: 'Bldg Information & Measurements', confidence: 'Medium', reason: 'Floor plan of an existing level.', alts: ['Construction & Development', 'Leasing & Marketing'] },
  },
  {
    id: 'f14', name: 'GC Change Order 12.pdf', type: 'pdf', size: 640e3,
    copies: [{ path: p('Construction & Development', 'General Contractor', 'CO Log', 'GC Change Order 12.pdf'), modified: '2021-10-19' }],
    suggestion: { folder: 'Construction & Development', confidence: 'High', reason: 'General contractor change order.', alts: ['Contracts', 'Accounting'] },
  },
  {
    id: 'f15', name: 'GC Change Order 13.pdf', type: 'pdf', size: 655e3,
    copies: [{ path: p('Construction & Development', 'General Contractor', 'CO Log', 'GC Change Order 13.pdf'), modified: '2021-11-02' }],
    suggestion: { folder: 'Construction & Development', confidence: 'High', reason: 'General contractor change order.', alts: ['Contracts', 'Accounting'] },
  },
  // Excluded folder: never shown, counted or planned.
  {
    id: 'x01', name: 'Master Workbook.xlsx', type: 'xlsx', size: 1.2e6,
    copies: [{ path: p('SharePoint', 'Master Workbook.xlsx'), modified: '2024-02-01' }],
    suggestion: { folder: 'Underwriting', confidence: 'Low', reason: '', alts: [] },
  },
  // System file: ignored everywhere.
  {
    id: 'x02', name: '.DS_Store', type: 'other', size: 6e3,
    copies: [{ path: p('Construction & Development', '.DS_Store'), modified: '2024-02-01' }],
    suggestion: { folder: 'Construction & Development', confidence: 'Low', reason: '', alts: [] },
  },
];
