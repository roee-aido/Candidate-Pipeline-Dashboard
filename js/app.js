/* Candidate Pipeline Dashboard
 * Plain JavaScript, no dependencies. Data is kept in localStorage.
 */

// ---------- Constants ----------

const STORAGE_KEY = 'candidatePipeline.leads.v1';

// Status keys are stable identifiers; labels are what the user sees.
const STATUSES = [
  { key: 'new',        label: 'ליד חדש' },
  { key: 'contacted',  label: 'נוצר קשר' },
  { key: 'called',     label: 'שיחה התקיימה' },
  { key: 'followup',   label: 'Follow-up' },
  { key: 'meeting',    label: 'פגישה נקבעה' },
  { key: 'hesitant',   label: 'מתלבט' },
  { key: 'irrelevant', label: 'לא רלוונטי' },
  { key: 'closed',     label: 'נסגר בהצלחה' },
];

const INTEREST_LEVELS = [
  { key: 'high',    label: 'גבוהה' },
  { key: 'medium',  label: 'בינונית' },
  { key: 'low',     label: 'נמוכה' },
  { key: 'unknown', label: 'לא ידוע' },
];

const SOURCES = ['פייסבוק', 'אינסטגרם', 'LinkedIn', 'אתר', 'הפניה', 'וובינר', 'טלפון נכנס'];

// Statuses counted as "in progress" in the summary cards.
const IN_PROGRESS_STATUSES = ['contacted', 'called', 'followup', 'hesitant'];

// Leads in these statuses no longer need a follow-up.
const FINISHED_STATUSES = ['closed', 'irrelevant'];

// ---------- State ----------

let leads = [];

// ---------- Date helpers ----------
// Dates are stored as "YYYY-MM-DD" strings, so they compare correctly as strings.

function toISODate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function todayISO() {
  return toISODate(new Date());
}

function daysFromToday(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return toISODate(d);
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// Returns 'overdue' | 'today' | 'upcoming' | 'none'
function followUpState(lead) {
  if (!lead.followUpDate) return 'none';
  const today = todayISO();
  if (lead.followUpDate < today) return 'overdue';
  if (lead.followUpDate === today) return 'today';
  return 'upcoming';
}

// A lead needs attention when its follow-up is today or overdue and it is still open.
function needsFollowUp(lead) {
  if (FINISHED_STATUSES.includes(lead.status)) return false;
  const state = followUpState(lead);
  return state === 'overdue' || state === 'today';
}

// ---------- Sample data (section 11) ----------
// All names and details are fictional. Dates are relative to the first run,
// so there are always overdue / today / upcoming follow-ups to demonstrate.

function createSampleLeads() {
  const rows = [
    ['נועה ברקת',   '050-1234567', 'noa.b@example.com',    'פייסבוק',    'new',        'unknown', null, 0,    'שיחת היכרות ראשונה', 'השאירה פרטים בטופס באתר'],
    ['איתי שמעוני', '052-2345678', 'itay.s@example.com',   'LinkedIn',   'contacted',  'medium',  -3,   2,    'לשלוח סילבוס',        'ביקש פרטים על מועדי הקורס'],
    ['מיכל אדרי',   '054-3456789', 'michal.a@example.com', 'הפניה',      'called',     'high',    -1,   1,    'לשלוח הצעת מחיר',     'מעוניינת במסלול ערב'],
    ['יונתן רז',    '053-4567890', 'yonatan.r@example.com','וובינר',     'followup',   'medium',  -8,   -3,   'להתקשר שוב',          'לא ענה בפעם הקודמת'],
    ['שירה לוינסון','050-5678901', 'shira.l@example.com',  'אינסטגרם',   'meeting',    'high',    -2,   3,    'פגישת ייעוץ בזום',    'מגיעה עם בן הזוג'],
    ['עומר גולן',   '058-6789012', 'omer.g@example.com',   'אתר',        'hesitant',   'medium',  -5,   -1,   'לחזור עם תשובה לגבי מימון', 'מתלבט בגלל המחיר'],
    ['דנה פרידמן',  '052-7890123', 'dana.f@example.com',   'הפניה',      'closed',     'high',    -4,   null, 'לשלוח טופס הרשמה',    'נרשמה למחזור הקרוב'],
    ['אלון מזרחי',  '054-8901234', 'alon.m@example.com',   'פייסבוק',    'followup',   'low',     -14,  -7,   'Follow-up אחרון',     'ביקש שנחזור אליו אחרי החגים'],
    ['רוני כהן-טל', '050-9012345', 'roni.ct@example.com',  'טלפון נכנס', 'called',     'high',    0,    0,    'לתאם פגישה',          'שיחה טובה, נשמעה מאוד מעוניינת'],
    ['גיל אברהמי',  '053-0123456', 'gil.a@example.com',    'וובינר',     'irrelevant', 'low',     -10,  null, '',                    'מחפש קורס בתחום אחר'],
    ['תמר שגיא',    '058-1122334', 'tamar.s@example.com',  'LinkedIn',   'new',        'unknown', null, 1,    'לשלוח הודעת היכרות',  ''],
    ['בן ישראלי',   '052-2233445', 'ben.y@example.com',    'אתר',        'hesitant',   'medium',  -6,   5,    'לשלוח המלצות בוגרים', 'רוצה לדבר עם בוגר של התוכנית'],
  ];

  return rows.map(([name, phone, email, source, status, interest, lastCall, followUp, nextAction, notes]) => ({
    id: generateId(),
    name,
    phone,
    email,
    source,
    status,
    interest,
    lastCallDate: lastCall === null ? '' : daysFromToday(lastCall),
    followUpDate: followUp === null ? '' : daysFromToday(followUp),
    nextAction,
    notes,
  }));
}

// ---------- Storage (section 12) ----------

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function loadLeads() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw);
  } catch (err) {
    console.warn('Could not read saved leads, loading sample data instead.', err);
  }
  const sample = createSampleLeads();
  saveLeads(sample);
  return sample;
}

