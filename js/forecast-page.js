/* "תחזית ים": hourly wave forecast for three beaches, from the Open-Meteo Marine Weather API.
 * The API is free for non-commercial use, needs no key and allows browser requests (CORS),
 * so this page calls it directly and works on GitHub Pages without the Python server.
 * Docs: https://open-meteo.com/en/docs/marine-weather-api  Licence: CC BY 4.0 (credit in the footer).
 *
 * Two views: the next 48 hours (default), or one chosen day (00:00–23:00, Asia/Jerusalem).
 */

const API_URL = 'https://marine-api.open-meteo.com/v1/marine';
const DOCS_URL = 'https://open-meteo.com/en/docs/marine-weather-api';
const TIME_ZONE = 'Asia/Jerusalem';
const HOURS = 48;
const REQUEST_TIMEOUT_MS = 15000;
const LOCATION_KEY = 'candidatePipeline.forecastLocation';

// Days that can be chosen: today and the next 9 days (10 days in total).
// Checked against the real API on 7.10.2026: all three points had full hourly data from today to
// today+9; the API accepts dates up to today+15, but from today+10 the values are empty (null).
// (The documentation itself says "up to 8 days".) Past dates are not offered: they are not a forecast.
const FORECAST_DAYS = 10;

// Points at sea about 2 km west of each beach. The wave model has ~8 km cells, so a point on the
// beach itself falls in a land cell with no data; cell_selection=sea makes the API use the nearest
// sea cell, whose centre is returned in the response and shown on the page.
const LOCATIONS = {
  hadera:  { name: 'חדרה',    area: 'מול חוף חדרה',       lat: 32.470, lon: 34.850 },
  netanya: { name: 'נתניה',   area: 'מול חופי נתניה',      lat: 32.330, lon: 34.825 },
  telaviv: { name: 'תל אביב', area: 'מול חופי תל אביב',    lat: 32.085, lon: 34.745 },
};

const $ = (id) => document.getElementById(id);

// The current selection. Its id ties every response to the selection it was requested for.
const sel = { key: null, mode: 'next48', date: null };
const selId = (s = sel) => `${s.key}|${s.mode}|${s.mode === 'date' ? s.date : ''}`;

let requestSeq = 0;        // increases with every request; only the latest one may update the page
let controller = null;     // aborts the previous request when the selection changes
let lastData = null;       // { sel: selId, rows, gridLat, gridLon, fetchedAt } currently shown

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

// ---------- Dates and times (all in Asia/Jerusalem) ----------
// The API returns local Israel times as text ("2026-10-07T20:00"). They are shown as they are, with no
// conversion through UTC, so a range that crosses a daylight-saving change still shows the right hours.

const partsFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
});

// The current hour in Israel, in the API's format: "2026-10-07T20:00".
function nowLocalHour() {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
}
const todayLocal = () => nowLocalHour().slice(0, 10);

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function dateRange() {
  const min = todayLocal();
  return { min, max: addDays(min, FORECAST_DAYS - 1) };
}
const isValidDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && addDays(s, 0) === s;
const inRange = (s) => { const { min, max } = dateRange(); return isValidDate(s) && s >= min && s <= max; };

// Noon UTC of a calendar date always falls on the same date in Israel, so it is safe for formatting.
const noonUtc = (isoDate) => { const [y, m, d] = isoDate.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)); };
const fmtWeekdayShort = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, weekday: 'short' });
const fmtLongDate = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const fmtFetched = new Intl.DateTimeFormat('he-IL', { timeZone: TIME_ZONE, dateStyle: 'short', timeStyle: 'medium' });

const hourOf = (local) => local.slice(11, 16);                                   // "20:00"
const shortDate = (isoDate) => `${Number(isoDate.slice(8, 10))}.${Number(isoDate.slice(5, 7))}`; // "7.10"
const dayLabel = (isoDate) => `${fmtWeekdayShort.format(noonUtc(isoDate))}, ${shortDate(isoDate)}`; // "יום ד׳, 7.10"
const dayHourLabel = (local) => `${dayLabel(local.slice(0, 10))}, ${hourOf(local)}`;
const longDate = (isoDate) => fmtLongDate.format(noonUtc(isoDate));               // "יום חמישי, 8 באוקטובר 2026"

