// PDF export of the cases result table: HTML report rendered to PDF by headless Edge/Chrome (no extra packages).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const BROWSER = process.env.PDF_BROWSER || [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
// Times shown in the timezone the user's browser sent (default Africa/Cairo).
const fmt = (iso, tz) => {
  if (!iso) return '';
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  } catch { return iso; }
};

const KIND = {
  'exception': ['#d03b3b', 'Booking exception'], 'supplier': ['#d03b3b', 'Supplier rejected'], 'payment-error': ['#ec835a', 'Payment error'],
  'payment-incomplete': ['#fab219', 'Payment not completed'], 'not-booked-bm': ['#ec835a', 'Not booked · Banque Misr'], 'supplier-ok': ['#0ca30c', 'Supplier OK · check after'],
  'no-booking': ['#898781', 'No booking attempt'], 'unknown': ['#898781', 'Unclear'],
};
const STATE = { ok: ['✓', '#006300'], error: ['✕', '#b42828'], pending: ['‖', '#9a6700'], missing: ['○', '#898781'], none: ['–', '#898781'] };

function renderHtml(d) {
  const tz = d.tz || 'Africa/Cairo';
  const rows = d.rows || [];
  const counts = {}; rows.forEach((r) => { counts[r.kind] = (counts[r.kind] || 0) + 1; });
  const steps = (r) => (r.focus && r.focus.steps ? r.focus.steps : []).map((s) => {
    const [ic, col] = STATE[s.state] || STATE.none;
    return `<div class="st"><b style="color:${col}">${ic}</b> <b>${esc(s.step)}</b>${s.time ? ` <span class="m">${esc(fmt(s.time, tz).slice(11))}</span>` : ''} <span class="d">${esc(s.detail)}</span></div>`;
  }).join('') + (r.focus && r.focus.exception ? `<div class="st"><b style="color:#b42828">✕</b> <b>Exception</b> <span class="d">${esc(r.focus.exception)}</span></div>` : '');
  let prev = null;
  const body = rows.map((r) => {
    const [c, label] = KIND[r.kind] || KIND.unknown;
    const first = r.ref !== prev; prev = r.ref;
    return `<tr class="${first ? 'grp' : ''}">
      <td class="mono">${first ? `<b>${esc(r.ref || '—')}</b>` : '<span class="m">〃</span>'}${r.created && first ? `<div class="m">created ${esc(fmt(r.created, tz))}</div>` : ''}</td>
      <td><span class="tag" style="border-color:${c};"><i style="background:${c}"></i>${esc(label)}</span><div class="v">${esc(r.verdict)}</div></td>
      <td>${steps(r) || '<span class="m">—</span>'}</td>
      <td><b>${esc(r.agencyCode || '—')}</b><div class="m">${esc(r.agencyName)}</div></td>
      <td>${esc((r.suppliers || []).join(', ') || '—')}</td>
      <td class="nw">${esc(fmt(r.last, tz))}</td>
      <td class="mono m">${esc((r.correlationId || '').slice(0, 16))}…</td>
    </tr>`;
  }).join('');
  const notFound = (d.notFound || []).map((n) => esc(n.ref)).join(', ');
  const other = (d.otherAgency || []).map((o) => `${esc(o.ref)} → ${esc((o.agencies || []).join('/'))}`).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>
@page { size: A4 landscape; margin: 10mm 9mm 12mm; }
* { box-sizing: border-box; }
body { font: 9.5px/1.4 "Segoe UI", system-ui, sans-serif; color: #0b0b0b; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 16px; margin: 0 0 2px; } .sub { color: #52514e; margin-bottom: 8px; }
.sum { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 6px 0 8px; padding: 6px 8px; background: #f3f3f0; border-radius: 6px; }
.sum span b { font-size: 12px; }
table { width: 100%; border-collapse: collapse; }
thead { display: table-header-group; }
th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #52514e; border-bottom: 1.5px solid #c3c2b7; padding: 4px 5px; }
td { padding: 4px 5px; border-bottom: 1px solid #e1e0d9; vertical-align: top; }
tr { page-break-inside: avoid; } tr.grp td { border-top: 1.5px solid #c3c2b7; }
.mono { font-family: Consolas, monospace; font-size: 9px; } .m { color: #898781; } .nw { white-space: nowrap; }
.tag { display: inline-flex; align-items: center; gap: 4px; border: 1px solid; border-radius: 9px; padding: 0 6px; font-weight: 600; font-size: 8.5px; white-space: nowrap; }
.tag i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; }
.v { margin-top: 2px; color: #52514e; } .st { white-space: normal; } .st .d { color: #52514e; }
.foot { margin-top: 8px; color: #52514e; } .foot b { color: #0b0b0b; }
</style></head><body>
<h1>${esc(d.title)}</h1>
<div class="sub">Generated ${esc(fmt(new Date().toISOString(), tz))} (${esc(tz)}) · source: ndc-core-backend-log (OpenSearch) · ${esc(d.query || '')}</div>
<div class="sum">
  <span>Refs searched <b>${esc(d.searched)}</b></span><span>Sessions <b>${rows.length}</b></span>
  ${Object.entries(counts).map(([k, n]) => `<span><i style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${(KIND[k] || KIND.unknown)[0]}"></i> ${esc((KIND[k] || KIND.unknown)[1])} <b>${n}</b></span>`).join('')}
  ${(d.notFound || []).length ? `<span>Not found <b>${d.notFound.length}</b></span>` : ''}
</div>
<table><thead><tr><th style="width:15%">Booking ref</th><th style="width:22%">Verdict</th><th style="width:31%">Pay &amp; book steps</th><th style="width:11%">Agency</th><th style="width:8%">Supplier</th><th style="width:8%">Last activity</th><th>Session</th></tr></thead>
<tbody>${body || '<tr><td colspan="7" class="m">No sessions found.</td></tr>'}</tbody></table>
${notFound ? `<div class="foot"><b>Not found (${d.notFound.length}):</b> <span class="mono">${notFound}</span> – no logs in the search window.</div>` : ''}
${other ? `<div class="foot"><b>Other agency:</b> <span class="mono">${other}</span></div>` : ''}
<div class="foot m">Legend: ✓ done · ✕ error · ‖ waiting (payment started, no result logged) · ○ not reached · – not applicable. Times in ${esc(tz)}.</div>
</body></html>`;
}

// Generic table report: { title, subtitle, tz, summary: [[label, value]], columns: [{ key, label, width?, mono? }], rows: [{...}], footer }
function renderTableHtml(d) {
  const tz = d.tz || 'Africa/Cairo';
  const cols = d.columns || [];
  const cell = (c, v) => `<td class="${c.mono ? 'mono' : ''}">${esc(v == null ? '' : v)}</td>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(d.title)}</title><style>
@page { size: A4 landscape; margin: 10mm 9mm 12mm; }
body { font: 9.5px/1.4 "Segoe UI", system-ui, sans-serif; color: #0b0b0b; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
h1 { font-size: 16px; margin: 0 0 2px; } .sub { color: #52514e; margin-bottom: 8px; }
.sum { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 6px 0 8px; padding: 6px 8px; background: #f3f3f0; border-radius: 6px; } .sum b { font-size: 12px; }
table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; }
th { text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: .04em; color: #52514e; border-bottom: 1.5px solid #c3c2b7; padding: 4px 5px; }
td { padding: 3px 5px; border-bottom: 1px solid #e1e0d9; vertical-align: top; } tr { page-break-inside: avoid; }
.mono { font-family: Consolas, monospace; font-size: 9px; } .foot { margin-top: 8px; color: #52514e; }
</style></head><body>
<h1>${esc(d.title)}</h1>
<div class="sub">Generated ${esc(fmt(new Date().toISOString(), tz))} (${esc(tz)})${d.subtitle ? ' · ' + esc(d.subtitle) : ''}</div>
${(d.summary || []).length ? `<div class="sum">${d.summary.map(([k, v]) => `<span>${esc(k)} <b>${esc(v)}</b></span>`).join('')}</div>` : ''}
<table><thead><tr>${cols.map((c) => `<th${c.width ? ` style="width:${esc(c.width)}"` : ''}>${esc(c.label)}</th>`).join('')}</tr></thead>
<tbody>${(d.rows || []).map((r) => `<tr>${cols.map((c) => cell(c, c.time ? fmt(r[c.key], tz) : r[c.key])).join('')}</tr>`).join('') || `<tr><td colspan="${cols.length}">No rows.</td></tr>`}</tbody></table>
${d.footer ? `<div class="foot">${esc(d.footer)}</div>` : ''}
</body></html>`;
}

function htmlToPdf(html) {
  return new Promise((resolve, reject) => {
    if (!BROWSER) return reject(new Error('Edge/Chrome not found for PDF export (set PDF_BROWSER).'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ndc-pdf-'));
    const htmlFile = path.join(dir, 'report.html'); const pdfFile = path.join(dir, 'report.pdf');
    fs.writeFileSync(htmlFile, html, 'utf8');
    const cleanup = () => fs.rm(dir, { recursive: true, force: true }, () => {});
    execFile(BROWSER, ['--headless=new', '--disable-gpu', '--no-pdf-header-footer', `--user-data-dir=${path.join(dir, 'profile')}`,
      `--print-to-pdf=${pdfFile}`, `file:///${htmlFile.replace(/\\/g, '/')}`], { timeout: 60000, windowsHide: true }, (err) => {
      try {
        if (!fs.existsSync(pdfFile)) throw err || new Error('PDF was not created');
        const buf = fs.readFileSync(pdfFile); cleanup(); resolve(buf);
      } catch (e) { cleanup(); reject(e); }
    });
  });
}

module.exports = { renderHtml, renderTableHtml, htmlToPdf };