function saveLeads(list = leads) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    alert('לא ניתן לשמור את הנתונים בדפדפן.');
    console.error(err);
  }
}

// ---------- Lookups & escaping ----------

function labelOf(list, key) {
  const item = list.find((x) => x.key === key);
  return item ? item.label : '';
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- DOM references ----------

const $ = (id) => document.getElementById(id);

const els = {
  body: $('leadsBody'),
  emptyState: $('emptyState'),
  resultsCount: $('resultsCount'),
  search: $('searchInput'),
  statusFilter: $('statusFilter'),
  interestFilter: $('interestFilter'),
  followUpFilter: $('followUpFilter'),
  dialog: $('leadDialog'),
  form: $('leadForm'),
  dialogTitle: $('dialogTitle'),
  fields: {
    id: $('leadId'),
    name: $('fName'),
    phone: $('fPhone'),
    email: $('fEmail'),
    source: $('fSource'),
    status: $('fStatus'),
    interest: $('fInterest'),
    lastCallDate: $('fLastCall'),
    followUpDate: $('fFollowUp'),
    nextAction: $('fNextAction'),
    notes: $('fNotes'),
  },
};

// ---------- Rendering ----------

function fillSelect(select, items, allLabel) {
  const options = items.map((i) => `<option value="${i.key}">${escapeHTML(i.label)}</option>`).join('');
  select.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : '') + options;
}

function renderSummary() {
  const count = (fn) => leads.filter(fn).length;
  $('statTotal').textContent = leads.length;
  $('statNew').textContent = count((l) => l.status === 'new');
  $('statInProgress').textContent = count((l) => IN_PROGRESS_STATUSES.includes(l.status));
  $('statFollowUp').textContent = count(needsFollowUp);
  $('statMeeting').textContent = count((l) => l.status === 'meeting');
  $('statClosed').textContent = count((l) => l.status === 'closed');

  // Show how many duplicates exist on the button itself.
  const duplicates = findDuplicateIds().length;
  $('removeDuplicatesBtn').textContent = duplicates ? `הסרת כפילויות (${duplicates})` : 'הסרת כפילויות';
}