// Wave direction is where the waves come FROM (0° = from the north).
const COMPASS = ['צפון', 'צפון-מזרח', 'מזרח', 'דרום-מזרח', 'דרום', 'דרום-מערב', 'מערב', 'צפון-מערב'];
const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

// Average of directions as vectors (the plain average of 350° and 10° would wrongly be 180°).
function meanDirection(degrees) {
  if (!degrees.length) return null;
  const rad = Math.PI / 180;
  const sx = degrees.reduce((s, d) => s + Math.sin(d * rad), 0);
  const cy = degrees.reduce((s, d) => s + Math.cos(d * rad), 0);
  return ((Math.atan2(sx, cy) / rad) + 360) % 360;
}

// Distance in km between two coordinates (to show how far the model cell is from the requested point).
function distanceKm(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * rad / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin((lon2 - lon1) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}

function buildUrl(loc, s = sel) {
  const params = new URLSearchParams({
    latitude: loc.lat,
    longitude: loc.lon,
    hourly: 'wave_height,wave_direction,wave_period',
    timezone: TIME_ZONE,
    cell_selection: 'sea',
    length_unit: 'metric',
  });
  if (s.mode === 'date') {
    params.set('start_date', s.date);
    params.set('end_date', s.date);
  } else {
    params.set('forecast_hours', HOURS);
  }
  return `${API_URL}?${params}`;
}

// ---------- Data ----------

// Checks the response shape and turns it into rows. A missing value stays null (never 0).
function parseResponse(data) {
  const h = data?.hourly;
  if (!h || !Array.isArray(h.time) || !Array.isArray(h.wave_height) || !Array.isArray(h.wave_direction) || !Array.isArray(h.wave_period)) {
    throw new Error('UNEXPECTED_SHAPE');
  }
  const rows = h.time.map((t, i) => ({
    local: t,
    height: isNum(h.wave_height[i]) ? h.wave_height[i] : null,
    direction: isNum(h.wave_direction[i]) ? h.wave_direction[i] : null,
    period: isNum(h.wave_period[i]) ? h.wave_period[i] : null,
  }));
  return { rows, gridLat: data.latitude, gridLon: data.longitude };
}

async function load({ refresh = false } = {}) {
  const loc = LOCATIONS[sel.key];
  const mySel = { ...sel };
  const id = selId(mySel);
  const seq = ++requestSeq;
  controller?.abort();

  // A different selection never shows the previous selection's data, not even while loading.
  if (!refresh || lastData?.sel !== id) lastData = null;

  // A date outside the supported range is never requested (and past dates are never shown as forecast).
  if (mySel.mode === 'date' && !inRange(mySel.date)) {
    controller = null;
    renderControls(false);
    renderContent(null);
    const { min, max } = dateRange();
    const range = `מ-${dayLabel(min)} עד ${dayLabel(max)} (היום ועוד ${FORECAST_DAYS - 1} ימים)`;
    renderStatus({ state: 'error', message: mySel.date
      ? `אפשר לבחור תאריך ${range}. תאריכים שעברו אינם תחזית ולכן לא מוצגים.`
      : `בחרו תאריך ${range}.` });
    return;
  }

  const myController = new AbortController();
  controller = myController;
  // The timer aborts only this request (never a newer one started after it).
  const timer = setTimeout(() => myController.abort('timeout'), REQUEST_TIMEOUT_MS);
  const mySignal = myController.signal;

  renderControls(true);
  renderStatus({ state: 'loading', loc, sel: mySel, refresh });
  if (!lastData) renderContent(null);

  try {
    const res = await fetch(buildUrl(loc, mySel), { signal: mySignal, cache: 'no-store' });
    const body = await res.json().catch(() => null);
    if (seq !== requestSeq) return; // a newer request started meanwhile: ignore this answer
    if (!res.ok) {
      throw Object.assign(new Error('HTTP'), { status: res.status, reason: body?.reason });
    }
    const parsed = parseResponse(body);
    lastData = { sel: id, ...parsed, fetchedAt: new Date() };
    renderContent(lastData);
    const missing = parsed.rows.filter((r) => r.height === null).length;
    if (parsed.rows.length === 0 || missing === parsed.rows.length) {
      renderStatus({ state: 'empty', loc, sel: mySel });
    } else if (missing > 0) {
      renderStatus({ state: 'partial', loc, sel: mySel, missing, total: parsed.rows.length });
    } else {
      renderStatus(null);
    }
  } catch (err) {
    if (seq !== requestSeq) return; // superseded by a newer request (aborted on purpose)
    lastData = refresh && lastData?.sel === id ? lastData : null;
    renderStatus({ state: 'error', message: describeError(err, mySignal) });
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

const periodText = (s) => (s.mode === 'date' ? `ל${dayLabel(s.date)}` : 'ל-48 השעות הקרובות'); // "ליום ג׳, 13.10"

function renderControls(busy) {
  document.querySelectorAll('.seg-btn[data-loc]').forEach((btn) => {
    const active = btn.dataset.loc === sel.key;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => {
    const active = btn.dataset.mode === sel.mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });
  // The picker's limits are recalculated every time, so a page left open past midnight stays correct.
  const { min, max } = dateRange();
  const input = $('dateInput');
  input.min = min;
  input.max = max;
  if (sel.mode === 'date' && input.value !== sel.date) input.value = sel.date || '';
  $('dateField').hidden = sel.mode !== 'date';
  $('rangeNote').hidden = sel.mode !== 'date';
  $('rangeNote').textContent = `טווח התחזית: מ-${dayLabel(min)} עד ${dayLabel(max)} (היום ועוד ${FORECAST_DAYS - 1} ימים), לפי מה שה-API מחזיר בפועל.`;
  const refresh = $('refreshBtn');
  refresh.disabled = busy;
  refresh.textContent = busy ? 'טוען…' : 'רענון';
}

function renderStatus(status) {
  const box = $('forecastStatus');
  if (!status) { box.innerHTML = ''; return; }
  const where = status.loc ? `ל${escapeHTML(status.loc.name)} ${escapeHTML(periodText(status.sel))}` : '';
  if (status.state === 'loading') {
    box.innerHTML = `<div class="notice notice-info" role="status"><span class="spinner" aria-hidden="true"></span>
      ${status.refresh ? 'מרענן' : 'טוען'} את התחזית ${where} מ-Open-Meteo…</div>`;
  } else if (status.state === 'error') {
    box.innerHTML = `<p class="notice notice-error" role="alert">${escapeHTML(status.message)}</p>`;
  } else if (status.state === 'empty') {
    box.innerHTML = `<p class="notice notice-warn" role="status">אין נתוני גובה גלים ${where}. Open-Meteo החזיר תשובה בלי ערכים${status.sel.mode === 'date' ? ', ייתכן שהתאריך מעבר לטווח שהמודל מכסה כרגע' : ''}.</p>`;
  } else if (status.state === 'partial') {
    box.innerHTML = `<p class="notice notice-warn" role="status">ב-${status.missing} מתוך ${status.total} השעות ${where} אין נתון לגובה גלים. הן מסומנות "אין נתון" ומופיעות כרווח בגרף, לא כאפס.</p>`;
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

const heightHtml = (r) => (r && r.height !== null ? `${r.height.toFixed(2)} <small>מ'</small>` : NO_DATA);
const extreme = (rows, pick) => rows.filter((r) => r.height !== null).reduce((best, r) => (best === null || pick(r.height, best.height) ? r : best), null);

function renderCards(view, s, nowHour) {
  if (s.mode === 'next48') {
    const now = view.rows[0];
    const peak = extreme(view.rows, (a, b) => a > b);
    return `
      <div class="metrics">
        ${card('גובה גלים עכשיו', heightHtml(now), now ? `לשעה ${hourOf(now.local)}` : '')}
        ${card('כיוון גלים', directionHtml(now?.direction), now && now.direction !== null ? `מגיעים מ${compass(now.direction)} (החץ: כיוון התנועה)` : '')}
        ${card('מחזור גלים', now && now.period !== null ? `${fixed(now.period, 1)} <small>שניות</small>` : NO_DATA, 'הזמן בין גל לגל')}
        ${card('שיא ב-48 השעות', heightHtml(peak), peak ? dayHourLabel(peak.local) : '')}
      </div>`;
  }
  // One day. Today: only the hours from now on count, so past hours are never summarized as forecast.
  const isToday = s.date === nowHour.slice(0, 10);
  const rows = isToday ? view.rows.filter((r) => r.local >= nowHour) : view.rows;
  const scope = isToday ? `מ-${hourOf(nowHour)} עד סוף היום` : 'לאורך היום';
  const peak = extreme(rows, (a, b) => a > b);
  const low = extreme(rows, (a, b) => a < b);
  const dirs = rows.map((r) => r.direction).filter((d) => d !== null);
  const meanDir = meanDirection(dirs);
  const periods = rows.map((r) => r.period).filter((p) => p !== null);
  const meanPeriod = periods.length ? periods.reduce((a, b) => a + b, 0) / periods.length : null;
  return `
    <div class="metrics">
      ${card('גובה גלים מרבי', heightHtml(peak), peak ? `בשעה ${hourOf(peak.local)} · ${scope}` : scope)}
      ${card('גובה גלים מזערי', heightHtml(low), low ? `בשעה ${hourOf(low.local)} · ${scope}` : scope)}
      ${card('כיוון גלים ממוצע', directionHtml(meanDir), meanDir !== null ? `מגיעים מ${compass(meanDir)} · ${scope}` : scope)}
      ${card('מחזור גלים ממוצע', meanPeriod !== null ? `${fixed(meanPeriod, 1)} <small>שניות</small>` : NO_DATA, scope)}
    </div>`;
}

// SVG line chart of wave height. Missing hours break the line (a gap), they are never drawn as 0.
// Hours that have already passed are shaded and labelled "עבר".
function renderChart(view, s, nowHour) {
  // Drawn at the container's real width so the axis text keeps its size on phones.
  const W = Math.max(300, Math.min(1400, ($('forecastContent').clientWidth || 720) - 14));
  const narrow = W < 480;
  const H = narrow ? 220 : 260, padL = 40, padR = 10, padT = 18, padB = 40;
  const labelEvery = s.mode === 'date' ? (narrow ? 6 : 3) : (narrow ? 12 : 6);
  const rows = view.rows;
  const heights = rows.map((r) => r.height).filter((v) => v !== null);
  if (rows.length < 2 || heights.length === 0) return '';
  const yMax = Math.max(0.5, Math.ceil(Math.max(...heights) * 1.25 * 2) / 2);
  const stepX = (W - padL - padR) / (rows.length - 1);
  const x = (i) => padL + i * stepX;
  const y = (v) => padT + (1 - v / yMax) * (H - padT - padB);

  const segments = [];
  let current = [];
  rows.forEach((r, i) => {
    if (r.height === null) { if (current.length) segments.push(current); current = []; }
    else current.push([x(i), y(r.height)]);
  });
  if (current.length) segments.push(current);
  const line = segments.map((seg) => (seg.length === 1 ? `M${seg[0][0]},${seg[0][1]}h0.01` : `M${seg.map((p) => p.join(',')).join('L')}`)).join(' ');
  const area = segments.filter((seg) => seg.length > 1).map((seg) => `M${seg[0][0]},${y(0)}L${seg.map((p) => p.join(',')).join('L')}L${seg[seg.length - 1][0]},${y(0)}Z`).join(' ');

  const step = yMax <= 1 ? 0.25 : 0.5;
  let grid = '';
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    grid += `<line x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}" class="grid"/>
             <text x="${padL - 6}" y="${y(v) + 4}" class="axis" text-anchor="end">${v.toFixed(step < 0.5 ? 2 : 1)}</text>`;
  }
  let xLabels = '';
  rows.forEach((r, i) => {
    const hour = Number(hourOf(r.local).slice(0, 2));
    if (hour % labelEvery === 0) {
      xLabels += `<line x1="${x(i)}" x2="${x(i)}" y1="${padT}" y2="${H - padB}" class="grid grid-v"/>
                  <text x="${x(i)}" y="${H - padB + 16}" class="axis" text-anchor="middle">${hourOf(r.local)}</text>
                  ${hour === 0 && s.mode === 'next48' ? `<text x="${x(i)}" y="${H - padB + 31}" class="axis axis-day" text-anchor="middle">${fmtWeekdayShort.format(noonUtc(r.local.slice(0, 10)))}</text>` : ''}`;
    }
  });

  // Past hours (only possible on today's date) and the current hour.
  const pastCount = rows.filter((r) => r.local < nowHour).length;
  const nowIndex = rows.findIndex((r) => r.local === nowHour);
  let pastZone = '';
  if (pastCount > 0) {
    const xEnd = pastCount >= rows.length ? W - padR : x(pastCount) - stepX / 2;
    pastZone = `<rect x="${padL}" y="${padT}" width="${Math.max(0, xEnd - padL)}" height="${H - padT - padB}" class="past-zone"/>
                <text x="${padL + 4}" y="${padT - 5}" class="axis axis-past" text-anchor="start">עבר</text>`;
  }
  const nowLine = nowIndex >= 0
    ? `<line x1="${x(nowIndex)}" x2="${x(nowIndex)}" y1="${padT}" y2="${H - padB}" class="now-line"/>
       <text x="${x(nowIndex)}" y="${padT - 5}" class="axis axis-now" text-anchor="${nowIndex > rows.length - 4 ? 'end' : 'middle'}">עכשיו</text>`
    : '';

  const hover = rows.map((r, i) => `<rect x="${x(i) - stepX / 2}" y="${padT}" width="${stepX}" height="${H - padT - padB}" class="hover"><title>${dayHourLabel(r.local)}${r.local < nowHour ? ' (עבר)' : ''} · ${r.height !== null ? `${r.height.toFixed(2)} מ'` : 'אין נתון'}</title></rect>`).join('');
  const points = rows.map((r, i) => (r.height !== null ? `<circle cx="${x(i)}" cy="${y(r.height)}" r="2.2" class="pt${r.local < nowHour ? ' pt-past' : ''}"/>` : '')).join('');

  return `
    <figure class="chart">
      <figcaption>גובה גלים משמעותי (מטרים) לפי שעה, אזור זמן ישראל${pastCount ? '. האזור האפור: שעות שכבר עברו' : ''}</figcaption>
      <div class="chart-box" dir="ltr">
        <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="גרף גובה גלים ${escapeHTML(periodText(s))}">
          ${pastZone}${grid}${xLabels}
          <path d="${area}" class="area"/>
          <path d="${line}" class="line"/>
          ${nowLine}${points}${hover}
          <text x="${padL - 6}" y="${padT - 5}" class="axis" text-anchor="end">מ'</text>
        </svg>
      </div>
    </figure>`;
}

function renderTable(view, nowHour) {
  const rows = view.rows.map((r) => {
    const tag = r.local < nowHour ? '<span class="time-tag past">עבר</span>' : r.local === nowHour ? '<span class="time-tag now">עכשיו</span>' : '';
    return `
    <tr class="${r.local < nowHour ? 'row-past' : ''}">
      <td>${dayHourLabel(r.local)} ${tag}</td>
      <td>${r.height !== null ? r.height.toFixed(2) : NO_DATA}</td>
      <td>${r.direction !== null ? `${Math.round(r.direction)}° (${compass(r.direction)})` : NO_DATA}</td>
      <td>${r.period !== null ? fixed(r.period, 1) : NO_DATA}</td>
    </tr>`;
  }).join('');
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

// The heading always states which day / period the data belongs to.
function periodHeading(view, s, nowHour) {
  if (s.mode === 'date') {
    if (!isValidDate(s.date)) return 'לא נבחר תאריך';
    if (!inRange(s.date)) return `${longDate(s.date)}: מחוץ לטווח התחזית`;
    const isToday = s.date === nowHour.slice(0, 10);
    return `${isToday ? 'היום, ' : ''}${longDate(s.date)}${isToday ? ` (השעות שלפני ${hourOf(nowHour)} כבר עברו ומסומנות "עבר")` : ''}`;
  }
  if (view && view.rows.length) {
    return `48 השעות הקרובות: ${dayHourLabel(view.rows[0].local)} עד ${dayHourLabel(view.rows[view.rows.length - 1].local)}`;
  }
  return '48 השעות הקרובות';
}

function renderContent(view) {
  const loc = LOCATIONS[sel.key];
  const nowHour = nowLocalHour();
  const head = `
    <div class="forecast-head">
      <h2>${escapeHTML(loc.name)} <span class="muted forecast-area">${escapeHTML(loc.area)}</span></h2>
      <p class="forecast-date">${escapeHTML(periodHeading(view, sel, nowHour))}</p>
      <p class="forecast-meta">
        נקודה מבוקשת בים: <span dir="ltr">${loc.lat.toFixed(3)}°N, ${loc.lon.toFixed(3)}°E</span>
        ${view && isNum(view.gridLat) ? `· תא המודל שבו השתמש ה-API: <span dir="ltr">${view.gridLat.toFixed(3)}°N, ${view.gridLon.toFixed(3)}°E</span> (כ-${distanceKm(loc.lat, loc.lon, view.gridLat, view.gridLon).toFixed(1)} ק"מ ממנה)` : ''}
        <br>מקור: <a href="${DOCS_URL}" target="_blank" rel="noopener">Open-Meteo Marine Weather API</a>
        · <a href="https://open-meteo.com/" target="_blank" rel="noopener" class="credit" dir="ltr">Weather data by Open-Meteo.com</a>
        ${view ? `· נשלף לאחרונה: <span id="fetchedAt">${fmtFetched.format(view.fetchedAt)}</span>` : ''}
        · הזמנים לפי אזור הזמן Asia/Jerusalem
      </p>
    </div>`;
  $('forecastContent').innerHTML = view
    ? head + renderCards(view, sel, nowHour) + renderChart(view, sel, nowHour) + renderTable(view, nowHour)
    : head;
}

// ---------- Selection ----------

function applySelection(changes) {
  Object.assign(sel, changes); // an empty or out-of-range date is kept as is; load() explains and sends nothing
  try { localStorage.setItem(LOCATION_KEY, sel.key); } catch { /* storage may be unavailable */ }
  history.replaceState(null, '', `#${sel.key}${sel.mode === 'date' ? `/${sel.date}` : ''}`);
  load();
}

document.querySelectorAll('.seg-btn[data-loc]').forEach((btn) => btn.addEventListener('click', () => {
  if (btn.dataset.loc !== sel.key) applySelection({ key: btn.dataset.loc });
}));
document.querySelectorAll('.seg-btn[data-mode]').forEach((btn) => btn.addEventListener('click', () => {
  if (btn.dataset.mode === sel.mode) return;
  // Switching to "by date" starts from the last valid chosen day, or today.
  const date = btn.dataset.mode === 'date' ? (inRange(sel.date) ? sel.date : todayLocal()) : sel.date;
  applySelection({ mode: btn.dataset.mode, date });
}));
$('dateInput').addEventListener('change', (e) => {
  if (e.target.value !== sel.date) applySelection({ date: e.target.value });
});
$('refreshBtn').addEventListener('click', () => load({ refresh: true }));

// Redraw at the new width when the window size changes (e.g. rotating a phone).
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (lastData?.sel === selId()) renderContent(lastData); }, 200);
});

(function start() {
  let saved = null;
  try { saved = localStorage.getItem(LOCATION_KEY); } catch { /* ignore */ }
  // The address can hold a location and a date, e.g. forecast.html#netanya/2026-10-09
  const [hashKey, hashDate] = location.hash.slice(1).split('/');
  const key = LOCATIONS[hashKey] ? hashKey : LOCATIONS[saved] ? saved : 'telaviv';
  // A date from an old link that is no longer in range falls back to the next 48 hours.
  const useDate = inRange(hashDate);
  applySelection({ key, mode: useDate ? 'date' : 'next48', date: useDate ? hashDate : null });
})();
