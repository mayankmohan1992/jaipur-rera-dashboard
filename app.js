/* Jaipur RERA dashboard — vanilla JS, no dependencies. */
'use strict';

const SQM2SQF = 10.7639;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  tab: 'overview',
  q: '',
  cats: new Set(),
  statuses: new Set(),
  prom: new Set(),
  tehsils: new Set(),
  dateFrom: '',
  dateTo: '',
  year: '',
  minArea: null,
  maxArea: null,
  minUnits: null,
  maxUnits: null,
  casesOnly: false,
  plotted: 'any',
  unit: 'sqm',
  sort: { key: 'regDate', dir: -1 },
  pSort: { key: 'projects', dir: -1 },
  pivot: { row: 'promoter', metric: 'area', year: '', cat: '' },
  limit: 300,
};

let META = null, PROJECTS = [], PROMOTERS = [], COMPLAINTS = [], AGENTS = null;
const detailCache = new Map();

/* ------------------------------------------------------------------ format */
const nf = (d = 0) => new Intl.NumberFormat('en-IN', { maximumFractionDigits: d, minimumFractionDigits: 0 });
function n0(v) { return v == null || isNaN(v) ? '–' : nf(0).format(Math.round(v)); }
function n1(v) { return v == null || isNaN(v) ? '–' : nf(1).format(v); }
function area(v, dp = 0) {
  if (v == null || isNaN(v) || v === 0) return '–';
  const x = state.unit === 'sqft' ? v * SQM2SQF : v;
  return nf(dp).format(x);
}
function money(v) {
  if (v == null || isNaN(v) || v === 0) return '–';
  if (v >= 1e7) return '₹' + nf(2).format(v / 1e7) + ' Cr';
  if (v >= 1e5) return '₹' + nf(1).format(v / 1e5) + ' L';
  return '₹' + n0(v);
}
function areaUnit() { return state.unit === 'sqft' ? 'sq ft' : 'sq m'; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Two-line clamp inside a table cell; see .clamp2 in style.css for why it is a span.
function clamp2(s, width, title) {
  return `<span class="clamp2"${width ? ` style="max-width:${width}px"` : ''}` +
    `${title ? ` title="${esc(title)}"` : ''}>${esc(s)}</span>`;
}
function catClass(c) {
  const u = (c || '').toUpperCase();
  if (u.includes('GROUP')) return 'gh';
  if (u.includes('PLOT')) return 'pl';
  if (u.includes('COMMERCIAL')) return 'cm';
  if (u.includes('MIXED')) return 'mx';
  return '';
}
let _rsz;
window.addEventListener('resize', () => {
  clearTimeout(_rsz);
  _rsz = setTimeout(() => $$('.tbl-wrap').forEach(markScrollable), 120);
});

/* Theme is a reader choice, not an OS preference: light unless they picked dark.
   Charts read their colours from the CSS tokens, so a switch has to redraw them. */
const THEME_KEY = 'jr-theme';

function themeName() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

function applyTheme(mode) {
  const dark = mode === 'dark';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const b = $('#themeToggle');
  if (b) {
    b.textContent = dark ? 'Light' : 'Dark';
    b.setAttribute('aria-pressed', dark ? 'true' : 'false');
    b.title = dark ? 'Switch to light theme' : 'Switch to dark theme';
  }
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch (e) {}
}

function initTheme() {
  applyTheme(themeName());
  const b = $('#themeToggle');
  if (b) b.onclick = () => {
    applyTheme(themeName() === 'dark' ? 'light' : 'dark');
    if (typeof render === 'function' && PROJECTS.length) render();
  };
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('on'), 2400);
}

/* -------------------------------------------------------------------- load */
function stalenessNotice() {
  const asOf = META && META.asOf ? new Date(META.asOf) : null;
  if (!asOf || isNaN(asOf)) return '';
  const days = Math.floor((Date.now() - asOf.getTime()) / 86400000);
  if (days < 3) return '';
  return `<div class="stale" role="status">This register has not been refreshed for ${days} days —
    the portal was unreachable from the last machine that tried. Figures below are from
    ${asOf.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}.</div>`;
}

async function boot() {
  initTheme();
  const load = async (p) => {
    const r = await fetch('data/' + p);
    if (!r.ok) throw new Error(p + ' ' + r.status);
    return r.json();
  };
  try {
    [META, PROJECTS, PROMOTERS, COMPLAINTS] = await Promise.all([
      load('meta.json'), load('projects.json'), load('promoters.json'), load('complaints.json'),
    ]);
  } catch (e) {
    $('#main').innerHTML = '<div class="empty">Failed to load data: ' + esc(e.message) + '</div>';
    return;
  }
  renderHeader();
  buildFilterUI();
  wire();
  const h = (location.hash || '').replace('#', '').split(/[&?]/)[0];
  if (h && document.querySelector('.tab[data-tab="' + h + '"]')) state.tab = h;
  render();
}

function renderHeader() {
  const d = new Date((META.asOf || '').replace(' ', 'T'));
  const stamp = isNaN(d) ? (META.asOf || '') : d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Asia/Kolkata',
  }) + ' IST';
  $('#tbMeta').innerHTML = `Register as of <b>${esc(stamp)}</b><br>` +
    `Source: RERA Rajasthan public API · district 1077` + stalenessNotice();
}

/* ----------------------------------------------------------------- filters */
function buildFilterUI() {
  const cats = Object.entries(META.category).sort((a, b) => b[1] - a[1]);
  $('#fCats').innerHTML = cats.map(([k, v]) =>
    `<span class="chip" data-cat="${esc(k)}" role="button" aria-pressed="false">${esc(k)}<small>${n0(v)}</small></span>`).join('');

  const sts = Object.entries(META.status).sort((a, b) => b[1] - a[1]);
  $('#fStatus').innerHTML = sts.map(([k, v]) =>
    `<span class="chip" data-status="${esc(k)}" role="button" aria-pressed="false">${esc(statusLabel(k))}<small>${n0(v)}</small></span>`).join('');

  const yrs = Object.keys(META.years).sort().reverse();
  $('#fYear').innerHTML = '<option value="">All years</option>' +
    yrs.map(y => `<option value="${y}">${y} (${META.years[y]})</option>`).join('');

  const teh = Object.entries(META.tehsils).filter(([k]) => k && k !== '-').slice(0, 40);
  $('#fTehsil').innerHTML = teh.map(([k, v]) =>
    `<span class="chip" data-tehsil="${esc(k)}" role="button" aria-pressed="false">${esc(k)}<small>${n0(v)}</small></span>`).join('');

}

function matchPeriod(p) {
  if (state.year && p.regYear !== state.year) return false;
  if (state.dateFrom && (!p.regDate || p.regDate < state.dateFrom)) return false;
  if (state.dateTo && (!p.regDate || p.regDate > state.dateTo)) return false;
  return true;
}