function getFilteredLeads() {
  const query = els.search.value.trim().toLowerCase();
  const queryDigits = query.replace(/\D/g, '');
  const status = els.statusFilter.value;
  const interest = els.interestFilter.value;
  const followUp = els.followUpFilter.value;

  return leads.filter((lead) => {
    if (query) {
      const inName = (lead.name || '').toLowerCase().includes(query);
      const inEmail = (lead.email || '').toLowerCase().includes(query);
      // Phone matches by digits, so "0501234" finds "050-1234567".
      const inPhone = queryDigits !== '' && (lead.phone || '').replace(/\D/g, '').includes(queryDigits);
      if (!inName && !inEmail && !inPhone) return false;
    }
    if (status === 'inProgress') {
      if (!IN_PROGRESS_STATUSES.includes(lead.status)) return false;
    } else if (status && lead.status !== status) {
      return false;
    }
    if (interest && lead.interest !== interest) return false;
    if (followUp) {
      // "Due", "overdue" and "today" only include open leads, matching the table highlight.
      const isUrgentFilter = ['due', 'overdue', 'today'].includes(followUp);
      if (isUrgentFilter && !needsFollowUp(lead)) return false;
      if (followUp !== 'due' && followUpState(lead) !== followUp) {
        return false;
      }
    }
    return true;
  });
}

// Most urgent first: overdue → today → upcoming → no date. Finished leads go last.
function sortByUrgency(list) {
  const rank = { overdue: 0, today: 1, upcoming: 2, none: 3 };
  return [...list].sort((a, b) => {
    const aDone = FINISHED_STATUSES.includes(a.status) ? 1 : 0;
    const bDone = FINISHED_STATUSES.includes(b.status) ? 1 : 0;
    if (aDone !== bDone) return aDone - bDone;
    const r = rank[followUpState(a)] - rank[followUpState(b)];
    if (r !== 0) return r;
    return (a.followUpDate || '9999').localeCompare(b.followUpDate || '9999');
  });
}

function renderFollowUpCell(lead) {
  if (!lead.followUpDate) return '<span class="muted">—</span>';
  const date = formatDate(lead.followUpDate);
  if (FINISHED_STATUSES.includes(lead.status)) return `<span class="muted">${date}</span>`;

  const state = followUpState(lead);
  if (state === 'overdue') return `<span class="fu fu-overdue" title="Follow-up באיחור">${date}<small>באיחור</small></span>`;
  if (state === 'today') return `<span class="fu fu-today" title="Follow-up היום">${date}<small>היום</small></span>`;
  return `<span class="fu">${date}</span>`;
}

function renderRow(lead) {
  const state = needsFollowUp(lead) ? followUpState(lead) : '';
  const phone = lead.phone
    ? `<a href="tel:${escapeHTML(lead.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${escapeHTML(lead.phone)}</a>`
    : '<span class="muted">—</span>';
  const email = lead.email
    ? `<a href="mailto:${escapeHTML(lead.email)}" dir="ltr">${escapeHTML(lead.email)}</a>`
    : '<span class="muted">—</span>';

  return `
    <tr class="${state ? 'row-' + state : ''}">
      <td data-label="שם" class="cell-name">${escapeHTML(lead.name)}</td>
      <td data-label="טלפון">${phone}</td>
      <td data-label="אימייל">${email}</td>
      <td data-label="מקור">${escapeHTML(lead.source) || '<span class="muted">—</span>'}</td>
      <td data-label="סטטוס"><span class="badge status-${lead.status}">${escapeHTML(labelOf(STATUSES, lead.status))}</span></td>
      <td data-label="רמת עניין"><span class="interest interest-${lead.interest}">${escapeHTML(labelOf(INTEREST_LEVELS, lead.interest))}</span></td>
      <td data-label="שיחה אחרונה">${lead.lastCallDate ? formatDate(lead.lastCallDate) : '<span class="muted">—</span>'}</td>
      <td data-label="Follow-up">${renderFollowUpCell(lead)}</td>
      <td data-label="פעולה הבאה" class="cell-next">${escapeHTML(lead.nextAction) || '<span class="muted">—</span>'}</td>
      <td data-label="הערה" class="cell-note" title="${escapeHTML(lead.notes)}">${escapeHTML(lead.notes) || '<span class="muted">—</span>'}</td>
      <td data-label="פעולות" class="cell-actions">
        <button type="button" class="btn btn-small" data-action="edit" data-id="${lead.id}">עריכה</button>
        <button type="button" class="btn btn-small btn-danger" data-action="delete" data-id="${lead.id}">מחיקה</button>
      </td>
    </tr>`;
}

