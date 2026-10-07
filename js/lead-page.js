/* Lead details page and "מידע מהרשת" (public Instagram data via Apify).
 * Opened from the leads table through the URL hash #lead/<id>. Uses state and helpers from app.js.
 *
 * Imported web data is stored separately from the lead's own fields (ENRICH_KEY in localStorage),
 * keyed by lead id, so a Sync from Airtable does not erase it and never mixes it into the lead.
 * Paid Apify runs go through the local server (server.py), which holds the Apify token.
 */

const ENRICH_KEY = 'candidatePipeline.enrichment.v1';

let enrichment = loadEnrichment(); // { [leadId]: { profileUrl, import: {...} } }
const panelState = {};             // per lead id, not saved: { state, message, results, query, run }
let currentLeadId = null;
let serverStatus = null;           // result of /api/health, or { ok: false }

function loadEnrichment() {
  try {
    return JSON.parse(localStorage.getItem(ENRICH_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveEnrichment() {
  storageSet(ENRICH_KEY, JSON.stringify(enrichment));
}

// ---------- Small helpers ----------

const safeUrl = (url) => (/^https?:\/\//i.test(url || '') ? url : '');
const formatUsd = (n) => (typeof n === 'number' ? `$${n.toFixed(4)}` : '—');
const formatCount = (n) => (typeof n === 'number' ? n.toLocaleString('he-IL') : '—');
const formatDateTime = (iso) => (iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');

// Apify records the charge a few seconds after a run ends; the server says whether it was confirmed.
function runCostText(run) {
  if (!run) return '';
  if (run.costConfirmed === false) {
    return `העלות הסופית עוד לא נרשמה ב-Apify (צפויה: ${formatUsd(run.expectedCostUsd)})`;
  }
  // Runs saved before the cost fix may hold 0 even though the charge was confirmed.
  const cost = run.costUsd || (run.costConfirmed ? run.expectedCostUsd : run.costUsd);
  const events = run.chargedEvents ?? run.results;
  const eventsText = typeof events !== 'number' ? '' : events === 1 ? ' (חיוב אחד)' : ` (${events} חיובים)`;
  return `עלות ההרצה לפי Apify: ${formatUsd(cost)}${eventsText}`;
}

// Accepts "@name", "name" or an instagram.com link. Returns the username, or null if invalid.
// (server.py applies the same rules again before any paid run.)
function instagramUsername(value) {
  let v = (value || '').trim();
  if (/instagram\.com/i.test(v)) {
    try {
      const url = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`);
      if (!/(^|\.)instagram\.com$/i.test(url.hostname)) return null;
      v = url.pathname.split('/').filter(Boolean)[0] || '';
      if (['p', 'reel', 'reels', 'explore', 'stories', 'accounts', 'tv', 'direct', 'about'].includes(v.toLowerCase())) return null;
    } catch {
      return null;
    }
  }
  v = v.replace(/^@/, '');
  return /^[A-Za-z0-9._]{1,30}$/.test(v) ? v : null;
}

const profileLink = (username) => `https://www.instagram.com/${username}/`;

// ---------- Local server (Apify proxy) ----------

async function checkServer(force = false) {
  if (serverStatus && !force) return serverStatus;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch('/api/health', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    const data = res.ok ? await res.json() : null;
    serverStatus = data && data.ok ? data : { ok: false };
  } catch {
    serverStatus = { ok: false };
  }
  if (currentLeadId) renderLeadView();
  return serverStatus;
}

async function apiRequest(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? { cache: 'no-store' } : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('השרת המקומי לא מגיב. ודאו ש-python server.py רץ ונסו שוב.');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `השרת החזיר שגיאה (${res.status}).`);
  return data;
}

// ---------- Routing ----------

function routeLeadId() {
  const match = location.hash.match(/^#lead\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function showRoute() {
  currentLeadId = routeLeadId();
  $('dashboardView').hidden = Boolean(currentLeadId);
  $('leadView').hidden = !currentLeadId;
  if (currentLeadId) {
    renderLeadView();
    window.scrollTo(0, 0);
    checkServer();
  }
}

// ---------- Rendering ----------

function detailRow(label, valueHtml) {
  return `<div class="detail"><dt>${label}</dt><dd>${valueHtml || '<span class="muted">—</span>'}</dd></div>`;
}

function renderLeadDetails(lead) {
  const fromAirtable = isAirtableId(lead.id);
  const lastSync = storageGet(LAST_SYNC_KEY);
  const sourceNote = fromAirtable
    ? `פרטי הליד מ-Airtable, כפי שנשמרו בדפדפן בסנכרון האחרון${lastSync ? ` (${formatDateTime(lastSync)})` : ''}. עריכה כאן נשמרת בדפדפן בלבד ולא מעדכנת את Airtable.`
    : 'ליד מקומי: קיים בדפדפן הזה בלבד ולא ב-Airtable. Sync מ-Airtable ימחק אותו.';
  const phone = lead.phone ? `<a href="tel:${escapeHTML(lead.phone.replace(/[^\d+]/g, ''))}" dir="ltr">${escapeHTML(lead.phone)}</a>` : '';
  const email = lead.email ? `<a href="mailto:${escapeHTML(lead.email)}" dir="ltr">${escapeHTML(lead.email)}</a>` : '';

  return `
    <section class="panel">
      <div class="panel-head">
        <div class="lead-title">
          <h2>${escapeHTML(lead.name)}</h2>
          <span class="badge status-${lead.status}">${escapeHTML(labelOf(STATUSES, lead.status))}</span>
          <span class="chip">${fromAirtable ? 'מקור: Airtable' : 'מקור: מקומי'}</span>
          ${lead.editedLocally ? '<span class="local-tag inline">נערך מקומית</span>' : ''}
        </div>
        <button type="button" class="btn btn-ghost" data-action="edit">עריכת פרטים</button>
      </div>
      <p class="panel-sub">${sourceNote}</p>
      <dl class="details-grid">
        ${detailRow('טלפון', phone)}
        ${detailRow('אימייל', email)}
        ${detailRow('מקור הליד', escapeHTML(lead.source))}
        ${detailRow('רמת עניין', `<span class="interest interest-${lead.interest}">${escapeHTML(labelOf(INTEREST_LEVELS, lead.interest))}</span>`)}
        ${detailRow('תאריך שיחה אחרונה', lead.lastCallDate ? formatDate(lead.lastCallDate) : '')}
        ${detailRow('Follow-up הבא', lead.followUpDate ? renderFollowUpCell(lead) : '')}
        ${detailRow('פעולה הבאה', escapeHTML(lead.nextAction))}
        <div class="detail detail-wide"><dt>הערות</dt><dd class="pre">${escapeHTML(lead.notes) || '<span class="muted">—</span>'}</dd></div>
      </dl>
    </section>`;
}

function renderServerNotice() {
  if (serverStatus === null) return '<p class="notice">בודק אם השרת המקומי פועל…</p>';
  if (!serverStatus.ok) {
    return `<p class="notice notice-warn">ייבוא מהרשת זמין רק כשהדשבורד פתוח דרך השרת המקומי (<code dir="ltr">python server.py</code>, ואז <span dir="ltr">http://localhost:8000</span>).
      כרגע הדף נפתח ממקום אחר (למשל GitHub Pages או קובץ מקומי), ולכן הייבוא לא זמין.</p>`;
  }
  if (!serverStatus.apifyConfigured) {
    return '<p class="notice notice-warn">השרת המקומי פועל, אבל לא הוגדר בו טוקן של Apify. הוסיפו <code dir="ltr">APIFY_TOKEN</code> לקובץ <code dir="ltr">.env</code> והפעילו את השרת מחדש.</p>';
  }
  return '';
}

function renderPanelState(state) {
  if (!state) return '';
  if (state.state === 'loading') {
    return `<div class="notice notice-info" role="status"><span class="spinner" aria-hidden="true"></span>
      ${state.mode === 'search' ? 'מחפש פרופילים ב-Instagram' : 'מייבא את הפרופיל'} באמצעות Apify… זה לוקח בדרך כלל 10–60 שניות.</div>`;
  }
  const runInfo = state.run ? ` ${runCostText(state.run)}.` : '';
  if (state.state === 'success') return `<p class="notice notice-success" role="status">${escapeHTML(state.message)}${runInfo}</p>`;
  if (state.state === 'no_results') return `<p class="notice notice-warn" role="status">${escapeHTML(state.message)}${runInfo}</p>`;
  if (state.state === 'error') return `<p class="notice notice-error" role="alert">${escapeHTML(state.message)}</p>`;
  if (state.state === 'results') {
    const cards = state.results.map((p, i) => `
      <li class="result-card">
        ${renderAvatar(p)}
        <div class="result-main">
          <div class="result-name">${escapeHTML(p.fullName || p.username)}
            ${p.verified ? '<span class="chip chip-verified">מאומת</span>' : ''}
            ${p.private ? '<span class="chip">פרטי</span>' : ''}</div>
          <a href="${escapeHTML(profileLink(p.username))}" target="_blank" rel="noopener" dir="ltr">@${escapeHTML(p.username)}</a>
          <span class="muted"> · ${formatCount(p.followersCount)} עוקבים</span>
          ${p.biography ? `<p class="result-bio">${escapeHTML(p.biography)}</p>` : ''}
        </div>
        <button type="button" class="btn btn-small" data-action="choose" data-index="${i}">זה המועמד, שיוך לליד</button>
      </li>`).join('');
    return `
      <div class="search-results">
        <p class="notice notice-warn">נמצאו ${state.results.length} פרופילים לחיפוש "${escapeHTML(state.query)}".${runInfo}
          <strong>שם זהה לא מוכיח שזה אותו אדם.</strong> פתחו את הפרופיל ובדקו שזה המועמד לפני השיוך. אם אף אחד לא מתאים, אל תשייכו.</p>
        <ul class="result-list">${cards}</ul>
        <button type="button" class="btn btn-ghost btn-small" data-action="dismiss-results">אף פרופיל לא מתאים, סגירת התוצאות</button>
      </div>`;
  }
  return '';
}

function renderAvatar(p) {
  const src = safeUrl(p.profilePicUrl);
  // Instagram image links expire after a while, so a broken image is simply hidden.
  return src ? `<img class="avatar" src="${escapeHTML(src)}" alt="" referrerpolicy="no-referrer" loading="lazy" onerror="this.remove()">` : '';
}

// `data` is the saved import; `savedProfileUrl` is the lead's currently saved link (it may point elsewhere).
function renderImported(lead, data, savedProfileUrl) {
  const p = data.profile;
  const savedUser = savedProfileUrl ? instagramUsername(savedProfileUrl) : null;
  const mismatch = savedUser && savedUser.toLowerCase() !== p.username.toLowerCase();
  const nameDiffers = p.fullName && p.fullName.trim() !== lead.name.trim();
  const how = data.via === 'search' ? `חיפוש לפי השם "${escapeHTML(data.query)}" ובחירה ידנית` : 'קישור לפרופיל שנשמר';

  return `
    <div class="imported">
      <div class="imported-head">
        ${renderAvatar(p)}
        <div>
          <h3>${escapeHTML(p.fullName || p.username)}</h3>
          <a href="${escapeHTML(profileLink(p.username))}" target="_blank" rel="noopener" dir="ltr">@${escapeHTML(p.username)}</a>
          ${p.verified ? '<span class="chip chip-verified">מאומת</span>' : ''}
          ${p.private ? '<span class="chip">חשבון פרטי</span>' : ''}
        </div>
      </div>
      ${mismatch ? `<p class="notice notice-warn">המידע שיובא שייך ל-@${escapeHTML(p.username)}, אבל הקישור השמור הוא ל-@${escapeHTML(savedUser)}. ייבוא מחדש יחליף אותו במידע מהקישור השמור, אם הפרופיל יימצא.</p>` : ''}
      <dl class="details-grid">
        <div class="detail detail-wide"><dt>ביוגרפיה</dt><dd class="pre">${escapeHTML(p.biography) || '<span class="muted">—</span>'}</dd></div>
        ${detailRow('קישור בפרופיל', safeUrl(p.externalUrl) ? `<a href="${escapeHTML(p.externalUrl)}" target="_blank" rel="noopener" dir="ltr">${escapeHTML(p.externalUrl)}</a>` : '')}
        ${detailRow('עוקבים', formatCount(p.followersCount))}
        ${detailRow('נעקבים', formatCount(p.followsCount))}
        ${detailRow('פוסטים', formatCount(p.postsCount))}
        ${detailRow('חשבון עסקי', p.isBusinessAccount ? `כן${p.businessCategoryName ? ` (${escapeHTML(p.businessCategoryName)})` : ''}` : 'לא')}
      </dl>
      <p class="imported-meta">
        מקור: <a href="${escapeHTML(profileLink(p.username))}" target="_blank" rel="noopener" dir="ltr">${escapeHTML(profileLink(p.username))}</a><br>
        יובא ב-${formatDateTime(data.importedAt)} באמצעות Apify (Instagram), דרך ${how}.
        ${data.run ? `${runCostText(data.run)}. <a href="${escapeHTML(safeUrl(data.run.consoleUrl))}" target="_blank" rel="noopener">פרטי ההרצה ב-Apify</a>` : ''}
      </p>
      <div class="apply-box">
        <p class="muted">המידע מוצג בנפרד ולא משנה את פרטי הליד. לשימוש בו בפרטי הליד צריך לבחור במפורש:</p>
        ${nameDiffers ? `<button type="button" class="btn btn-small" data-action="apply-name">החלפת שם הליד ל-"${escapeHTML(p.fullName)}"</button>` : ''}
        ${p.biography ? '<button type="button" class="btn btn-small" data-action="append-notes">הוספת הביוגרפיה והקישור להערות</button>' : ''}
        <button type="button" class="btn btn-small btn-danger" data-action="remove-import">הסרת המידע שיובא</button>
      </div>
    </div>`;
}

function renderWebPanel(lead) {
  const data = enrichment[lead.id] || {};
  const state = panelState[lead.id];
  const busy = state?.state === 'loading';
  const ready = serverStatus?.ok && serverStatus.apifyConfigured;
  const savedUser = data.profileUrl ? instagramUsername(data.profileUrl) : null;

  const plan = savedUser
    ? `הייבוא ירוץ על הפרופיל השמור <a href="${escapeHTML(profileLink(savedUser))}" target="_blank" rel="noopener" dir="ltr">@${escapeHTML(savedUser)}</a>.`
    : `אין קישור שמור, ולכן הייבוא יחפש פרופילים לפי שם ויציג את ההתאמות לבחירה.
       <label class="inline-field">שם לחיפוש: <input type="text" id="webSearchQuery" value="${escapeHTML(lead.name)}" maxlength="60"></label>`;

  return `
    <section class="panel web-panel">
      <div class="panel-head">
        <h2>מידע מהרשת</h2>
        <span class="chip">Instagram · Apify</span>
      </div>
      <p class="panel-sub">מידע ציבורי מפרופיל Instagram של הליד. הוא מיובא רק בלחיצה על הכפתור, נשמר בדפדפן הזה בנפרד מפרטי הליד, ולא נשלח ל-Airtable.</p>
      ${renderServerNotice()}

      <form class="link-form" data-action="save-link">
        <label for="profileUrlInput">קישור לפרופיל Instagram של הליד</label>
        <div class="link-row">
          <input type="text" id="profileUrlInput" dir="ltr" placeholder="https://www.instagram.com/username/" value="${escapeHTML(data.profileUrl || '')}" maxlength="200">
          <button type="submit" class="btn btn-ghost">שמירת קישור</button>
          ${data.profileUrl ? '<button type="button" class="btn btn-ghost" data-action="clear-link">הסרת קישור</button>' : ''}
        </div>
      </form>

      <div class="import-row">
        <p class="import-plan">${plan}</p>
        <button type="button" class="btn btn-primary" data-action="import" ${busy || !ready ? 'disabled' : ''}>${busy ? 'מייבא…' : 'ייבוא באמצעות Apify'}</button>
      </div>

      ${renderPanelState(state)}
      ${data.import ? renderImported(lead, data.import, data.profileUrl) : (state ? '' : '<p class="muted empty-web">עדיין לא יובא מידע מהרשת לליד הזה.</p>')}
    </section>`;
}

function renderLeadView() {
  const view = $('leadView');
  const lead = leads.find((l) => l.id === currentLeadId);
  const back = '<a href="#" class="btn btn-ghost back-btn">→ חזרה לדשבורד</a>';
  if (!lead) {
    view.innerHTML = `<div class="lead-page">${back}<p class="notice notice-warn">הליד לא נמצא. ייתכן שהוא נמחק, או שהנתונים הוחלפו בסנכרון מ-Airtable.</p></div>`;
    return;
  }
  // Keep what the user typed in the search field across re-renders.
  const typedQuery = $('webSearchQuery')?.value;
  view.innerHTML = `<div class="lead-page">${back}${renderLeadDetails(lead)}${renderWebPanel(lead)}</div>`;
  if (typedQuery !== undefined && $('webSearchQuery')) $('webSearchQuery').value = typedQuery;
}

// ---------- Actions ----------

async function saveProfileLink(lead) {
  const value = $('profileUrlInput').value.trim();
  const username = instagramUsername(value);
  if (!username) {
    await showMessage('הקישור לא תקין.\nהזינו קישור לפרופיל, למשל https://www.instagram.com/username/, או שם משתמש.');
    return;
  }
  const data = enrichment[lead.id] || (enrichment[lead.id] = {});
  data.profileUrl = profileLink(username);
  saveEnrichment();
  renderLeadView();
}

async function clearProfileLink(lead) {
  if (!(await askConfirm('להסיר את הקישור השמור לפרופיל?\nהמידע שכבר יובא יישאר.', 'הסרה'))) return;
  delete enrichment[lead.id].profileUrl;
  saveEnrichment();
  renderLeadView();
}

async function startImport(lead) {
  const data = enrichment[lead.id] || {};
  const username = data.profileUrl ? instagramUsername(data.profileUrl) : null;
  const mode = username ? 'profile' : 'search';
  const query = mode === 'search' ? ($('webSearchQuery')?.value || '').trim() : '';
  if (mode === 'search' && query.length < 2) {
    await showMessage('יש להזין לפחות 2 תווים בשדה "שם לחיפוש".');
    return;
  }

  const health = await checkServer(true);
  if (!health.ok || !health.apifyConfigured) return; // the notice in the panel explains why

  // Show the expected cost (read live from Apify) and ask before any paid run.
  let est;
  try {
    est = await apiRequest(`/api/apify/estimate?mode=${mode}`);
  } catch (err) {
    panelState[lead.id] = { state: 'error', message: err.message };
    renderLeadView();
    return;
  }
  const what = mode === 'profile'
    ? `ייבוא הפרופיל @${username} מ-Instagram`
    : `חיפוש פרופילים ב-Instagram לפי השם "${query}" (עד ${est.maxResults} תוצאות)`;
  const cost = est.estimatedMaxUsd !== null
    ? `עלות צפויה: עד ${formatUsd(est.estimatedMaxUsd)} (${est.maxResults} × ${formatUsd(est.pricePerResultUsd)} לתוצאה).`
    : `לא ניתן לחשב עלות מדויקת (מודל תמחור: ${est.pricingModel}).`;
  const text = [
    `${what}, באמצעות ${est.actorTitle} ב-Apify.`,
    '',
    'זו הרצה בתשלום, שתחויב בחשבון Apify שלכם.',
    cost,
    `תקרת חיוב קשיחה להרצה: ${formatUsd(est.hardCapUsd)}. Apify יעצור את ההרצה לפני שתעבור את הסכום הזה.`,
    ...(mode === 'search' ? ['', 'התוצאות יוצגו לבחירה. שום מידע לא ישויך לליד בלי בחירה שלכם.'] : []),
    '',
    'להריץ?',
  ].join('\n');
  if (!(await askConfirm(text, 'הרצה בתשלום'))) return;

  panelState[lead.id] = { state: 'loading', mode };
  renderLeadView();
  try {
    if (mode === 'profile') {
      const res = await apiRequest('/api/apify/instagram/profile', { profile: username });
      if (res.status === 'ok') {
        const entry = enrichment[lead.id] || (enrichment[lead.id] = {});
        entry.import = { source: 'instagram', via: 'profile', profile: res.profile, importedAt: res.importedAt, run: res.run };
        saveEnrichment();
        panelState[lead.id] = { state: 'success', message: `הפרופיל @${res.profile.username} יובא בהצלחה.`, run: res.run };
      } else {
        panelState[lead.id] = { state: 'no_results', message: `לא נמצא פרופיל ציבורי בשם @${res.username}. ייתכן שהקישור שגוי, שהחשבון פרטי או שהוא נמחק. גם חיפוש שלא מצא פרופיל מחויב ב-Apify.`, run: res.run };
      }
    } else {
      const res = await apiRequest('/api/apify/instagram/search', { query });
      panelState[lead.id] = res.status === 'ok'
        ? { state: 'results', results: res.results, query: res.query, run: res.run, importedAt: res.importedAt }
        : { state: 'no_results', message: `החיפוש "${res.query}" לא החזיר פרופילים ציבוריים. נסו שם אחר, או הזינו קישור לפרופיל.`, run: res.run };
    }
  } catch (err) {
    panelState[lead.id] = { state: 'error', message: err.message };
  }
  if (currentLeadId === lead.id) renderLeadView();
}

async function chooseResult(lead, index) {
  const state = panelState[lead.id];
  const p = state?.results?.[index];
  if (!p) return;
  const ok = await askConfirm(
    `לשייך את הפרופיל @${p.username}${p.fullName ? ` (${p.fullName})` : ''} לליד "${lead.name}"?\n\nודאו שזה אכן המועמד. שם זהה לא מוכיח שזה אותו אדם.\nהקישור יישמר לליד, והמידע יוצג בנפרד מפרטי הליד.`,
    'שיוך לליד',
  );
  if (!ok) return;
  const entry = enrichment[lead.id] || (enrichment[lead.id] = {});
  entry.profileUrl = profileLink(p.username);
  entry.import = { source: 'instagram', via: 'search', query: state.query, profile: p, importedAt: state.importedAt, run: state.run };
  saveEnrichment();
  panelState[lead.id] = { state: 'success', message: `הפרופיל @${p.username} שויך לליד.` };
  renderLeadView();
}

// Changes to the lead's own fields happen only here, after an explicit choice and confirmation.
async function applyToLead(lead, kind) {
  const p = enrichment[lead.id]?.import?.profile;
  if (!p) return;
  let changes;
  let text;
  if (kind === 'name') {
    changes = { name: p.fullName.trim() };
    text = `להחליף את שם הליד?\n\nכרגע: ${lead.name}\nחדש: ${changes.name}`;
  } else {
    const addition = `[Instagram @${p.username}] ${p.biography}${p.externalUrl ? `\n${p.externalUrl}` : ''}`;
    changes = { notes: lead.notes ? `${lead.notes}\n\n${addition}` : addition };
    text = `להוסיף להערות של הליד את הטקסט הבא?\n\n${addition}\n\nההערות הקיימות יישארו.`;
  }
  if (isAirtableId(lead.id)) text += '\n\nהשינוי נשמר בדפדפן בלבד. Sync מ-Airtable יחליף אותו.';
  if (!(await askConfirm(text, 'עדכון פרטי הליד'))) return;
  leads = leads.map((l) => (l.id === lead.id ? { ...l, ...changes, editedLocally: isAirtableId(l.id) || undefined } : l));
  saveLeads();
  render();
}

async function removeImport(lead) {
  if (!(await askConfirm('להסיר את המידע שיובא מהרשת לליד הזה?\nהקישור לפרופיל יישאר שמור.', 'הסרה'))) return;
  delete enrichment[lead.id].import;
  delete panelState[lead.id];
  saveEnrichment();
  renderLeadView();
}

// ---------- Events ----------

$('leadView').addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  const lead = leads.find((l) => l.id === currentLeadId);
  if (!el || !lead || el.tagName === 'FORM') return;
  const action = el.dataset.action;
  if (action === 'edit') openForm(lead);
  if (action === 'clear-link') clearProfileLink(lead);
  if (action === 'import') startImport(lead);
  if (action === 'choose') chooseResult(lead, Number(el.dataset.index));
  if (action === 'dismiss-results') { delete panelState[lead.id]; renderLeadView(); }
  if (action === 'apply-name') applyToLead(lead, 'name');
  if (action === 'append-notes') applyToLead(lead, 'notes');
  if (action === 'remove-import') removeImport(lead);
});

$('leadView').addEventListener('submit', (e) => {
  e.preventDefault();
  const lead = leads.find((l) => l.id === currentLeadId);
  if (lead && e.target.dataset.action === 'save-link') saveProfileLink(lead);
});

window.addEventListener('hashchange', showRoute);
renderHooks.push(() => { if (currentLeadId) renderLeadView(); });
showRoute();