function filtered() {
  const q = state.q.trim().toUpperCase();
  return PROJECTS.filter(p => {
    if (state.cats.size && !state.cats.has(p.cat)) return false;
    if (state.statuses.size) {
      const key = p.status || p.app || '';
      if (!state.statuses.has(key)) return false;
    }
    if (state.prom.size && !state.prom.has(p.promoterKey)) return false;
    if (state.tehsils.size && !state.tehsils.has(p.tehsil)) return false;
    if (!matchPeriod(p)) return false;
    if (state.minArea != null && (p.area == null || p.area < state.minArea)) return false;
    if (state.maxArea != null && (p.area == null || p.area > state.maxArea)) return false;
    const u = p.isPlotted ? p.plotCount : p.units;
    if (state.minUnits != null && (u == null || u < state.minUnits)) return false;
    if (state.maxUnits != null && (u == null || u > state.maxUnits)) return false;
    if (state.casesOnly && !(p.casesProject + p.casesPromoter)) return false;
    if (state.plotted !== 'any' && (state.plotted === 'plotted') !== !!p.isPlotted) return false;
    if (q) {
      const hay = (p.name + ' ' + p.promoter + ' ' + p.regNo + ' ' + p.village + ' ' + p.tehsil).toUpperCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/* ------------------------------------------------------------------- render */
function markScrollable(el) {
  if (!el) return;
  const box = el.closest('.tbl-wrap') || el;
  requestAnimationFrame(() => {
    box.classList.toggle('is-scrollable', box.scrollWidth > box.clientWidth + 2);
  });
}

function render() {
  $$('.tab').forEach(t => {
    const on = t.dataset.tab === state.tab;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', String(on));
  });
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + state.tab));
  const rows = filtered();
  const stale = $('#staleBar');
  if (stale) {
    const note = stalenessNotice();
    stale.innerHTML = note ? note.replace('class="stale"', 'class="stale bar"') : '';
    stale.style.display = note ? '' : 'none';
  }
  renderKpis(rows);
  if (state.tab === 'overview') renderOverview(rows);
  if (state.tab === 'projects') renderProjects(rows);
  if (state.tab === 'qpr') renderQpr(rows);
  if (state.tab === 'promoters') renderPromoters(rows);
  if (state.tab === 'pivot') renderPivot(rows);
  if (state.tab === 'cases') renderCases(rows);
  if (state.tab === 'agents') renderAgents();
  if (state.tab === 'quality') renderQuality();
  $$('.tbl-wrap').forEach(markScrollable);
  $('#fActive').innerHTML = activeFilterChips();
  const chipFilters = state.cats.size + state.statuses.size + state.tehsils.size;
  if ($('#moreCount')) $('#moreCount').textContent = chipFilters ? `${chipFilters} applied` : '';
  if ($('#moreFilters') && chipFilters) $('#moreFilters').open = true;
  if ($('#reset2')) $('#reset2').hidden = !$('#fActive').innerHTML;
}

function activeFilterChips() {
  const out = [];
  const add = (label, fn) => out.push(`<button class="chip" data-clear="${fn}">${label} ×</button>`);
  if (state.q) add('search: ' + esc(state.q), 'q');
  state.cats.forEach(c => add(esc(c), 'cat:' + c));
  state.statuses.forEach(c => add(esc(statusLabel(c)), 'status:' + c));
  state.tehsils.forEach(c => add(esc(c), 'tehsil:' + c));
  state.prom.forEach(c => add(esc(c), 'prom:' + c));
  if (state.year) add('year: ' + state.year, 'year');
  if (state.dateFrom || state.dateTo) add(`${state.dateFrom || '…'} → ${state.dateTo || '…'}`, 'dates');
  if (state.minArea != null || state.maxArea != null) add(`area ${state.minArea ?? 0}–${state.maxArea ?? '∞'} m²`, 'area');
  if (state.minUnits != null || state.maxUnits != null) add(`units ${state.minUnits ?? 0}–${state.maxUnits ?? '∞'}`, 'units');
  if (state.casesOnly) add('has cases', 'cases');
  if (state.plotted !== 'any') add(state.plotted, 'plotted');
  return out.length ? out.join(' ') + ' <button class="chip" data-clear="all">Clear all</button>' : '';
}

function sum(rows, f) { return rows.reduce((a, r) => a + (f(r) || 0), 0); }

function renderKpis(rows) {
  const plotted = rows.filter(r => r.isPlotted).length;
  const gh = rows.filter(r => !r.isPlotted).length;
  const units = sum(rows, r => r.units);
  const plots = sum(rows, r => r.plotCount);
  const cases = casesFor(rows).length;
  const filled = (f) => rows.length ? Math.round(100 * rows.filter(r => r[f]).length / rows.length) : 0;
  const k = [
    ['Projects', n0(rows.length), `${n0(gh)} with units · ${n0(plotted)} plot layouts`, false],
    ['Promoters', n0(new Set(rows.map(r => r.promoterKey).filter(Boolean)).size), 'distinct names', false],
    ['Units', n0(units), `flats &amp; shops · ${filled('units')}% filed`, false],
    ['Plots', n0(plots), `registered plots · ${filled('plotCount')}% filed`, false],
    ['Declared area', area(sum(rows, r => r.area)),
      `built-up / saleable ${areaUnit()} · ${n0(rows.filter(r => (r.area || 0) > 0).length)} of ${n0(rows.length)} filed`, false],
    ['Cases', n0(cases), 'statewide register · builder-level', cases > 0],
  ];
  $('#kpis').innerHTML = k.map(([a, b, c, hot]) =>
    `<div class="fig${hot ? ' is-accent' : ''}"><div class="k">${a}</div>` +
    `<div class="v">${b}</div><div class="s">${c}</div></div>`).join('');
}

function compact(v) {
  const a = Math.abs(v);
  if (a >= 1e7) return (v / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, '') + 'Cr';
  if (a >= 1e5) return (v / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, '') + 'L';
  if (a >= 1000) return (v / 1000).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
  if (a > 0 && a < 1) return String(+v.toFixed(2));   // 0.5 must not print as 1
  return String(Math.round(v));
}

function niceStep(x) {
  if (!isFinite(x) || x <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(x)));
  const n = x / mag;
  const m = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return m * mag;
}

function largestRemainder(fracs, total) {
  const raw = fracs.map(f => f * total);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0])
     .forEach(([, i]) => { if (left > 0) { out[i]++; left--; } });
  return out;
}

/* the portal ships status strings in caps without spaces */
const STATUS_WORDS = {
  INPROGRESS: 'In progress', COMPLETED: 'Completed', LAPSED: 'Lapsed', REVOKED: 'Revoked',
  SUSPENDED: 'Suspended', EXEMPTED: 'Exempted',
  'COMPLETED & OC ISSUED': 'Completed, OC issued',
};
function statusLabel(s) {
  const k = String(s || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return STATUS_WORDS[k] || (k ? k.charAt(0) + k.slice(1).toLowerCase() : '—');
}

/* ------------------------------------------------------------------- charts */
function theme() {
  const cs = getComputedStyle(document.documentElement);
  const g = n => cs.getPropertyValue(n).trim();
  return {
    rule: g('--rule'), rule2: g('--rule-2'), muted: g('--muted'), faint: g('--faint'),
    ink: g('--ink'), paper: g('--paper'), accent: g('--accent'),
    series: [g('--s1'), g('--s2'), g('--s3'), g('--s4'), g('--s5'), g('--s6')],
    cats: [g('--c1'), g('--c2'), g('--c3'), g('--c4')],
  };
}

function setupCanvas(cv, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.parentElement.clientWidth || 400;
  const h = cssH;
  if (cv.dataset.h !== String(h)) { cv.dataset.h = String(h); cv.style.height = h + 'px'; }
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h, t: theme() };
}

// shrink a label to the width it has, keeping the start (name) not the tail
function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  const ell = '\u2026';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + ell).width <= maxW) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + ell;
}

// A chart with nothing to plot says so. Drawing an axis for an empty series
// produces ticks like 1, 1, 0 and a row of zeros that looks like a bug.
function emptyChart(cv, msg, height) {
  const { ctx, w, h, t } = setupCanvas(cv, height);
  ctx.fillStyle = t.rule;
  ctx.fillRect(0, 0, w, 1);
  ctx.fillStyle = t.muted;
  ctx.font = '12px "Public Sans", sans-serif';
  ctx.textAlign = 'left';
  const maxW = Math.max(80, w - 8);
  ctx.fillText(fitText(ctx, msg, maxW), 0, Math.max(28, Math.round(h * 0.45)));
}

function hasValues(values) {
  return values.some(v => typeof v === 'number' && isFinite(v) && v > 0);
}

function drawBars(cv, labels, series, opts = {}) {
  const all = series.flatMap(s => s.values);
  if (!hasValues(all)) { emptyChart(cv, opts.empty || 'No data for this selection', opts.height || 210); return { max: 0 }; }
  const { ctx, w, h, t } = setupCanvas(cv, opts.height || 210);
  const pad = { l: 52, r: 10, t: 10, b: 34 };
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const raw = Math.max(...all);
  const step = niceStep(raw / 4);
  const ticks = Math.max(1, Math.ceil(raw / step));
  const max = step * ticks;
  ctx.strokeStyle = t.rule; ctx.lineWidth = 1;
  ctx.fillStyle = t.faint; ctx.font = '10px "Public Sans", sans-serif';
  for (let i = 0; i <= ticks; i++) {
    const y = pad.t + ih - (ih * i / ticks);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillText(compact(step * i), 4, y + 3);
  }
  const n = labels.length;
  const slot = iw / Math.max(n, 1);
  const bw = Math.max(2, (slot * 0.72) / series.length);
  labels.forEach((lb, i) => {
    const x0 = pad.l + slot * i + (slot - bw * series.length) / 2;
    series.forEach((s, si) => {
      const v = s.values[i] || 0;
      const bh = (v / max) * ih;
      ctx.globalAlpha = (opts.partialLast && i === n - 1) ? 0.4 : 1;
      ctx.fillStyle = s.color;
      ctx.fillRect(x0 + si * bw, pad.t + ih - bh, Math.max(bw - 1, 1), bh);
      ctx.globalAlpha = 1;
    });
    if (n <= 26 || i % Math.ceil(n / 26) === 0) {
      ctx.save();
      ctx.translate(pad.l + slot * i + slot / 2, h - pad.b + 12);
      ctx.rotate(n > 14 ? -Math.PI / 4 : 0);
      ctx.fillStyle = t.muted; ctx.font = '10px "Public Sans", sans-serif';
      ctx.textAlign = n > 14 ? 'right' : 'center';
      ctx.fillText(lb, 0, 0);
      ctx.restore();
    }
  });
  return { max };
}

