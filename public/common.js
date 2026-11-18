'use strict';
const $ = (s, r = document) => r.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) { if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? e.style.setProperty(sk, sv) : (e.style[sk] = sv); } else if (k.startsWith('data-') || k.startsWith('aria-') || k === 'role') e.setAttribute(k, v); else e[k] = v; }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k); return e; };
const pad = (n, w = 2) => String(n).padStart(w, '0');
const fmtDate = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const fmtTime = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
const dur = (a, b) => { const s = Math.round((new Date(b) - new Date(a)) / 1000); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s/60)}m ${s%60}s` : `${Math.floor(s/3600)}h ${Math.floor(s%3600/60)}m`; };
let cfg = {}; fetch('/api/config').then(r => r.json()).then(c => cfg = c);

/* theme */
const setTheme = (t) => { document.documentElement.dataset.theme = t; localStorage.setItem('nb-theme', t); $('#themeBtn').textContent = t === 'dark' ? '☀ Light' : '☾ Dark'; };
setTheme(document.documentElement.dataset.theme); $('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');

/* toast, tooltip, copy */
const toast = (m) => { const t = $('#toast'); t.textContent = m; t.classList.add('show'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), 3500); };
const copyBtn = (text, label = '⧉') => { const b = el('button', { type: 'button', className: 'copy', title: 'Copy', textContent: label });
  b.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(text).then(() => toast('Copied')); }; return b; };
const tip = $('#tip');
const hoverTip = (node, html) => { node.addEventListener('mousemove', (e) => { tip.replaceChildren(...html()); tip.style.opacity = 1;
    const x = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8); tip.style.left = x + 'px'; tip.style.top = (e.clientY + 16) + 'px'; });
  node.addEventListener('mouseleave', () => tip.style.opacity = 0); };

/* verdict kinds -> status role + icon + label */
const KINDS = {
  'exception':          { c: 'var(--critical)', i: '✕', label: 'Booking exception' },
  'supplier':           { c: 'var(--critical)', i: '⊘', label: 'Supplier rejected' },
  'payment-error':      { c: 'var(--serious)',  i: '!', label: 'Payment error' },
  'payment-incomplete': { c: 'var(--warning)',  i: '‖', label: 'Payment not completed', dark: true },
  'not-booked-bm':      { c: 'var(--serious)',  i: '✕', label: 'Not booked · Banque Misr' },
  'supplier-ok':        { c: 'var(--good)',     i: '✓', label: 'Supplier OK · check after' },
  'no-booking':         { c: 'var(--neutral)',  i: '–', label: 'No booking attempt' },
  'unknown':            { c: 'var(--neutral)',  i: '?', label: 'Unclear' },
};
const ORDER = Object.keys(KINDS);
const pill = (kind) => { const k = KINDS[kind] || KINDS.unknown;
  return el('span', { className: 'pill', style: { '--c': k.c } }, el('span', { className: 'ico' + (k.dark ? ' dark-ink' : ''), textContent: k.i, 'aria-hidden': 'true' }), k.label); };

/* phases */
const PH = [['search', 'Search'], ['fare', 'Fare confirm'], ['pax', 'Passengers'], ['reprice', 'Reprice'], ['payment', 'Payment'], ['book', 'Supplier booking']];
const stopIndex = (p, kind) => { if (!p || kind === 'supplier-ok') return -1; let last = -1; PH.forEach(([k], i) => { if (p[k]) last = i; }); return last; };
const mini = (p, kind) => { const stop = stopIndex(p, kind);
  const m = el('div', { className: 'mini', 'aria-label': 'journey' }, PH.map(([k], i) => el('i', { className: `s${p ? p[k] : 0}` + (i === stop ? ' stop' : '') })));
  hoverTip(m, () => PH.map(([k, n], i) => el('div', {}, `${p[k] === 2 ? '✕' : p[k] ? '●' : '○'} ${n}${p[k] === 2 ? ' – error' : ''}${i === stop ? '  ← stopped here' : ''}`))); return m; };
const journey = (p, kind) => { const stop = stopIndex(p, kind);
  return el('div', { className: 'journey' }, PH.map(([k, n], i) => el('div', { className: `step s${p[k]}` + (i === stop ? ' stop' : '') },
    el('div', { className: 'dot', textContent: p[k] === 2 ? '✕' : p[k] ? '✓' : '' }), el('div', { className: 'nm', textContent: n }),
    i === stop ? el('div', { className: 'tag', textContent: 'stopped here' }) : null))); };
const PAY_M = ['bookAndPay', 'processMakePayment', 'getsessionid', 'getTransactionStatus'], PAY_S = ['BanqueMisr', 'TripLink'];
const phaseOf = (e) => { const m = e.method || '', c = e.context || {}, a = c.actionName || '';
  if (m === 'handleBookingException' || ['Hold', 'Book', 'BookAfterHold'].includes(a)) return 'book';
  if (PAY_M.includes(m) || PAY_S.includes(c.externalService)) return 'payment';
  if (m.startsWith('fareReCheck') || a === 'PnrReprice') return 'reprice';
  if (m === 'paxDetails') return 'pax';
  if (m.startsWith('fareConfirm') || ['FareConfirm', 'UpSelling'].includes(a)) return 'fare';
  if (m === 'getSearchResult' || /^search$/i.test(a)) return 'search';
  return 'other'; };
const PHN = Object.fromEntries([...PH, ['other', 'Other']]);

async function api(url, body, method) {
  const r = await fetch(url, body ? { method: method || 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
  const j = await r.json(); if (!r.ok) throw new Error(j.error || r.status); return j; }

const pretty = (s) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

function osdLink(cid) {
  const a = `(query:(language:kuery,query:'attributes.message.correlationId.keyword:"${cid}"'),sort:!(!('@timestamp',asc)))`;
  return `${cfg.osdUrl}/app/data-explorer/discover?security_tenant=${cfg.tenant}#?_a=(discover:(columns:!(_source),sort:!()),metadata:(indexPattern:'${cfg.indexPatternId}',view:discover))&_g=(time:(from:now-30d,to:now))&_q=${a}`; }

