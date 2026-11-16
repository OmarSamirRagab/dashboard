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

async function api(url, body) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : undefined);
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