function drawHBar(cv, labels, values, color = null, height = 240, opts = {}) {
  if (!hasValues(values)) {
    emptyChart(cv, opts.empty || 'Nothing to rank for this selection', height);
    return;
  }
  const { ctx, w, h, t } = setupCanvas(cv, height);
  const fill = color || t.s2;
  ctx.font = '11px "Public Sans", sans-serif';
  // the gutter is whatever the longest name actually needs, capped so the bars keep room
  const widest = Math.max(...labels.map(l => ctx.measureText(l || '').width));
  const gutter = Math.min(Math.max(96, widest + 10), Math.min(w * 0.44, 320));
  const pad = { l: gutter, r: 58, t: 6, b: 6 };
  const iw = Math.max(20, w - pad.l - pad.r), ih = h - pad.t - pad.b;
  const max = Math.max(1, ...values);
  const rowH = ih / Math.max(labels.length, 1);
  labels.forEach((lb, i) => {
    const y = pad.t + rowH * i;
    const bh = Math.min(rowH - 3, 16);
    ctx.fillStyle = fill;
    ctx.fillRect(pad.l, y + (rowH - bh) / 2, (values[i] / max) * iw, bh);
    ctx.fillStyle = t.muted; ctx.font = '11px "Public Sans", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(fitText(ctx, lb || '', gutter - 10), pad.l - 8, y + rowH / 2 + 3);
    ctx.textAlign = 'left'; ctx.fillStyle = t.ink;
    ctx.fillText(n0(values[i]), pad.l + (values[i] / max) * iw + 6, y + rowH / 2 + 3);
  });
  ctx.textAlign = 'left';
}

function drawDonut(cv, items, height = 200) {
  const sum = items.reduce((a, b) => a + b.value, 0);
  if (!sum) { emptyChart(cv, 'No projects in this selection', height); return; }
  const { ctx, w, h, t } = setupCanvas(cv, height);
  const total = sum;
  const cx = Math.min(w * 0.33, 130), cy = h / 2, r = Math.min(cy - 10, 78);
  let a0 = -Math.PI / 2;
  items.forEach(it => {
    const a1 = a0 + (it.value / total) * Math.PI * 2;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a0, a1); ctx.closePath();
    ctx.fillStyle = it.color; ctx.fill();
    a0 = a1;
  });
  ctx.beginPath(); ctx.arc(cx, cy, r * 0.58, 0, Math.PI * 2);
  ctx.fillStyle = t.paper; ctx.fill();
  ctx.fillStyle = t.ink; ctx.font = '600 17px Spectral, Georgia, serif'; ctx.textAlign = 'center';
  ctx.fillText(n0(total), cx, cy + 2);
  ctx.fillStyle = t.faint; ctx.font = '9px "Public Sans", sans-serif';
  ctx.fillText('PROJECTS', cx, cy + 16);
  ctx.textAlign = 'left';
  let ly = cy - items.length * 9;
  const pcts = largestRemainder(items.map(it => it.value / total), 100);
  items.forEach((it, idx) => {
    ctx.fillStyle = it.color; ctx.fillRect(cx + r + 22, ly - 7, 8, 8);
    ctx.fillStyle = t.ink; ctx.font = '11px "Public Sans", sans-serif';
    const lx = cx + r + 36;
    ctx.fillText(it.label.length > 26 ? it.label.slice(0, 25) + '…' : it.label, lx, ly);
    ctx.textAlign = 'right';
    ctx.fillStyle = t.muted;
    ctx.fillText(`${n0(it.value)} · ${pcts[idx]}%`, w - 6, ly);
    ctx.textAlign = 'left';
    ly += 18;
  });
}

const PALETTE = () => theme().series;

/* ----------------------------------------------------------------- overview */
function renderOverview(rows) {
  const years = {}, cats = {};
  rows.forEach(r => {
    if (r.regYear) {
      years[r.regYear] = years[r.regYear] || { n: 0, area: 0, units: 0 };
      years[r.regYear].n++;
      years[r.regYear].area += r.area || 0;
      years[r.regYear].units += r.units || 0;
    }
    cats[r.cat] = (cats[r.cat] || 0) + 1;
  });
  const yl = Object.keys(years).sort();
  const pal = PALETTE();
  drawBars($('#cYear'), yl, [{ values: yl.map(y => years[y].n), color: pal[0] }],
    { partialLast: true, empty: 'No projects in this selection have a registration date' });
  drawBars($('#cArea'), yl, [{ values: yl.map(y => years[y].area), color: pal[1] }],
    { partialLast: true, empty: 'No built-up / saleable area filed by the projects in this selection' });

  // coverage is a property of the selection, not of the register: say how many of
  // these projects filed an area at all, otherwise the note contradicts the chart
  const areaCard = $('#cArea').closest('.card');
  if (areaCard) {
    const filed = rows.filter(r => (r.area || 0) > 0).length;
    const em = areaCard.querySelector('h3 em');
    if (em) {
      em.textContent = filed
        ? `${areaUnit()} · filed by ${n0(filed)} of ${n0(rows.length)} projects · 2026 partial`
        : `${areaUnit()} · not filed by any of these ${n0(rows.length)} projects`;
    }
    const promAreaCard = $('#cPromArea') && $('#cPromArea').closest('.card');
    if (promAreaCard) {
      const em2 = promAreaCard.querySelector('h3 em');
      if (em2) em2.textContent = `${areaUnit()} · declared areas only`;
    }
  }
  const shortCat = { 'Mixed (Residential And Commercial)': 'Mixed use' };
  const catPal = theme().cats;
  drawDonut($('#cCat'), Object.entries(cats).sort((a, b) => b[1] - a[1])
    .map(([k, v], i) => ({ label: shortCat[k] || k, value: v, color: catPal[i % catPal.length] })));

  const byProm = {};
  rows.forEach(r => {
    if (!r.promoterKey) return;
    byProm[r.promoterKey] = byProm[r.promoterKey] || { n: 0, name: r.promoter, area: 0 };
    byProm[r.promoterKey].n++;
    byProm[r.promoterKey].area += r.area || 0;
  });
  const top = Object.values(byProm).sort((a, b) => b.n - a.n).slice(0, 15);
  drawHBar($('#cProm'), top.map(t => t.name || '(unnamed)'), top.map(t => t.n), pal[0], 260);

  const topA = Object.values(byProm).sort((a, b) => b.area - a.area).slice(0, 15);
  drawHBar($('#cPromArea'), topA.map(t => t.name || '(unnamed)'),
    topA.map(t => Math.round(t.area)), pal[1], 260,
    { empty: 'No built up / saleable area filed — these promoters cannot be ranked by area' });

  const teh = {};
  rows.forEach(r => { teh[r.tehsil || '—'] = (teh[r.tehsil || '—'] || 0) + 1; });
  drawHBar($('#cTehsil'), Object.entries(teh).sort((a, b) => b[1] - a[1]).slice(0, 15).map(x => x[0]),
    Object.entries(teh).sort((a, b) => b[1] - a[1]).slice(0, 15).map(x => x[1]), pal[0], 260);
}

/* ---------------------------------------------------------------- qpr / apr */
const Q_END = { 1: 3, 2: 6, 3: 9, 4: 12 };

function quartersSince(code) {
  const m = /^(\d{4})Q([1-4])$/.exec(code || '');
  if (!m) return null;
  const endQ = (+m[1]) * 4 + (+m[2] - 1);          // quarter index of the quarter reported
  const asof = new Date(META.asOf || Date.now());
  const nowQ = asof.getUTCFullYear() * 4 + Math.floor(asof.getUTCMonth() / 3);
  return Math.max(0, nowQ - endQ);
}