/* ---- Send to team leader (Azure DevOps work item comment + PDF) ---- */
// opts: { title, comment, report }  – report is the same payload as the PDF export.
function sendToTeamLeader(opts) {
  const az = (cfg && cfg.azdo) || {};
  const close = () => wrap.remove();
  const body = el('div', { className: 'modal-b' });
  const wrap = el('div', { className: 'modal-wrap', onclick: (e) => { if (e.target === wrap) close(); } },
    el('div', { className: 'modal', role: 'dialog', 'aria-modal': 'true' },
      el('div', { className: 'modal-h' }, el('b', {}, '💬 Send to team leader (Azure DevOps)'), el('div', { style: { flex: 1 } }), el('button', { type: 'button', className: 'iconbtn', onclick: close }, '✕')), body));
  document.body.append(wrap);
  if (!az.configured) {
    body.append(el('div', {}, 'Azure DevOps is not configured. Start the dashboard with ', el('span', { className: 'mono' }, 'AZDO_ORG_URL'), ', ',
      el('span', { className: 'mono' }, 'AZDO_PROJECT'), ' and ', el('span', { className: 'mono' }, 'AZDO_PAT'), ' (a personal access token with Work Items Read & Write; see README / start.ps1).'));
    return;
  }
  const wi = el('input', { type: 'number', min: 1, placeholder: 'e.g. 64120', value: localStorage.getItem('nb-azdo-wi') || '' });
  const wiInfo = el('div', { className: 'muted', style: { fontSize: '12.5px', minHeight: '18px' } });
  const tl = el('input', { type: 'text', placeholder: 'team.leader@tildetech.ae', value: localStorage.getItem('nb-azdo-tl') || az.teamLeader || '' });
  const txt = el('textarea', { rows: 9, value: opts.comment });
  const attach = el('input', { type: 'checkbox', checked: true, style: { minWidth: 0 } });
  const res = el('div');
  const send = el('button', { type: 'button', className: 'primary' }, 'Send');
  let t = null;
  wi.oninput = () => { clearTimeout(t); wiInfo.textContent = ''; const id = +wi.value; if (!id) return;
    t = setTimeout(async () => { try { const w = await api('/api/azdo/workitem?id=' + id); wiInfo.textContent = `${w.type} ${w.id}: ${w.title} · ${w.state}${w.assignedTo ? ' · ' + w.assignedTo : ''}`; }
      catch (e) { wiInfo.textContent = '⚠ ' + e.message; } }, 400); };
  if (wi.value) wi.oninput();
  send.onclick = async () => {
    if (!+wi.value) { toast('Enter the work item number'); return; }
    send.disabled = true; res.replaceChildren(el('div', { className: 'muted' }, 'Sending…'));
    localStorage.setItem('nb-azdo-wi', wi.value); localStorage.setItem('nb-azdo-tl', tl.value.trim());
    try {
      const r = await api('/api/azdo/post', { workItemId: +wi.value, teamLeader: tl.value.trim(), comment: txt.value, attachPdf: attach.checked, report: opts.report });
      res.replaceChildren(el('div', { className: 'fix-ok' }, el('b', {}, '✓ Comment posted'), ` on ${r.workItem.type} ${r.workItem.id}`,
        r.mentioned ? ` · @${r.mentioned} notified` : '', r.attachment ? ` · PDF attached (${r.attachment.fileName})` : '',
        el('div', {}, el('a', { href: r.workItem.url, target: '_blank', rel: 'noopener' }, 'Open the work item ↗'))));
      send.textContent = 'Sent';
    } catch (e) { res.replaceChildren(el('div', { className: 'err' }, '⚠ ' + e.message)); send.disabled = false; }
  };
  body.append(
    el('label', { className: 'field' }, el('span', {}, `Work item (${az.project})`), wi), wiInfo,
    el('label', { className: 'field' }, el('span', {}, 'Team leader (e-mail or name, gets an @mention)'), tl),
    el('label', { className: 'field' }, el('span', {}, 'Comment'), txt),
    el('label', { className: 'switch' }, attach, ' Attach the PDF report'),
    el('div', { className: 'muted', style: { fontSize: '12px' } }, `Posts to ${az.org}/${az.project}. Nothing is sent until you click Send.`),
    el('div', { style: { display: 'flex', gap: '8px' } }, send, el('button', { type: 'button', className: 'iconbtn', onclick: close }, 'Cancel')), res);
  wi.focus();
}