function renderTable() {
  const visible = sortByUrgency(getFilteredLeads());
  els.body.innerHTML = visible.map(renderRow).join('');
  els.emptyState.hidden = visible.length > 0;
  els.resultsCount.textContent = `מוצגים ${visible.length} מתוך ${leads.length} לידים`;
}

function render() {
  renderSummary();
  renderTable();
}

// ---------- Add / edit form ----------

function openForm(lead) {
  els.form.reset();
  const f = els.fields;
  if (lead) {
    els.dialogTitle.textContent = 'עריכת ליד';
    f.id.value = lead.id;
    f.name.value = lead.name || '';
    f.phone.value = lead.phone || '';
    f.email.value = lead.email || '';
    f.source.value = lead.source || '';
    f.status.value = lead.status || 'new';
    f.interest.value = lead.interest || 'unknown';
    f.lastCallDate.value = lead.lastCallDate || '';
    f.followUpDate.value = lead.followUpDate || '';
    f.nextAction.value = lead.nextAction || '';
    f.notes.value = lead.notes || '';
  } else {
    els.dialogTitle.textContent = 'הוספת ליד';
    f.id.value = '';
    f.status.value = 'new';
    f.interest.value = 'unknown';
  }
  els.dialog.showModal();
  f.name.focus();
}

function closeForm() {
  els.dialog.close();
}

function handleSubmit(event) {
  event.preventDefault();
  const f = els.fields;
  const name = f.name.value.trim();
  if (!name) {
    f.name.setCustomValidity('יש להזין שם');
    f.name.reportValidity();
    return;
  }

  const data = {
    name,
    phone: f.phone.value.trim(),
    email: f.email.value.trim(),
    source: f.source.value.trim(),
    status: f.status.value,
    interest: f.interest.value,
    lastCallDate: f.lastCallDate.value,
    followUpDate: f.followUpDate.value,
    nextAction: f.nextAction.value.trim(),
    notes: f.notes.value.trim(),
  };

  const id = f.id.value;
  if (id) {
    leads = leads.map((l) => (l.id === id ? { ...l, ...data } : l));
  } else {
    leads.push({ id: generateId(), ...data });
  }

  saveLeads();
  render();
  closeForm();
}

// ---------- Delete (section 9) ----------

function deleteLead(id) {
  const lead = leads.find((l) => l.id === id);
  if (!lead) return;
  if (!confirm(`למחוק את הליד "${lead.name}"?\nלא ניתן לבטל פעולה זו.`)) return;
  leads = leads.filter((l) => l.id !== id);
  saveLeads();
  render();
}

// ---------- Duplicates ----------
// A duplicate is a lead whose data fields are all identical to an earlier lead
// (the internal id is ignored). The first copy is kept.

const LEAD_FIELDS = ['name', 'phone', 'email', 'source', 'status', 'interest',
  'lastCallDate', 'followUpDate', 'nextAction', 'notes'];

function findDuplicateIds() {
  const seen = new Set();
  const duplicateIds = [];
  for (const lead of leads) {
    const key = JSON.stringify(LEAD_FIELDS.map((f) => String(lead[f] ?? '').trim()));
    if (seen.has(key)) duplicateIds.push(lead.id);
    else seen.add(key);
  }
  return duplicateIds;
}