function staleness(n) {
  if (n == null) return '<span class="pill bad">never filed</span>';
  if (n <= 1) return '<span class="pill pl">current</span>';
  return `<span class="pill bad">${n} quarters behind</span>`;
}

function ageBuckets(rows) {
  const b = { 'current': 0, '1': 0, '2-3': 0, '4-7': 0, '8+': 0, 'never': 0 };
  rows.forEach(r => {
    if (!r.qprQ) { b.never++; return; }
    const n = quartersSince(r.qprQ) || 0;
    if (n <= 0) b.current++;
    else if (n === 1) b['1']++;
    else if (n <= 3) b['2-3']++;
    else if (n <= 7) b['4-7']++;
    else b['8+']++;
  });
  return b;
}

function renderQpr(rows) {
  const filed = rows.filter(r => r.qprQ);
  const never = rows.length - filed.length;
  const overdue = filed.filter(r => (quartersSince(r.qprQ) || 0) >= 2).length;

  // funnel: proposed (Form-A) -> sanctioned (QPR) -> booked / unsold (QPR)
  const proposed = rows.reduce((a, r) => a + (r.units || 0) + (r.plotCount || 0), 0);
  const sanctioned = rows.reduce((a, r) => a + (r.sanctioned || 0), 0);
  const booked = rows.reduce((a, r) => a + (r.sold || 0), 0);
  const unsoldQ = rows.reduce((a, r) => a + (r.unsold || 0), 0);
  const pal = PALETTE();
  drawHBar($('#cFunnel'), ['Proposed at registration', 'Sanctioned (QPR)', 'Booked (QPR)', 'Unsold (QPR)'],
    [proposed, sanctioned, booked, unsoldQ], pal[0], 170, {});
  if ($('#funnelNote')) {
    $('#funnelNote').textContent =
      `${n0(booked)} of ${n0(booked + unsoldQ)} filed inventory is booked` +
      (booked + unsoldQ ? ` (${Math.round(100 * booked / (booked + unsoldQ))}%)` : '') +
      ` · ${n0(filed.length)} of ${n0(rows.length)} projects report inventory`;
  }

  const buckets = ageBuckets(rows);
  const labels = ['current', '1', '2-3', '4-7', '8+', 'never'];
  drawBars($('#cQprAge'), labels,
    [{ values: labels.map(k => buckets[k]), color: pal[1] }],
    { empty: 'No projects in this selection', height: 170 });
  if ($('#qprAgeNote')) {
    $('#qprAgeNote').textContent =
      `quarters since the quarter reported · ${n0(buckets.current)} current, ` +
      `${n0(buckets['2-3'] + buckets['4-7'] + buckets['8+'])} two or more behind, ${n0(buckets.never)} never filed`;
  }
  const scope = ($('#qprScope') && $('#qprScope').value) || 'all';
  const scoped = rows.filter(r => {
    const n = quartersSince(r.qprQ);
    if (scope === 'never') return !r.qprQ;
    if (scope === 'current') return r.qprQ && (n || 0) === 0;
    if (scope === 'overdue') return r.qprQ && (n || 0) >= 2;
    return true;
  });
  $('#qprCount').innerHTML = `${n0(rows.length)} projects · <b>${n0(filed.length)}</b> have filed a QPR ` +
    `(${n0(overdue)} of those are two or more quarters behind) · <b>${n0(never)}</b> never filed · ` +
    `showing ${n0(Math.min(scoped.length, 400))} of ${n0(scoped.length)} in this scope`;

  const sort = ($('#qprSort') && $('#qprSort').value) || 'recent';
  const list = scoped.slice().sort((a, b) => {
    if (sort === 'recent') return String(b.qprFiled || '').localeCompare(String(a.qprFiled || ''));
    if (sort === 'sold') return (b.sold || -1) - (a.sold || -1);
    if (sort === 'pct') return (b.pctSold || -1) - (a.pctSold || -1);
    const sa = a.qprQ ? (quartersSince(a.qprQ) || 0) : 999;   // never filed sorts first
    const sb = b.qprQ ? (quartersSince(b.qprQ) || 0) : 999;
    return sb - sa || String(a.name || '').localeCompare(String(b.name || ''));
  });

  const body = list.slice(0, 400).map(p => {
    const n = quartersSince(p.qprQ);
    return `<tr class="click" data-id="${p.id}">
      <td class="wrap">${clamp2(p.name, 250)}</td>
      <td class="wrap">${clamp2(p.promoter, 220, p.promoter)}</td>
      <td>${esc(p.tehsil)}</td>
      <td>${p.qprQ ? esc((p.qprQuarter || '').replace(',', ' ·')) : '<span class="dim">–</span>'}</td>
      <td class="mono">${p.qprFiled || '<span class="dim">–</span>'}</td>
      <td>${staleness(n)}</td>
      <td class="r">${p.sold == null ? '<span class="dim">–</span>' : n0(p.sold)}</td>
      <td class="r">${p.unsold == null ? '<span class="dim">–</span>' : n0(p.unsold)}</td>
      <td class="r">${p.pctSold == null ? '<span class="dim">–</span>' : p.pctSold + '%'}</td>
      <td class="r">${p.constPct == null ? '<span class="dim">–</span>' : p.constPct + '%'}</td>
      <td class="mono">${p.aprYear || '<span class="dim">–</span>'}</td>
    </tr>`;
  }).join('');

  $('#tblQpr').innerHTML = `<table>
    <thead><tr>
      <th>Project</th><th>Promoter</th><th>Tehsil</th>
      <th>Last QPR</th><th>Filed</th><th>QPR status</th>
      <th class="r">Booked</th><th class="r">Unsold</th><th class="r">% booked</th>
      <th class="r">Construction</th><th>Last APR</th>
    </tr></thead><tbody>${body || '<tr><td colspan="11" class="dim">No projects match these filters.</td></tr>'}</tbody></table>`;
  $$('#tblQpr tbody tr').forEach(tr => tr.onclick = () => openDetail(tr.dataset.id));
}

/* ----------------------------------------------------------------- projects */
const COLS = [
  ['name', 'Project', 'text'], ['cat', 'Category', 'text'], ['promoter', 'Promoter', 'text'],
  ['status', 'Status', 'text'], ['regDate', 'Registered', 'date'], ['tehsil', 'Tehsil', 'text'],
  ['landArea', 'Land', 'area'], ['area', 'Area', 'area'],
  ['units', 'Units', 'num'], ['plotCount', 'Plots', 'num'],
  ['sold', 'Sold', 'num'], ['unsold', 'Unsold', 'num'], ['buildings', 'Bldgs', 'num'],
  ['totalCost', 'Cost', 'money'], ['casesPromoter', 'Builder cases', 'num'],
];

function sortRows(rows, s) {
  const k = s.key, dir = s.dir;
  return rows.slice().sort((a, b) => {
    let x = a[k], y = b[k];
    if (x == null) return 1; if (y == null) return -1;
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * (x - y);
  });
}