/* loading: a thin top progress bar for every api() call, and a progress panel for long searches */
const progress = (() => {
  let n = 0, pct = 0, timer = null, showT = null, bar = null;
  const node = () => bar || (bar = document.body.appendChild(el('div', { className: 'nb-topbar', role: 'progressbar', 'aria-label': 'Loading' })));
  const set = (p) => { pct = p; node().style.transform = `scaleX(${p / 100})`; };
  return {
    start() { if (n++ > 0) return; clearTimeout(showT);
      showT = setTimeout(() => { const b = node(); b.classList.remove('done'); b.classList.add('on'); set(8);
        timer = setInterval(() => set(pct + (92 - pct) * 0.06), 200); }, 150); },   // quick calls never flash
    done() { if (n === 0 || --n > 0) return; clearTimeout(showT); clearInterval(timer);
      if (!bar || !bar.classList.contains('on')) return; set(100); bar.classList.add('done');
      setTimeout(() => { bar.classList.remove('on', 'done'); set(0); }, 450); },
  };
})();
const _api = api;
api = async (...a) => { progress.start(); try { return await _api(...a); } finally { progress.done(); } };

// Progress panel for a long search, shown under `anchor` (the search card); results below it are dimmed until done.
// The bar follows the time the same search took before (remembered per name), never claims 100% before the answer.
function loadingPanel(anchor, { name, title, steps = [], estimate = 8 }) {
  const key = 'nb-took-' + name; let est = estimate;
  try { const v = +localStorage.getItem(key); if (v > 0) est = v; } catch { /* storage blocked */ }
  const fill = el('div', { className: 'nb-lp-fill' }), step = el('div', { className: 'nb-lp-step' }), time = el('span', { className: 'nb-lp-time num' });
  const list = el('ol', { className: 'nb-lp-steps' }, steps.map((s) => el('li', {}, s)));
  const panel = el('section', { className: 'card nb-lp', role: 'status', 'aria-live': 'polite' },
    el('div', { className: 'nb-lp-head' }, el('span', { className: 'spinner dark' }), el('b', {}, title), el('div', { style: { flex: 1 } }), time),
    el('div', { className: 'nb-lp-bar' }, fill), step, steps.length > 1 ? list : null,
    el('div', { className: 'nb-skel' }, [92, 78, 85, 64].map((w) => el('div', { style: { width: w + '%' } }))));
  anchor.after(panel); const scope = anchor.parentElement; scope.classList.add('nb-busy');
  const t0 = Date.now();
  const tick = () => { const s = (Date.now() - t0) / 1000, f = 1 - Math.exp(-s / (est * 0.6)), p = Math.min(95, f * 100);
    fill.style.width = p.toFixed(1) + '%';
    const i = Math.min(steps.length - 1, Math.floor(f * steps.length));
    if (steps.length) { step.textContent = steps[i] + '…'; [...list.children].forEach((li, j) => { li.className = j < i ? 'ok' : j === i ? 'now' : ''; }); }
    time.textContent = `${s.toFixed(0)} s` + (s > est * 1.5 ? ' · taking longer than usual' : est > 3 ? ` · usually ~${Math.round(est)} s` : ''); };
  tick(); const iv = setInterval(tick, 250);
  return (ok = true) => { clearInterval(iv);
    if (ok) try { localStorage.setItem(key, ((Date.now() - t0) / 1000 * 0.6 + est * 0.4).toFixed(1)); } catch { /* ignore */ }
    fill.style.width = '100%'; scope.classList.remove('nb-busy'); setTimeout(() => panel.remove(), ok ? 200 : 0); };
}

