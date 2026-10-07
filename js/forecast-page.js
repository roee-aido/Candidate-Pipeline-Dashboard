/* "תחזית ים": hourly wave forecast for three beaches, from the Open-Meteo Marine Weather API.
 * The API is free for non-commercial use, needs no key and allows browser requests (CORS),
 * so this page calls it directly and works on GitHub Pages without the Python server.
 * Docs: https://open-meteo.com/en/docs/marine-weather-api  Licence: CC BY 4.0 (credit in the footer).
 */

const API_URL = 'https://marine-api.open-meteo.com/v1/marine';
const DOCS_URL = 'https://open-meteo.com/en/docs/marine-weather-api';
const TIME_ZONE = 'Asia/Jerusalem';
const HOURS = 48;
const REQUEST_TIMEOUT_MS = 15000;
const LOCATION_KEY = 'candidatePipeline.forecastLocation';

// Points at sea about 2–3 km west of each beach. The wave model has ~8 km cells, so a point on the
// beach itself falls in a land cell with no data; cell_selection=sea makes the API use the nearest
// sea cell, whose centre is returned in the response and shown on the page.
const LOCATIONS = {
  hadera:  { name: 'חדרה',    area: 'מול חוף חדרה',       lat: 32.470, lon: 34.850 },
  netanya: { name: 'נתניה',   area: 'מול חופי נתניה',      lat: 32.330, lon: 34.825 },
  telaviv: { name: 'תל אביב', area: 'מול חופי תל אביב',    lat: 32.085, lon: 34.745 },
};

const $ = (id) => document.getElementById(id);

let currentKey = null;
let requestSeq = 0;        // increases with every request; only the latest one may update the page
let controller = null;     // aborts the previous request when the location changes
let lastData = null;       // { key, data, fetchedAt } of the response currently shown

// ---------- Helpers ----------

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
// Rounds half up for display (toFixed alone shows 5.05 as "5.0" because of binary fractions).
const fixed = (v, digits) => (Math.round(v * 10 ** digits) / 10 ** digits).toFixed(digits);
const NO_DATA = '<span class="muted">אין נתון</span>';

// The API returns local times ("2026-10-07T20:00") plus the zone's UTC offset; turn them into real instants
// so they can be formatted in Asia/Jerusalem whatever the viewer's own time zone is.
function toInstant(localIso, utcOffsetSeconds) {
  const [date, time] = localIso.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - utcOffsetSeconds * 1000);
}

const fmtHour = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtDayHour = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const fmtFetched = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'medium' });
const fmtDay = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, weekday: 'short' });

// Wave direction is where the waves come FROM (0° = from the north).
const COMPASS = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// Distance in km between two coordinates (to show how far the model cell is from the requested point).
function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function buildUrl(loc) {
  const params = new URLSearchParams({
    latitude: loc.lat,
    longitude: loc.lon,
    hourly: 'wave_height,wave_direction,wave_period',
    timezone: TIME_ZONE,
    forecast_hours: HOURS,
    cell_selection: 'sea',
    length_unit: 'metric',
  });
  return `${API_URL}?${params}`;
}

// ---------- Data ----------

// Checks the response shape and turns it into rows. A missing value stays null (never 0).
function parseResponse(data) {
  const h = data?.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.wave_height) || !Array.isArray(h.wave_direction) || !Array.isArray(h.wave_period)) {
    throw new Error('UNEXPECTED_SHAPE');
  }
  const offset = isNum(data.utc_offset_seconds) ? data.utc_offset_seconds : 0;
  const rows = h.time.map((t, i) => ({
    time: toInstant(t, offset),
    height: isNum(h.wave_height[i]) ? h.wave_height[i] : null,
    direction: isNum(h.wave_direction[i]) ? h.wave_direction[i] : null,
    period: isNum(h.wave_period[i]) ? h.wave_period[i] : null,
  }));
  return { rows, units: data.hourly_units || {}, gridLat: data.latitude, gridLon: data.longitude };
}