function renderProjects(rows) {
  const s = state.sort;
  const sorted = sortRows(rows, s);
  const shown = sorted.slice(0, state.limit);
  const head = COLS.map(([k, label, kind]) =>
    `<th scope="col" class="${kind === 'text' || kind === 'date' ? '' : 'r'}" data-sort="${k}"` +
    (s.key === k ? ` aria-sort="${s.dir > 0 ? 'ascending' : 'descending'}"` : '') + `>${label}` +
    (s.key === k ? `<span class="ar">${s.dir > 0 ? '▲' : '▼'}</span>` : '') + '</th>').join('');
  const body = shown.map(p => `<tr class="click" data-id="${p.id}">
    <td class="wrap">${clamp2(p.name, 280)}</td>
    <td><span class="pill ${catClass(p.cat)}">${esc(p.cat)}</span></td>
    <td class="wrap">${clamp2(p.promoter, 230, p.promoter)}</td>
    <td>${esc(statusLabel(p.status || p.app))}</td>
    <td class="mono">${p.regDate || '–'}</td>
    <td>${esc(p.tehsil)}</td>
    <td class="r">${area(p.landArea)}</td>
    <td class="r" title="${p.areaSrc ? 'as filed: ' + p.areaSrc : 'not filed'}">${area(p.area)}</td>
    <td class="r">${n0(p.units)}</td>
    <td class="r">${n0(p.plotCount)}</td>
    <td class="r" title="${p.qprQ ? 'QPR ' + esc(p.qprQuarter || p.qprQ) : 'no QPR filed'}">${p.sold == null ? '<span class="dim">–</span>' : n0(p.sold)}</td>
    <td class="r">${p.unsold == null ? '<span class="dim">–</span>' : n0(p.unsold)}</td>
    <td class="r">${n0(p.buildings)}</td>
    <td class="r">${money(p.totalCost)}</td>
    <td class="r">${p.casesProject + p.casesPromoter ? n0(p.casesProject + p.casesPromoter) : '<span class="dim">0</span>'}</td>
  </tr>`).join('');
  $('#tblProjects').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body ||
    `<tr><td colspan="${COLS.length}" class="empty"><b>No project matches these filters.</b>
       Loosen a chip, or <button class="chip" data-clear="all">clear all filters</button> to see all ${n0(PROJECTS.length)}.</td></tr>`}</tbody></table>`;
  $('#projCount').innerHTML = `${n0(rows.length)} projects` +
    (rows.length > state.limit ? ` · showing first ${n0(state.limit)} — <a href="#" id="moreBtn">show all</a>` : '');
  if ($('#moreBtn')) $('#moreBtn').onclick = (e) => { e.preventDefault(); state.limit = 100000; render(); };
  $$('#tblProjects th').forEach(th => th.onclick = () => {
    const k = th.dataset.sort;
    state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (['name', 'cat', 'promoter', 'status', 'regDate', 'tehsil'].includes(k) ? 1 : -1) };
    render();
  });
  $$('#tblProjects tbody tr').forEach(tr => tr.onclick = () => openDetail(tr.dataset.id));
  requestAnimationFrame(() => {
    const box = $('#tblProjects');
    if (box.scrollWidth > box.clientWidth + 2) {
      const c = $('#projCount');
      if (c && !c.dataset.hinted) {
        c.dataset.hinted = '1';
        c.insertAdjacentHTML('beforeend',
          ' <span class="dim">· scroll sideways for cost and cases</span>');
      }
    }
  });
}

/* ---------------------------------------------------------------- promoters */
function renderPromoters(rows) {
  const allow = new Set(rows.map(r => r.promoterKey));
  const agg = new Map();
  rows.forEach(r => {
    const k = r.promoterKey || '(UNNAMED)';
    let x = agg.get(k);
    if (!x) { x = { key: k, name: r.promoter || k, n: 0, area: 0, land: 0, units: 0, plots: 0, cost: 0, cases: 0, cats: {}, first: null, last: null, ids: [] }; agg.set(k, x); }
    x.n++; x.area += r.area || 0; x.land += r.landArea || 0;
    x.units += r.units || 0; x.plots += r.plotCount || 0; x.cost += r.totalCost || 0;
    x.cases += r.casesProject + r.casesPromoter;
    x.cats[r.cat] = (x.cats[r.cat] || 0) + 1;
    if (r.regDate) { x.first = !x.first || r.regDate < x.first ? r.regDate : x.first; x.last = !x.last || r.regDate > x.last ? r.regDate : x.last; }
    x.ids.push(r.id);
  });
  let list = Array.from(agg.values());
  const s = state.pSort;
  list.sort((a, b) => {
    const x = a[s.key], y = b[s.key];
    if (typeof x === 'string') return s.dir * String(x).localeCompare(String(y));
    return s.dir * ((x || 0) - (y || 0));
  });
  const cols = [['name', 'Promoter', ''], ['n', 'Projects', 'r'], ['area', 'Area', 'r'],
    ['land', 'Land', 'r'], ['units', 'Units', 'r'],
    ['plots', 'Plots', 'r'], ['cost', 'Cost', 'r'], ['cases', 'Cases', 'r'],
    ['first', 'First reg', ''], ['last', 'Last reg', '']];
  const head = cols.map(([k, l, c]) => `<th scope="col" class="${c}" data-psort="${k}"` +
    (s.key === k ? ` aria-sort="${s.dir > 0 ? 'ascending' : 'descending'}"` : '') +
    `>${l}${s.key === k ? `<span class="ar">${s.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('');
  const body = list.map(x => `<tr class="click" data-prom="${esc(x.key)}">
    <td class="wrap">${clamp2(x.name, 340, x.name)}</td>
    <td class="r">${n0(x.n)}</td>
    <td class="r">${area(x.area)}</td>
    <td class="r">${area(x.land)}</td>
    <td class="r">${n0(x.units)}</td>
    <td class="r">${n0(x.plots)}</td>
    <td class="r">${money(x.cost)}</td>
    <td class="r">${x.cases ? n0(x.cases) : '<span class="dim">0</span>'}</td>
    <td class="mono dim">${x.first || '–'}</td>
    <td class="mono dim">${x.last || '–'}</td>
  </tr>`).join('');
  $('#tblPromoters').innerHTML = `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  $$('#tblPromoters th').forEach(th => th.onclick = () => {
    const k = th.dataset.psort;
    state.pSort = { key: k, dir: state.pSort.key === k ? -state.pSort.dir : (k === 'name' || k === 'first' || k === 'last' ? 1 : -1) };
    render();
  });
  $$('#tblPromoters tbody tr').forEach(tr => tr.onclick = () => {
    state.prom = new Set([tr.dataset.prom]);
    state.tab = 'projects';
    render();
    toast('Filtered to promoter — ' + n0(filtered().length) + ' projects');
  });
  $('#promCount').textContent = `${n0(list.length)} promoters in the current selection`;
}

/* -------------------------------------------------------------------- pivot */
const PIVOT_ROWS = [
  ['promoter', 'Promoter'], ['cat', 'Category'], ['regYear', 'Registration year'],
  ['tehsil', 'Tehsil'], ['status', 'Status'], ['promoterType', 'Promoter type'],
  ['sizeBand', 'Project size band'], ['village', 'Village'],
];
const PIVOT_METRICS = [
  ['area', 'Built up / saleable area'], ['saleable', 'Saleable area (own column)'],
  ['builtUp', 'Built-up area (own column)'], ['landArea', 'Land area'],
  ['units', 'Units'], ['plotCount', 'Plots'], ['totalCost', 'Estimated cost'],
  ['casesProject', 'Cases'], ['count', 'Project count'], ['buildings', 'Buildings'],
  ['openSpace', 'Open space'],
];

function sizeBand(p) {
  const a = p.area || 0;
  const q = state.unit === 'sqft' ? a * SQM2SQF : a;
  if (!q) return 'n/a';
  if (q < 1000) return '<1k';
  if (q < 5000) return '1k–5k';
  if (q < 20000) return '5k–20k';
  if (q < 100000) return '20k–100k';
  return '100k+';
}

function renderPivot(rows) {
  const { row, metric } = state.pivot;
  const fmt = metric === 'totalCost' ? money : (['area', 'saleable', 'builtUp', 'landArea', 'openSpace'].includes(metric) ? (v) => area(v) : n0);
  const g = new Map();
  rows.forEach(r => {
    const k = row === 'sizeBand' ? sizeBand(r) : (r[row] || '—');
    let x = g.get(k);
    if (!x) { x = { key: k, n: 0, area: 0, landArea: 0, units: 0, plotCount: 0, totalCost: 0, casesProject: 0, buildings: 0, openSpace: 0, ids: [] }; g.set(k, x); }
    x.n++;
    x.area += r.area || 0;
    x.landArea += r.landArea || 0;
    x.units += r.units || 0;
    x.plotCount += r.plotCount || 0;
    x.totalCost += r.totalCost || 0;
    x.casesProject += r.casesProject + r.casesPromoter;
    x.buildings += r.buildings || 0;
    x.openSpace += r.openSpace || 0;
    x.ids.push(r.id);
  });
  let list = Array.from(g.values()).sort((a, b) => (b[metric] || 0) - (a[metric] || 0));
  const total = rows.length;
  const sumMetric = list.reduce((a, b) => a + (b[metric] || 0), 0);
  const body = list.map(x => `<tr>
    <td class="wrap">${clamp2(x.key, 400)}</td>
    <td class="r">${n0(x.n)}</td>
    <td class="r dim">${(100 * x.n / Math.max(total, 1)).toFixed(1)}%</td>
    <td class="r"><b>${fmt(x[metric] || 0)}</b></td>
    <td class="r dim">${sumMetric ? (100 * (x[metric] || 0) / sumMetric).toFixed(1) : '0.0'}%</td>
    <td class="r">${area(x.area)}</td>
    <td class="r">${n0(x.units)}</td>
    <td class="r">${n0(x.plotCount)}</td>
    <td class="r">${money(x.totalCost)}</td>
    <td class="r">${x.casesProject ? n0(x.casesProject) : '<span class="dim">0</span>'}</td>
  </tr>`).join('');
  $('#tblPivot').innerHTML = `<table>
    <thead><tr>
      <th>${esc((PIVOT_ROWS.find(x => x[0] === row) || [, 'Group'])[1])}</th>
      <th class="r">Projects</th><th class="r">% of count</th>
      <th class="r">${esc((PIVOT_METRICS.find(x => x[0] === metric) || [, 'Metric'])[1])}</th>
      <th class="r">% share</th>
      <th class="r">Area</th><th class="r">Units</th>
      <th class="r">Plots</th><th class="r">Cost</th><th class="r">Cases</th>
    </tr></thead>
    <tbody>${body}</tbody>
    <tfoot><tr>
      <td><b>Total</b></td><td class="r"><b>${n0(total)}</b></td><td></td>
      <td class="r"><b>${fmt(sumMetric)}</b></td><td></td>
      <td class="r">${area(sum(rows, r => r.area))}</td>
      <td class="r">${n0(sum(rows, r => r.units))}</td>
      <td class="r">${n0(sum(rows, r => r.plotCount))}</td>
      <td class="r">${money(sum(rows, r => r.totalCost))}</td>
      <td class="r">${n0(sum(rows, r => r.casesProject + r.casesPromoter))}</td>
    </tr></tfoot></table>`;
  $('#pivotNote').textContent =
    `${n0(list.length)} groups · ${n0(total)} projects · amounts in ${areaUnit()} · period ` +
    (state.dateFrom || state.dateTo ? `${state.dateFrom || '…'} → ${state.dateTo || '…'}` : (state.year || 'all years'));
}