/* XML in payloads: detect, pretty-print and convert to JSON (in the browser, nothing is sent anywhere) */
const XML_START = /<(\?xml|[A-Za-z_][\w.-]*(:[\w.-]+)?[\s>/])/;
// The XML part of a text: the whole text, or the part from the first tag to the last '>' (e.g. "Request: <soap:Envelope…>").
function xmlPart(s) {
  if (typeof s !== 'string') return null; const m = XML_START.exec(s); if (!m) return null;
  const end = s.lastIndexOf('>'); if (end <= m.index) return null;
  const xml = s.slice(m.index, end + 1);
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : { doc, before: s.slice(0, m.index).trim(), after: s.slice(end + 1).trim() };
}
// Element -> JSON: attributes as "@name" (xmlns declarations dropped), repeated children become arrays,
// text-only elements become their text, mixed text goes to "#text". Namespace prefixes are dropped (localName).
function elToJson(e) {
  const o = {};
  for (const a of e.attributes) if (a.name !== 'xmlns' && !a.name.startsWith('xmlns:')) o['@' + a.localName] = a.value;
  let text = '';
  for (const c of e.childNodes) {
    if (c.nodeType === 1) { const k = c.localName, v = elToJson(c); if (k in o) { if (!Array.isArray(o[k])) o[k] = [o[k]]; o[k].push(v); } else o[k] = v; } // child values are never arrays
    else if (c.nodeType === 3 || c.nodeType === 4) text += c.nodeValue;
  }
  text = text.trim();
  if (!Object.keys(o).length) return text;
  if (text) o['#text'] = text;
  return o;
}
const xmlDocToJson = (doc) => ({ [doc.documentElement.localName]: elToJson(doc.documentElement) });
// Whole payload -> JSON: an XML text becomes its JSON; in a JSON payload every string value holding XML is replaced by its JSON.
function payloadToJson(text) {
  const x = xmlPart(text);
  if (x) { const j = xmlDocToJson(x.doc); return x.before || x.after ? { ...(x.before ? { text: x.before } : {}), xml: j, ...(x.after ? { textAfter: x.after } : {}) } : j; }
  let parsed; try { parsed = JSON.parse(text); } catch { return null; }
  let found = false;
  const walk = (v) => { if (typeof v === 'string') { const p = xmlPart(v); if (p) { found = true; return xmlDocToJson(p.doc); } return v; }
    if (Array.isArray(v)) return v.map(walk); if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, walk(w)])); return v; };
  const out = walk(parsed); return found ? out : null;
}
function prettyXml(doc) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const attrs = (e) => [...e.attributes].map((a) => ` ${a.name}="${esc(a.value).replace(/"/g, '&quot;')}"`).join('');
  const rec = (e, ind) => { const kids = [...e.childNodes].filter((c) => c.nodeType === 1 || ((c.nodeType === 3 || c.nodeType === 4) && c.nodeValue.trim()));
    if (!kids.length) return `${ind}<${e.nodeName}${attrs(e)}/>`;
    if (kids.every((c) => c.nodeType !== 1)) return `${ind}<${e.nodeName}${attrs(e)}>${esc(kids.map((c) => c.nodeValue.trim()).join(' '))}</${e.nodeName}>`;
    return `${ind}<${e.nodeName}${attrs(e)}>\n${kids.map((c) => c.nodeType === 1 ? rec(c, ind + '  ') : ind + '  ' + esc(c.nodeValue.trim())).join('\n')}\n${ind}</${e.nodeName}>`; };
  return rec(doc.documentElement, '');
}
// A payload block with copy, and when it contains XML: a Raw / XML / JSON switch and a .json download.
function payloadBlock(label, raw) {
  const original = typeof raw === 'string' ? pretty(raw) : JSON.stringify(raw, null, 2);
  const src = typeof raw === 'string' ? raw : JSON.stringify(raw);
  const pre = el('pre'); showText(pre, original);
  let current = original;
  const json = payloadToJson(src);
  const head = el('div', { className: 'ph' }, el('span', {}, label));
  const tools = el('span', { className: 'ph-tools' });
  if (json) {
    const x = xmlPart(src);
    const views = { raw: original, ...(x ? { xml: [x.before, prettyXml(x.doc), x.after].filter(Boolean).join('\n') } : {}), json: JSON.stringify(json, null, 2) };
    const seg = el('span', { className: 'seg seg-sm' }, Object.keys(views).map((k) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(k === 'raw'), title: k === 'json' ? 'XML converted to JSON (attributes as @name)' : k === 'xml' ? 'XML indented' : 'As logged' }, k.toUpperCase());
      b.onclick = () => { current = views[k]; showText(pre, current); [...seg.children].forEach((c) => c.setAttribute('aria-pressed', String(c === b))); };
      return b; }));
    const dl = el('button', { type: 'button', className: 'copy', title: 'Download as .json' }, '⤓ .json');
    dl.onclick = () => { const a = el('a', { href: URL.createObjectURL(new Blob([views.json], { type: 'application/json' })), download: `${label}.json` }); a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); };
    tools.append(el('span', { className: 'pill', style: { '--c': 'var(--accent)' }, title: 'This payload contains XML: switch to JSON to read it as JSON' }, 'contains XML'), seg, dl);
  }
  const cp = el('button', { type: 'button', className: 'copy', title: 'Copy what is shown' }, 'copy');
  cp.onclick = (e) => { e.stopPropagation(); navigator.clipboard.writeText(current).then(() => toast('Copied')); };
  tools.append(cp); head.append(tools);
  return el('div', {}, head, pre);
}