async function load(key, { refresh = false } = {}) {
  const loc = LOCATIONS[key];
  currentKey = key;
  const seq = ++requestSeq;
  controller?.abort();
  const myController = new AbortController();
  controller = myController;
  // The timer aborts only this request (never a newer one started after it).
  const timer = setTimeout(() => myController.abort('timeout'), REQUEST_TIMEOUT_MS);
  const mySignal = myController.signal;

  // A different location never shows the previous location's data while loading.
  if (!refresh || lastData?.key !== key) lastData = null;
  renderControls();
  renderStatus({ state: 'loading', loc, refresh });
  if (!lastData) renderContent(null);

  try {
    const res = await fetch(buildUrl(loc), { signal: mySignal, cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (seq !== requestSeq) return; // a newer request started meanwhile: ignore this answer
    if (!res.ok) {
      throw Object.assign(new Error('HTTP'), { status: res.status, reason: body?.reason });
    }
    const parsed = parseResponse(body);
    lastData = { key, ...parsed, fetchedAt: new Date() };
    renderContent(lastData);
    const missing = parsed.rows.filter((r) => r.height === null).length;
    if (parsed.rows.length === 0 || missing === parsed.rows.length) {
      renderStatus({ state: 'empty', loc });
    } else if (missing > 0) {
      renderStatus({ state: 'partial', loc, missing, total: parsed.rows.length });
    } else {
      renderStatus(null);
    }
  } catch (err) {
    if (seq !== requestSeq) return; // superseded by a newer request (aborted on purpose)
    lastData = refresh && lastData?.key === key ? lastData : null;
    renderStatus({ state: 'error', loc, message: describeError(err, mySignal) });
  } finally {
    clearTimeout(timer);
    if (seq === requestSeq) renderControls(false);
  }
}

function describeError(err, signal) {
  if (signal.aborted && signal.reason === 'timeout') return 'Open-Meteo לא הגיב בזמן (15 שניות). נסו לרענן.';
  if (err.message === 'HTTP') {
    const reason = String(err.reason || '').replace(/\.+$/, ''); // the API's reason already ends with a period
    return `Open-Meteo החזיר שגיאה (${err.status})${reason ? `: ${reason}` : ''}.`;
  }
  if (err.message === 'UNEXPECTED_SHAPE') return 'התקבלה תשובה לא צפויה מ-Open-Meteo, ולכן הנתונים לא מוצגים.';
  if (err instanceof TypeError) return 'אין חיבור ל-Open-Meteo. בדקו את החיבור לאינטרנט ונסו לרענן.';
  return 'שליפת התחזית נכשלה. נסו לרענן.';
}

// ---------- Rendering ----------

function renderControls(busy = true) {
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    const active = btn.dataset.loc === currentKey;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  const refresh = $('refreshBtn');
  refresh.disabled = busy;
  refresh.textContent = busy ? 'טוען…' : 'רענון';
}

function renderStatus(status) {
  const box = $('forecastStatus');
  if (!status) { box.innerHTML = ''; return; }
  if (status.state === 'loading') {
    box.innerHTML = `<div class="notice notice-info" role="status"><span class="spinner" aria-hidden="true"></span>
      ${status.refresh ? 'מרענן' : 'טוען'} את התחזית ל${escapeHTML(status.loc.name)} מ-Open-Meteo…</div>`;
  } else if (status.state === 'error') {
    box.innerHTML = `<p class="notice notice-error" role="alert">${escapeHTML(status.message)}</p>`;
  } else if (status.state === 'empty') {
    box.innerHTML = `<p class="notice notice-warn" role="status">Open-Meteo החזיר תשובה, אבל אין בה נתוני גובה גלים ל${escapeHTML(status.loc.name)} ב-48 השעות הקרובות.</p>`;
  } else if (status.state === 'partial') {
    box.innerHTML = `<p class="notice notice-warn" role="status">ב-${status.missing} מתוך ${status.total} השעות אין נתון לגובה גלים. הן מסומנות "אין נתון" ומופיעות כרווח בגרף, לא כאפס.</p>`;
  }
}

function card(label, valueHtml, sub) {
  return `<div class="metric"><span class="metric-label">${label}</span><span class="metric-value">${valueHtml}</span>${sub ? `<span class="metric-sub">${sub}</span>` : ''}</div>`;
}

function directionHtml(deg) {
  if (!isNum(deg)) return NO_DATA;
  // The arrow points where the waves travel to (opposite of where they come from).
  return `<span class="dir-arrow" style="transform: rotate(${(deg + 180) % 360}deg)" aria-hidden="true">↑</span>${Math.round(deg)}°`;
}

function renderCards(view) {
  const now = view.rows[0];
  const withHeight = view.rows.filter((r) => r.height !== null);
  const peak = withHeight.reduce((max, r) => (max === null || r.height > max.height ? r : max), null);
  return `
    <div class="metrics">
      ${card('גובה גלים עכשיו', now && now.height !== null ? `${now.height.toFixed(2)} <small>מ'</small>` : NO_DATA, now ? `לשעה ${fmtHour.format(now.time)}` : '')}
      ${card('כיוון גלים', directionHtml(now?.direction), now && now.direction !== null ? `מגיעים מ${compass(now.direction)} (החץ: כיוון התנועה)` : '')}
      ${card('מחזור גלים', now && now.period !== null ? `${fixed(now.period, 1)} <small>שניות</small>` : NO_DATA, 'הזמן בין גל לגל')}
      ${card('שיא ב-48 השעות', peak ? `${peak.height.toFixed(2)} <small>מ'</small>` : NO_DATA, peak ? fmtDayHour.format(peak.time) : '')}
    </div>`;
}

// SVG line chart of wave height. Missing hours break the line (a gap), they are never drawn as 0.
function renderChart(view) {
  // Drawn at the container's real width so the axis text keeps its size on phones.
  const W = Math.max(300, Math.min(1400, ($('forecastContent').clientWidth || 720) - 14));
  const narrow = W < 480;
  const H = narrow ? 220 : 260, padL = 40, padR = 10, padT = 14, padB = 40;
  const labelEvery = narrow ? 12 : 6;
  const rows = view.rows;
  const heights = rows.map((r) => r.height).filter((v) => v !== null);
  if (rows.length < 2 || heights.length === 0) return '';
  const yMax = Math.max(0.5, Math.ceil(Math.max(...heights) * 1.25 * 2) / 2);
  const x = (i) => padL + (i * (W - padL - padR)) / (rows.length - 1);
  const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);

  // Line segments between missing values
  const segments = [];
  let current = [];
  rows.forEach((r, i) => {
    if (r.height === null) { if (current.length) segments.push(current); current = []; }
    else current.push([x(i), y(r.height)]);
  });
  if (current.length) segments.push(current);
  const line = segments.map((s) => (s.length === 1 ? `M${s[0][0]},${s[0][1]}h0.01` : `M${s.map((p) => p.join(',')).join('L')}`)).join(' ');
  const area = segments.filter((s) => s.length > 1).map((s) => `M${s[0][0]},${y(0)}L${s.map((p) => p.join(',')).join('L')}L${s[s.length - 1][0]},${y(0)}Z`).join(' ');

  // Y grid every 0.5 m (or 0.25 m for calm seas)
  const step = yMax <= 1 ? 0.25 : 0.5;
  let grid = '';
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
             <text x="${padL - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v.toFixed(step < 0.5 ? 2 : 1)}</text>`;
  }
  // X labels every 6 hours, with the weekday at midnight
  let xLabels = '';
  rows.forEach((r, i) => {
    const hour = Number(fmtHour.format(r.time).slice(0, 2));
    if (hour % labelEvery === 0) {
      xLabels += `<line x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${H - padB}" class="grid grid-v"/>
                  <text x="${x(i)}" y="${H - padB + 16}" class="axis" text-anchor="middle">${fmtHour.format(r.time)}</text>
                  ${hour === 0 ? `<text x="${x(i)}" y="${H - padB + 31}" class="axis axis-day" text-anchor="middle">${fmtDay.format(r.time)}</text>` : ''}`;
    }
  });
  // Invisible hover targets with a tooltip for every hour
  const hover = rows.map((r, i) => `<rect x="${x(i) - (W - padL - padR) / (rows.length - 1) / 2}" y="${padT}" width="${(W - padL - padR) / (rows.length - 1)}" height="${H - padT - padB}" class="hover"><title>${fmtDayHour.format(r.time)} · ${r.height !== null ? `${r.height.toFixed(2)} מ'` : 'אין נתון'}</title></rect>`).join('');
  const points = rows.map((r, i) => (r.height !== null ? `<circle cx="${x(i)}" cy="${y(r.height)}" r="2.2" class="pt"/>` : '')).join('');

  return `
    <figure class="chart">
      <figcaption>גובה גלים משמעותי (מטרים) לפי שעה, אזור זמן ישראל</figcaption>
      <div class="chart-box" dir="ltr">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="גרף גובה גלים ל-48 השעות הקרובות">
          ${grid}${xLabels}
          <path d="${area}" class="area"/>
          <path d="${line}" class="line"/>
          ${points}${hover}
          <text x="${padL}" y="${padT - 3}" class="axis" text-anchor="start">מ'</text>
        </svg>
      </div>
    </figure>`;
}

function renderTable(view) {
  const rows = view.rows.map((r) => `
    <tr>
      <td>${fmtDayHour.format(r.time)}</td>
      <td>${r.height !== null ? r.height.toFixed(2) : NO_DATA}</td>
      <td>${r.direction !== null ? `${Math.round(r.direction)}° (${compass(r.direction)})` : NO_DATA}</td>
      <td>${r.period !== null ? fixed(r.period, 1) : NO_DATA}</td>
    </tr>`).join('');
  return `
    <details class="hourly">
      <summary>טבלה שעתית (${view.rows.length} שעות)</summary>
      <div class="table-wrap">
        <table class="hourly-table">
          <thead><tr><th>שעה</th><th>גובה גלים (מ')</th><th>כיוון הגעה (°)</th><th>מחזור (שניות)</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </details>`;
}

function renderContent(view) {
  const loc = LOCATIONS[currentKey];
  const head = `
    <div class="forecast-head">
      <h2>${escapeHTML(loc.name)} <span class="muted forecast-area">${escapeHTML(loc.area)}</span></h2>
      <p class="forecast-meta">
        נקודה מבוקשת בים: <span dir="ltr">${loc.lat.toFixed(3)}°N, ${loc.lon.toFixed(3)}°E</span>
        ${view && isNum(view.gridLat) ? `· תא המודל שבו השתמש ה-API: <span dir="ltr">${view.gridLat.toFixed(3)}°N, ${view.gridLon.toFixed(3)}°E</span> (כ-${distanceKm(loc.lat, loc.lon, view.gridLat, view.gridLon).toFixed(1)} ק"מ ממנה)` : ''}
        <br>מקור: <a href="${DOCS_URL}" target="_blank" rel="noopener">Open-Meteo Marine Weather API</a>
        · <a href="https://open-meteo.com/" target="_blank" rel="noopener" class="credit" dir="ltr">Weather data by Open-Meteo.com</a>
        ${view ? `· נשלף לאחרונה: <span id="fetchedAt">${fmtFetched.format(view.fetchedAt)}</span>` : ''}
        · הזמנים לפי אזור הזמן Asia/Jerusalem
      </p>
    </div>`;
  $('forecastContent').innerHTML = view ? head + renderCards(view) + renderChart(view) + renderTable(view) : head;
}

// ---------- Start ----------

function selectLocation(key) {
  if (!LOCATIONS[key]) return;
  try { localStorage.setItem(LOCATION_KEY, key); } catch { /* storage may be unavailable */ }
  history.replaceState(null, '', `#${key}`);
  load(key);
}

document.querySelectorAll('.seg-btn').forEach((btn) => btn.addEventListener('click', () => {
  if (btn.dataset.loc !== currentKey) selectLocation(btn.dataset.loc);
}));
$('refreshBtn').addEventListener('click', () => load(currentKey, { refresh: true }));

// Redraw at the new width when the window size changes (e.g. rotating a phone).
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastData?.key === currentKey) renderContent(lastData); }, 200);
});

(function start() {
  let saved = null;
  try { saved = localStorage.getItem(LOCATION_KEY); } catch { /* ignore */ }
  const fromHash = location.hash.slice(1);
  selectLocation(LOCATIONS[fromHash] ? fromHash : LOCATIONS[saved] ? saved : 'telaviv');
})();