function removeDuplicates() {
  const ids = new Set(findDuplicateIds());
  if (ids.size === 0) {
    alert('לא נמצאו כפילויות.\nאין לידים שכל הפרטים שלהם זהים.');
    return;
  }

  const found = ids.size === 1 ? 'נמצא ליד כפול אחד' : `נמצאו ${ids.size} לידים כפולים`;
  if (!confirm(`${found} (כל הפרטים זהים לליד אחר).\nמכל קבוצה יישאר ליד אחד, והעותקים הנוספים יימחקו.\nלא ניתן לבטל פעולה זו. להמשיך?`)) return;

  leads = leads.filter((l) => !ids.has(l.id));
  saveLeads();
  render();
  alert(ids.size === 1 ? 'ליד כפול אחד הוסר.' : `הוסרו ${ids.size} לידים כפולים.`);
}

// ---------- Filters ----------

function clearFilters() {
  els.search.value = '';
  els.statusFilter.value = '';
  els.interestFilter.value = '';
  els.followUpFilter.value = '';
  renderTable();
}

// Clicking a summary card applies the matching filter.
function applyCardFilter(card) {
  clearFilters();
  const statusByCard = { new: 'new', inProgress: 'inProgress', meeting: 'meeting', closed: 'closed' };
  if (card === 'followUp') els.followUpFilter.value = 'due';
  else if (statusByCard[card]) els.statusFilter.value = statusByCard[card];
  renderTable();
}

// ---------- CSV import / export ----------
// Generic parsing/writing lives in csv.js; this section maps leads to/from CSV rows.

// Column order and Hebrew headers for export. "aliases" are extra header names
// accepted on import (e.g. English field names).
const CSV_COLUMNS = [
  { field: 'name',         header: 'שם',               aliases: ['name', 'שם מלא'] },
  { field: 'phone',        header: 'טלפון',            aliases: ['phone', 'נייד'] },
  { field: 'email',        header: 'אימייל',           aliases: ['email', 'דוא"ל', 'מייל'] },
  { field: 'source',       header: 'מקור הליד',        aliases: ['source', 'מקור'] },
  { field: 'status',       header: 'סטטוס',            aliases: ['status'] },
  { field: 'interest',     header: 'רמת עניין',        aliases: ['interest'] },
  { field: 'lastCallDate', header: 'תאריך שיחה אחרונה', aliases: ['lastCallDate', 'שיחה אחרונה'] },
  { field: 'followUpDate', header: 'תאריך Follow-up',  aliases: ['followUpDate', 'Follow-up', 'Follow-up הבא'] },
  { field: 'nextAction',   header: 'פעולה הבאה',       aliases: ['nextAction'] },
  { field: 'notes',        header: 'הערות',            aliases: ['notes', 'הערה', 'הערה קצרה'] },
];

const MAX_IMPORT_BYTES = 2 * 1024 * 1024; // 2MB is far more than a lead list needs

const normalizeHeader = (text) => text.trim().replace(/\s+/g, ' ').toLowerCase();