/* -------------------------------------------------------------------- cases */
function casesFor(rows) {
  const ids = new Set(rows.map(r => r.id));
  const keys = new Set(rows.map(r => r.promoterKey));
  return COMPLAINTS.filter(c => {
    if (!c.match) return false;
    if (c.match.type === 'project') return ids.has(c.match.id);
    return (c.match.ids || []).some(i => ids.has(i));
  });
}

function renderCases(rows) {
  const list = casesFor(rows);
  const head = ['#', 'Case', 'Respondent', 'Project named in filing', 'Complainant', 'Status id', 'Match', 'Updated'];
  $('#tblCases').innerHTML = `<table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead>
    <tbody>${list.map(c => `<tr>
      <td class="mono">${esc((c.no || '').replace('RAJ-RERA-C-N-', ''))}</td>
      <td class="dim">${esc(c.title || '')}</td>
      <td class="wrap">${clamp2(c.respondent, 260)}</td>
      <td class="wrap">${clamp2((c.project || '').slice(0, 40), 200, c.project)}</td>
      <td class="wrap">${clamp2(c.citizen, 160)}</td>
      <td class="r mono">${esc(c.statusId)}</td>
      <td><span class="pill ${c.match.type === 'project' ? 'pl' : 'cm'}">${c.match.type}</span></td>
      <td class="mono dim">${esc(c.updated || '')}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#caseCount').innerHTML = `${n0(list.length)} cases linked to the current selection ` +
    `(of ${n0(META.complaints.statewide)} statewide). <b>Every case names a respondent — the builder — not a project.</b> ` +
    `The portal's own <code>ProjectName</code> column is empty on all ${n0(META.complaints.statewide)} rows, ` +
    `so a project's case count is its promoter's case count in Jaipur, not a case filed against that project.`;
}

/* ------------------------------------------------------------------- agents */
async function renderAgents() {
  if (!AGENTS) {
    const r = await fetch('data/agents.json');
    AGENTS = await r.json();
  }
  const q = state.q.trim().toUpperCase();
  const list = AGENTS.filter(a => !q || (a.name || '').toUpperCase().includes(q) || (a.cert || '').includes(q));
  $('#tblAgents').innerHTML = `<table><thead><tr><th>Agent</th><th>Certificate</th><th>Approved</th></tr></thead>
    <tbody>${list.slice(0, 800).map(a => `<tr>
      <td>${esc(a.name)}</td><td class="mono">${esc(a.cert)}</td><td class="mono dim">${esc(a.approved || '')}</td>
    </tr>`).join('')}</tbody></table>`;
  $('#agentCount').textContent = `${n0(list.length)} registered agents in Jaipur district`;
}

/* ------------------------------------------------------------------ quality */
function renderQuality() {
  const cov = META.coverage;
  const rows = [
    ['Built up / saleable (portal field)', cov.area],
    ['Saleable area, own column', cov.saleable],
    ['Built-up area (FSI), own column', cov.builtUp],
    ['Land / plot area', cov.landArea], ['Unit inventory', cov.units],
    ['Plot inventory', cov.plotCount], ['Estimated cost', cov.totalCost],
    ['Registration date', cov.regDate], ['Carpet area', cov.carpetAvg], ['Plot sizes', cov.plotMin],
    ['QPR filed (latest filing)', cov.qprQ], ['QPR booked count', cov.sold],
  ];
  $('#covTable').innerHTML = `<table><thead><tr><th>Field</th><th class="r">Projects with a value</th><th class="r">Coverage</th></tr></thead>
    <tbody>${rows.map(([l, c]) => `<tr><td>${l}</td><td class="r">${n0(c.n)}</td>
      <td class="r ${c.pct < 50 ? 'dim' : ''}">${c.pct}%</td></tr>`).join('')}</tbody></table>`;
  const excl = $('#covExcluded');
  if (excl) {
    excl.innerHTML = `<p class="mini dim" style="margin:10px 0 0;max-width:64ch">Excluded as unreliable:
      the Form-B inventory rows carry a Sold / Unsold status, but their <code>count</code> column repeats a
      type's total on every row (one project summed to 267,802 units in a district of 129,571) and unsold
      comes back 0 almost everywhere. Booked and unsold figures therefore come only from the promoter's
      QPR, and units and plots are counted together because that is how the QPR reports them.</p>`;
  }
  const cs = META.complaints;
  $('#caseQuality').innerHTML = `<table><thead><tr><th>Complaint register</th><th class="r">Rows</th></tr></thead><tbody>
    <tr><td>Statewide complaints scraped</td><td class="r">${n0(cs.statewide)}</td></tr>
    <tr><td>Matched to a Jaipur project (by name)</td><td class="r">${n0(cs.matched)}</td></tr>
    <tr><td>Not matched to a Jaipur project</td><td class="r">${n0(cs.unmatched)}</td></tr></tbody></table>
    <p class="dim mini" style="margin:10px 0 0">The public register has a <code>ProjectName</code> column that is
    <b>empty on every row</b> (${n0(cs.withProjectName)} of ${n0(cs.statewide)} populated). Cases are therefore
    linked to the <b>respondent/builder</b>, normalised to a promoter key. A project's case count is its
    promoter's case count in Jaipur — it is not a case filed against that project.</p>`;
}