/* JSON colouring: keys, strings, numbers, true/false/null and punctuation get their own colour.
   Built with text nodes (never innerHTML), so payload content cannot inject markup. */
const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],]/g;
function highlightJson(text) {
  const frag = document.createDocumentFragment(); let last = 0, m;
  const span = (cls, t) => frag.append(el('span', { className: cls, textContent: t }));
  JSON_TOKEN.lastIndex = 0;
  while ((m = JSON_TOKEN.exec(text))) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1]) { if (m[2]) { span('j-key', m[1]); span('j-pun', m[2]); } else span('j-str', m[1]); }
    else if (m[3]) span('j-bool', m[0]);
    else if (m[0] === 'null') span('j-null', m[0]);
    else if (/^[{}\[\],]$/.test(m[0])) span('j-pun', m[0]);
    else span('j-num', m[0]);
    last = JSON_TOKEN.lastIndex;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}
// Colour the text when it is JSON (very large payloads stay plain to keep the page fast).
function showText(pre, text) {
  let isJson = false; const t = text.trim();
  if (t.length < 400000 && /^[{\[]/.test(t)) { try { JSON.parse(t); isJson = true; } catch { /* not JSON */ } }
  pre.classList.toggle('json', isJson);
  if (isJson) pre.replaceChildren(highlightJson(text)); else pre.textContent = text;
}