function exportCSV() {
  if (leads.length === 0) {
    alert('אין לידים לייצוא.');
    return;
  }

  const header = CSV_COLUMNS.map((c) => c.header);
  const rows = leads.map((lead) =>
    CSV_COLUMNS.map(({ field }) => {
      if (field === 'status') return labelOf(STATUSES, lead.status);
      if (field === 'interest') return labelOf(INTEREST_LEVELS, lead.interest);
      return lead[field] || '';
    })
  );

  // The BOM (﻿) tells Excel the file is UTF-8, so Hebrew displays correctly.
  const blob = new Blob(['﻿' + toCSV([header, ...rows])], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `leads-${todayISO()}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Accepts YYYY-MM-DD, or D/M/YYYY and D.M.YYYY (Israeli day-first order, as Excel often saves).
// Returns an ISO date, '' for an empty cell, or null if the value is not a valid date.
function parseDateCell(text) {
  const value = text.trim();
  if (!value) return '';
  let y, m, d;
  let match = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    [, y, m, d] = match.map(Number);
  } else if ((match = value.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2}|\d{4})$/))) {
    [, d, m, y] = match.map(Number);
    if (y < 100) y += 2000;
  } else {
    return null;
  }
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return toISODate(date);
}

// Finds a status / interest key by its Hebrew label or its internal key.
function matchOption(list, text) {
  const value = normalizeHeader(text);
  const item = list.find((x) => normalizeHeader(x.label) === value || x.key === value);
  return item ? item.key : null;
}

// Validates parsed CSV rows and converts them to leads.
// Returns { error } when the file structure is invalid, otherwise
// { leads, skipped, warnings, ignoredColumns }.
function buildLeadsFromRows(rows) {
  if (rows.length === 0) return { error: 'הקובץ ריק.' };

  // Map each known field to its column index in the file.
  const headerCells = rows[0].map((h) => normalizeHeader(unprotectCell(h)));
  const columnIndex = {};
  const ignoredColumns = [];
  headerCells.forEach((cell, index) => {
    const column = CSV_COLUMNS.find((c) =>
      [c.header, ...c.aliases].some((name) => normalizeHeader(name) === cell)
    );
    if (column && !(column.field in columnIndex)) columnIndex[column.field] = index;
    else if (cell) ignoredColumns.push(rows[0][index].trim());
  });

  if (!('name' in columnIndex)) {
    return {
      error: 'לא נמצאה עמודת "שם" בשורה הראשונה של הקובץ.\n' +
             'השורה הראשונה צריכה להכיל כותרות עמודות, לפחות "שם".\n' +
             'מומלץ להשתמש בקובץ שיוצא מהמערכת כתבנית.',
    };
  }
  if (rows.length < 2) return { error: 'בקובץ אין שורות נתונים מתחת לשורת הכותרות.' };

  const imported = [];
  const skipped = [];
  const warnings = [];

  rows.slice(1).forEach((row, i) => {
    const rowNumber = i + 2; // +1 for the header, +1 for 1-based numbering
    const cell = (field) =>
      field in columnIndex ? unprotectCell((row[columnIndex[field]] ?? '').trim()) : '';

    const name = cell('name');
    if (!name) {
      skipped.push(rowNumber);
      return;
    }

    let status = 'new';
    if (cell('status')) {
      status = matchOption(STATUSES, cell('status'));
      if (!status) {
        warnings.push(`שורה ${rowNumber}: סטטוס לא מוכר "${cell('status')}", הוגדר "ליד חדש"`);
        status = 'new';
      }
    }

    let interest = 'unknown';
    if (cell('interest')) {
      interest = matchOption(INTEREST_LEVELS, cell('interest'));
      if (!interest) {
        warnings.push(`שורה ${rowNumber}: רמת עניין לא מוכרת "${cell('interest')}", הוגדר "לא ידוע"`);
        interest = 'unknown';
      }
    }

    const dates = {};
    for (const field of ['lastCallDate', 'followUpDate']) {
      const parsed = parseDateCell(cell(field));
      if (parsed === null) {
        warnings.push(`שורה ${rowNumber}: תאריך לא תקין "${cell(field)}", השדה נשאר ריק`);
      }
      dates[field] = parsed || '';
    }

    imported.push({
      id: generateId(),
      name,
      phone: cell('phone'),
      email: cell('email'),
      source: cell('source'),
      status,
      interest,
      lastCallDate: dates.lastCallDate,
      followUpDate: dates.followUpDate,
      nextAction: cell('nextAction'),
      notes: cell('notes'),
    });
  });

  return { leads: imported, skipped, warnings, ignoredColumns };
}

async function importCSV(file) {
  if (!file) return;

  if (!/\.csv$/i.test(file.name)) {
    alert('הקובץ שנבחר אינו קובץ CSV.\nיש לבחור קובץ עם סיומת .csv');
    return;
  }
  if (file.size > MAX_IMPORT_BYTES) {
    alert('הקובץ גדול מדי לייבוא (מעל 2MB).');
    return;
  }

  let result;
  try {
    result = buildLeadsFromRows(parseCSV(await file.text()));
  } catch (err) {
    console.error(err);
    alert('לא ניתן לקרוא את הקובץ. ודאו שזהו קובץ CSV תקין בקידוד UTF-8.');
    return;
  }

  if (result.error) {
    alert('הקובץ אינו תקין ולא יובא.\n\n' + result.error);
    return;
  }
  if (result.leads.length === 0) {
    alert('לא נמצאו בקובץ לידים עם שם. אף ליד לא יובא.');
    return;
  }

  // Confirmation summary before anything is saved.
  const lines = [result.leads.length === 1 ? 'נמצא ליד אחד לייבוא.' : `נמצאו ${result.leads.length} לידים לייבוא.`];
  if (result.skipped.length) {
    const rowList = result.skipped.slice(0, 10).join(', ') + (result.skipped.length > 10 ? '…' : '');
    lines.push(result.skipped.length === 1
      ? `שורה אחת ללא שם תדולג (שורה ${rowList}).`
      : `${result.skipped.length} שורות ללא שם ידולגו (שורות: ${rowList}).`);
  }
  if (result.ignoredColumns.length) {
    lines.push(`עמודות שלא זוהו ולא ייובאו: ${result.ignoredColumns.join(', ')}`);
  }
  if (result.warnings.length) {
    lines.push('', 'הערות:', ...result.warnings.slice(0, 5));
    if (result.warnings.length > 5) lines.push(`ועוד ${result.warnings.length - 5} הערות נוספות.`);
  }
  lines.push('', 'הלידים יתווספו ללידים הקיימים (הקיימים לא יימחקו). להמשיך?');

  if (!confirm(lines.join('\n'))) return;

  leads.push(...result.leads);
  saveLeads();
  clearFilters(); // make sure the new leads are visible
  render();
  alert(result.leads.length === 1 ? 'ליד אחד יובא בהצלחה.' : `יובאו ${result.leads.length} לידים בהצלחה.`);
}

// ---------- Init ----------

function init() {
  // Status filter includes an extra "in progress" group to match the summary card.
  fillSelect(els.statusFilter, [...STATUSES, { key: 'inProgress', label: 'בתהליך (כל שלבי הביניים)' }], 'כל הסטטוסים');
  fillSelect(els.interestFilter, INTEREST_LEVELS, 'כל הרמות');
  fillSelect(els.fields.status, STATUSES);
  fillSelect(els.fields.interest, INTEREST_LEVELS);
  $('sourceOptions').innerHTML = SOURCES.map((s) => `<option value="${escapeHTML(s)}">`).join('');

  leads = loadLeads();
  render();

  $('addLeadBtn').addEventListener('click', () => openForm(null));
  $('cancelBtn').addEventListener('click', closeForm);
  els.form.addEventListener('submit', handleSubmit);
  els.fields.name.addEventListener('input', () => els.fields.name.setCustomValidity(''));

  // Close the dialog when clicking the backdrop.
  els.dialog.addEventListener('click', (e) => {
    if (e.target === els.dialog) closeForm();
  });

  // Edit / delete buttons (event delegation on the table body).
  els.body.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const id = btn.dataset.id;
    if (btn.dataset.action === 'edit') openForm(leads.find((l) => l.id === id));
    if (btn.dataset.action === 'delete') deleteLead(id);
  });

  [els.search, els.statusFilter, els.interestFilter, els.followUpFilter].forEach((el) =>
    el.addEventListener('input', renderTable)
  );
  $('clearFiltersBtn').addEventListener('click', clearFilters);

  document.querySelectorAll('.card[data-card]').forEach((card) =>
    card.addEventListener('click', () => applyCardFilter(card.dataset.card))
  );

  // CSV: the visible button opens the hidden file input.
  $('removeDuplicatesBtn').addEventListener('click', removeDuplicates);
  $('exportCsvBtn').addEventListener('click', exportCSV);
  $('importCsvBtn').addEventListener('click', () => $('importCsvInput').click());
  $('importCsvInput').addEventListener('change', async (e) => {
    await importCSV(e.target.files[0]);
    e.target.value = ''; // allow selecting the same file again
  });

  $('resetDataBtn').addEventListener('click', () => {
    if (!confirm('לאפס את כל הנתונים ולטעון מחדש את נתוני הדוגמה?\nכל השינויים שביצעת יימחקו.')) return;
    leads = createSampleLeads();
    saveLeads();
    clearFilters();
    render();
  });
}

init();