/* ------------------------------------------------------------------- modal */
async function openDetail(id) {
  const p = PROJECTS.find(x => String(x.id) === String(id));
  if (!p) return;
  const bg = $('#modalBg');
  bg.classList.add('on');
  document.body.style.overflow = 'hidden';
  $('#modalBody').innerHTML = `<h2>${esc(p.name)}</h2><div class="sub">loading detail…</div>`;
  let det = detailCache.get(p.id);
  if (!det) {
    try {
      const r = await fetch('data/detail/' + p.id + '.json');
      det = await r.json();
      detailCache.set(p.id, det);
    } catch (e) { det = null; }
  }
  const cases = COMPLAINTS.filter(c => c.match && ((c.match.type === 'project' && c.match.id === p.id) ||
    (c.match.ids || []).includes(p.id)));
  const kv = [
    ['Application', det && det.appNo], ['Category', p.cat],
    ['Status', statusLabel(p.status || p.app)], ['Registered', p.regDate], ['Approved', det && det.approvedOn],
    ['Original completion', p.completion], ['Revised completion', p.revCompletion],
    ['Tehsil', p.tehsil], ['Village', p.village], ['PIN', p.pin],
    ['Promoter type', p.promoterType], ['Org type', det && det.promoterOrgType],
    ['Promoter projects (portal)', det && det.promoterProjects ? det.promoterProjects.length : null],
  ].filter(x => x[1]);
  // One declared figure, with the source named on its own label. The raw columns are
  // only shown when they add information — i.e. when both were filed and disagree.
  const areaRows = [
    ['Land / plot area', p.landArea], ['Open space', p.openSpace],
    [p.areaSrc === 'built-up' ? 'Declared area (filed as built-up)'
      : p.areaSrc === 'saleable' ? 'Declared area (filed as saleable)'
        : 'Declared area', p.area],
    ...(p.builtUp && p.area && p.builtUp !== p.area ? [['also filed: built-up (FSI)', p.builtUp]] : []),
    ...(p.saleable && p.area && p.saleable !== p.area ? [['also filed: saleable', p.saleable]] : []),
    ['Not-approved built-up', det && det.notApprovedBuiltUp],
  ];
  const bRows = [
    ['Building entries (form)', p.buildings], ['Sanctioned (portal)', p.bSanctioned], ['Not sanctioned (portal)', p.bUnsanctioned],
    ['Blocks', p.blocks], ['Floors per block', det && det.floors], ['Basements', det && det.basement],
    ['Stilts', det && det.stilt], ['Podiums', det && det.podium], ['Plinths', det && det.plinth],
    ['Open parking', det && det.parkingOpen], ['Covered parking', det && det.parkingClose],
    ['Cars (common area)', det && det.cars], ['Two-wheelers', det && det.twoWheelers],
  ];
  const inv = det && det.unitInventory ? det.unitInventory : [];
  const plInv = det && det.plotInventory ? det.plotInventory : [];
  const cleanType = (t) => (t || '—').replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim();
  const mix = {};
  inv.forEach(u => {
    const k = cleanType(u.type);
    mix[k] = mix[k] || { n: 0, carpet: u.carpet };
    mix[k].n += (u.n || 0);
  });
  const cost = det && det.costDetail ? det.costDetail.filter(c => (c.e || 0) > 0) : [];

  $('#modalBody').innerHTML = `
    <button class="x" id="mClose" aria-label="Close project detail">Close</button>
    <h2>${esc(p.name)}</h2>
    <div class="sub">${esc(p.promoter)} · ${esc(p.cat)} · ${esc(p.regNo)} ·
      <a href="https://rera.rajasthan.gov.in/ProjectDetail?id=${esc(p.encId || '')}&type=U" target="_blank" rel="noopener">portal page ↗</a></div>

    <div class="kv">${kv.map(([a, b]) => `<div><span>${a}</span><span>${esc(b)}</span></div>`).join('')}</div>

    <h4>Areas (${areaUnit()})</h4>
    <div class="kv">${areaRows.filter(x => x[1]).map(([a, b]) => `<div><span>${a}</span><span>${area(b)}</span></div>`).join('')}</div>

    ${bRows.filter(x => x[1]).length ? `<h4>Building configuration</h4>
    <div class="kv">${bRows.filter(x => x[1]).map(([a, b]) => `<div><span>${a}</span><span>${esc(b)}</span></div>`).join('')}</div>`
      : `<h4>Building configuration</h4>
    <p class="mini dim" style="margin:0 0 4px">Nothing to configure: this is a plotted layout with
      ${n0(p.plotCount)} plots and no built inventory.</p>`}

    <h4>Unit inventory — ${n0(p.units)} units, ${n0(p.plotCount)} plots</h4>
    <div class="tbl-wrap">
      <table class="mini"><thead><tr><th>Unit type</th><th class="r">Count</th><th class="r">Carpet (${areaUnit()})</th></tr></thead>
      <tbody>${Object.entries(mix).sort((a, b) => b[1].n - a[1].n).slice(0, 40).map(([k, v]) =>
        `<tr><td class="wrap">${clamp2(k)}</td><td class="r">${n0(v.n)}</td><td class="r">${area(v.carpet, 1)}</td></tr>`).join('')
      || `<tr><td colspan="3" class="empty">The promoter filed no unit-type rows for this project${
        p.plotCount ? '; inventory is by plot, below.' : '.'}</td></tr>`}</tbody></table>
    </div>
    ${plInv.length ? `<div class="kv" style="margin-top:8px">
      <div><span>Plot sizes</span><span>${area(p.plotMin, 1)} – ${area(p.plotMax, 1)} ${areaUnit()}</span></div>
      <div><span>Booked / unsold (QPR)</span><span>${
        (p.sold != null || p.unsold != null)
          ? `${n0(p.sold)} / ${n0(p.unsold)}${p.pctSold != null ? ` · ${p.pctSold}%` : ''}`
          : 'Not filed'}</span></div>
      <div><span>Funnel</span><span>${n0((p.units || 0) + (p.plotCount || 0))} proposed · ${
        p.sanctioned != null ? n0(p.sanctioned) : '–'} sanctioned</span></div></div>` : ''}

    <h4>QPR / APR filings</h4>
    ${(() => {
      const hist = (det && det.qprHistory) || [];
      if (!hist.length) {
        return `<p class="mini dim" style="margin:0 0 4px">No quarterly progress report filed for this
          project.${p.aprYear ? ` Last annual report: FY ${esc(p.aprYear)}.` : ''}</p>`;
      }
      const rows = hist.map(x => `<tr>
        <td>${esc(x.quarter || '–')}</td>
        <td class="mono">${x.filedOn || '–'}</td>
        <td class="r">${x.booked == null ? '–' : n0(x.booked)}</td>
        <td class="r">${x.unbooked == null ? '–' : n0(x.unbooked)}</td>
        <td class="r">${x.pctBooked == null ? '–' : x.pctBooked + '%'}</td>
        <td class="r">${x.constPct == null ? '–' : x.constPct + '%'}</td></tr>`).join('');
      return `<p class="mini dim" style="margin:0 0 6px">${n0(p.qprFilings || hist.length)} quarterly filing${(p.qprFilings || hist.length) === 1 ? '' : 's'} on file
        · latest ${esc(p.qprQuarter || '')}${p.qprFiled ? ' filed ' + p.qprFiled : ''}
        ${p.aprYear ? '· last annual report FY ' + esc(p.aprYear) : '· no annual report'}
        ${p.sanctioned != null ? '· ' + n0(p.sanctioned) + ' sanctioned' : ''}</p>
      <table class="mini"><thead><tr><th>Quarter reported</th><th>Filed</th>
        <th class="r">Booked</th><th class="r">Unsold</th><th class="r">% booked</th><th class="r">Construction</th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    })()}
    <h4>Cost estimate (Form-B)</h4>
    <div class="tbl-wrap">
      <table class="mini"><thead><tr><th>Head</th><th class="r">Estimated</th><th class="r">Actual</th></tr></thead>
      <tbody>${cost.slice(0, 30).map(c => `<tr><td class="wrap">${clamp2(c.n || '')}</td>
        <td class="r">${money(c.e)}</td><td class="r">${money(c.a)}</td></tr>`).join('') ||
        '<tr><td colspan="3" class="dim">No cost rows were filed under Form-B.</td></tr>'}</tbody></table>
    </div>

    <h4>Compliance & documents</h4>
    <div class="kv">
      <div><span>Documents on file</span><span>${n0(p.docs)}</span></div>
      <div><span>QPR / APR filings</span><span>${n0(det && det.qpr)} / ${n0(det && det.apr)}</span></div>
      <div><span>Extensions</span><span>${n0(det && det.extensions)}</span></div>
      <div><span>Map revisions</span><span>${n0(det && det.mapRevisions)}</span></div>
      <div><span>Encumbrances</span><span>${n0(det && det.encumbrances)}</span></div>
      <div><span>Special modifications</span><span>${n0(det && det.specialMods)}</span></div>
      <div><span>Cases against this promoter</span><span>${n0(cases.length)}</span></div>
      <div><span>…across their Jaipur portfolio</span><span>${n0(p.promoterProjects || 0)} projects</span></div>
      <div><span>Fees paid</span><span>${money(det && det.fees)}</span></div>
    </div>
    ${cases.length ? `<div class="tbl-wrap" style="max-height:200px;overflow:auto;margin-top:8px">
      <table class="mini"><thead><tr><th>Case</th><th>Respondent</th><th>Status</th><th>Match</th></tr></thead>
      <tbody>${cases.map(c => `<tr><td class="mono">${esc((c.no || '').replace('RAJ-RERA-C-N-', ''))}</td>
        <td class="wrap">${clamp2((c.respondent || '').slice(0, 40))}</td><td class="mono">${esc(c.statusId)}</td>
        <td><span class="pill ${c.match.type === 'project' ? 'pl' : 'cm'}">${c.match.type}</span></td></tr>`).join('')}
      </tbody></table></div>` : ''}
    ${det && det.remark ? `<h4>Promoter remark on file</h4><p class="mini dim" style="margin:0">${esc(det.remark)}</p>` : ''}
  `;
  $('#mClose').onclick = closeDetail;
}

function closeDetail() {
  $('#modalBg').classList.remove('on');
  document.body.style.overflow = '';
}

/* --------------------------------------------------------------------- csv */
function exportCsv() {
  const rows = filtered();
  const cols = ['id', 'name', 'cat', 'status', 'app', 'regNo', 'regDate', 'promoter', 'promoterType',
    'tehsil', 'village', 'pin', 'landArea', 'openSpace', 'area', 'areaSrc', 'saleable', 'builtUp', 'buildings',
    'bSanctioned', 'bUnsanctioned', 'blocks', 'units', 'plotCount', 'carpetMin', 'carpetMax',
    'plotMin', 'plotMax', 'landCost', 'totalCost', 'casesProject', 'casesPromoter', 'docs'];
  const head = cols.join(',') + ',unitMix';
  const body = rows.map(r => cols.map(c => {
    const v = r[c];
    return v == null ? '' : (typeof v === 'string' && /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  }).join(',') + ',"' + esc(JSON.stringify(r.unitMix || {})).replace(/"/g, '""') + '"').join('\n');
  const blob = new Blob([head + '\n' + body], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `jaipur-rera-${rows.length}-projects.csv`;
  a.click();
  toast(`Exported ${n0(rows.length)} rows`);
}

/* -------------------------------------------------------------------- wire */
function resetFilters() {
  state.q = ''; state.cats.clear(); state.statuses.clear(); state.prom.clear();
  state.tehsils.clear(); state.dateFrom = ''; state.dateTo = ''; state.year = '';
  state.minArea = state.maxArea = state.minUnits = state.maxUnits = null;
  state.casesOnly = false; state.plotted = 'any';
  syncInputs();
  render();
}

function syncInputs() {
  $('#q').value = state.q;
  $('#dateFrom').value = state.dateFrom;
  $('#dateTo').value = state.dateTo;
  $('#fYear').value = state.year;
  $('#minArea').value = state.minArea ?? '';
  $('#maxArea').value = state.maxArea ?? '';
  $('#minUnits').value = state.minUnits ?? '';
  $('#maxUnits').value = state.maxUnits ?? '';
  $$('#fCats .chip').forEach(c => c.classList.toggle('on', state.cats.has(c.dataset.cat)));
  $$('#fStatus .chip').forEach(c => c.classList.toggle('on', state.statuses.has(c.dataset.status)));
  $$('#fTehsil .chip').forEach(c => c.classList.toggle('on', state.tehsils.has(c.dataset.tehsil)));
}

function debounce(fn, ms = 220) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function wire() {
  $$('.tab').forEach(t => t.onclick = () => {
    state.tab = t.dataset.tab;
    history.replaceState(null, '', '#' + state.tab);
    render();
  });
  $('#q').oninput = debounce(e => { state.q = e.target.value; render(); });
  $('#fCats').onclick = (e) => {
    const c = e.target.closest('[data-cat]'); if (!c) return;
    const k = c.dataset.cat;
    state.cats.has(k) ? state.cats.delete(k) : state.cats.add(k);
    c.classList.toggle('on'); c.setAttribute('aria-pressed', String(c.classList.contains('on'))); render();
  };
  if ($('#qprSort')) $('#qprSort').onchange = () => render();
  if ($('#qprScope')) $('#qprScope').onchange = () => render();

  $('#fStatus').onclick = (e) => {
    const c = e.target.closest('[data-status]'); if (!c) return;
    const k = c.dataset.status;
    state.statuses.has(k) ? state.statuses.delete(k) : state.statuses.add(k);
    c.classList.toggle('on'); c.setAttribute('aria-pressed', String(c.classList.contains('on'))); render();
  };
  $('#fTehsil').onclick = (e) => {
    const c = e.target.closest('[data-tehsil]'); if (!c) return;
    const k = c.dataset.tehsil;
    state.tehsils.has(k) ? state.tehsils.delete(k) : state.tehsils.add(k);
    c.classList.toggle('on'); c.setAttribute('aria-pressed', String(c.classList.contains('on'))); render();
  };
  $('#fYear').onchange = (e) => { state.year = e.target.value; state.dateFrom = state.dateTo = ''; syncInputs(); render(); };
  $('#dateFrom').onchange = (e) => { state.dateFrom = e.target.value; state.year = ''; syncInputs(); render(); };
  $('#dateTo').onchange = (e) => { state.dateTo = e.target.value; state.year = ''; syncInputs(); render(); };
  const numIn = (id, key) => $('#' + id).onchange = (e) => {
    state[key] = e.target.value === '' ? null : Number(e.target.value); render();
  };
  numIn('minArea', 'minArea'); numIn('maxArea', 'maxArea');
  numIn('minUnits', 'minUnits'); numIn('maxUnits', 'maxUnits');
  $('#casesOnly').onchange = (e) => { state.casesOnly = e.target.checked; render(); };
  $('#plotted').onchange = (e) => { state.plotted = e.target.value; render(); };
  const doReset = () => resetFilters();
  if ($('#reset')) $('#reset').onclick = doReset;
  if ($('#reset2')) $('#reset2').onclick = doReset;
  $('#export').onclick = exportCsv;
  $('#unitToggle').onclick = () => {
    state.unit = state.unit === 'sqm' ? 'sqft' : 'sqm';
    const toSqft = state.unit === 'sqm';
    $('#unitToggle').textContent = toSqft ? 'Show in ft²' : 'Show in m²';
    $('#unitToggle').setAttribute('aria-pressed', String(!toSqft));
    render();
  };
  $('#fActive').onclick = (e) => {
    const x = e.target.closest('[data-clear]'); if (!x) return;
    const v = x.dataset.clear;
    if (v === 'all') return resetFilters();
    if (v === 'q') state.q = '';
    else if (v.startsWith('cat:')) state.cats.delete(v.slice(4));
    else if (v.startsWith('status:')) state.statuses.delete(v.slice(7));
    else if (v.startsWith('tehsil:')) state.tehsils.delete(v.slice(7));
    else if (v.startsWith('prom:')) state.prom.delete(v.slice(5));
    else if (v === 'year') state.year = '';
    else if (v === 'dates') { state.dateFrom = state.dateTo = ''; }
    else if (v === 'area') { state.minArea = state.maxArea = null; }
    else if (v === 'units') { state.minUnits = state.maxUnits = null; }
    else if (v === 'cases') state.casesOnly = false;
    else if (v === 'plotted') state.plotted = 'any';
    syncInputs();
    render();
  };
  $('#pRow').onchange = (e) => { state.pivot.row = e.target.value; render(); };
  $('#pMetric').onchange = (e) => { state.pivot.metric = e.target.value; render(); };
  $('#modalBg').onclick = (e) => { if (e.target.id === 'modalBg') closeDetail(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDetail(); });

  // promoter picker
  const pp = $('#promPick');
  pp.oninput = debounce(() => {
    const q = pp.value.trim().toUpperCase();
    if (!q) { $('#promList').innerHTML = ''; return; }
    const list = PROMOTERS.filter(p => (p.name || '').toUpperCase().includes(q) || (p.key || '').includes(q)).slice(0, 30);
    $('#promList').innerHTML = list.map(p =>
      `<div class="chip" data-promadd="${esc(p.key)}" style="display:block;margin:3px 0">
        ${esc(p.name)} <small>${n0(p.projects)} projects · ${n0(p.area)} m²</small></div>`).join('')
      || '<div class="dim mini" style="padding:6px">no match</div>';
  });
  $('#promList').onclick = (e) => {
    const c = e.target.closest('[data-promadd]'); if (!c) return;
    state.prom.add(c.dataset.promadd);
    $('#promPick').value = ''; $('#promList').innerHTML = '';
    render();
  };

  // keep sticky offsets honest
  const bar = $('#topbar');
  const setBar = () => document.documentElement.style.setProperty('--bar-h', (bar.offsetHeight + 44) + 'px');
  new ResizeObserver(setBar).observe(bar);
  window.addEventListener('resize', debounce(() => { setBar(); render(); }, 200));
  setBar();
}

boot();
