'use strict';
/* CRM shared UI: statuses, priorities, pagination, smart search, sidebar app shell.
   Load after common.js on every page. */
const T_STATUS = {
  'new':              { label: 'New',              c: 'var(--accent)',   i: '●' },
  'investigating':    { label: 'Investigating',    c: 'var(--s5)',       i: '⌕' },
  'waiting-supplier': { label: 'Waiting supplier', c: 'var(--warning)',  i: '⏳', dark: true },
  'waiting-agency':   { label: 'Waiting agency',   c: 'var(--serious)',  i: '⏳' },
  'resolved':         { label: 'Resolved',         c: 'var(--good)',     i: '✓' },
  'closed':           { label: 'Closed',           c: 'var(--neutral)',  i: '–' },
};
const T_PRIO = {
  urgent: { label: 'Urgent', c: 'var(--critical)', i: '‼' }, high: { label: 'High', c: 'var(--serious)', i: '!' },
  normal: { label: 'Normal', c: 'var(--neutral)', i: '·' }, low: { label: 'Low', c: 'var(--s-other)', i: '↓', dark: true },
};
const statusPill = (s) => { const m = T_STATUS[s] || T_STATUS.new; return el('span', { className: 'pill', style: { '--c': m.c } }, el('span', { className: 'ico' + (m.dark ? ' dark-ink' : ''), textContent: m.i }), m.label); };
const prioPill = (p) => { const m = T_PRIO[p] || T_PRIO.normal; return el('span', { className: 'prio', title: 'Priority: ' + m.label }, el('span', { className: 'ico' + (m.dark ? ' dark-ink' : ''), style: { background: m.c }, textContent: m.i }), m.label); };

// Pagination control: "1–25 of 4,770 · ‹ 1 2 3 … 191 › · 25 / page"
function paginator({ total, page, size, onChange, sizes = [25, 50, 100] }) {
  const pages = Math.max(1, Math.ceil(total / size)); page = Math.min(Math.max(1, page), pages);
  const go = (p) => onChange(Math.min(Math.max(1, p), pages), size);
  const btn = (label, p, opts = {}) => {
    const b = el('button', { type: 'button', className: 'pg' + (p === page && !opts.nav ? ' cur' : ''), textContent: label, disabled: !!opts.disabled, 'aria-label': opts.aria || ('Page ' + p) });
    if (p === page && !opts.nav) b.setAttribute('aria-current', 'page');
    b.onclick = () => go(p); return b;
  };
  const nums = []; [1, 2, page - 1, page, page + 1, pages - 1, pages].forEach((p) => { if (p >= 1 && p <= pages && !nums.includes(p)) nums.push(p); });
  nums.sort((a, b) => a - b);
  const parts = []; nums.forEach((p, i) => { if (i && p - nums[i - 1] > 1) parts.push(el('span', { className: 'pg-gap', textContent: '…' })); parts.push(btn(String(p), p)); });
  const from = total ? (page - 1) * size + 1 : 0, to = Math.min(total, page * size);
  const sel = el('select', { 'aria-label': 'Rows per page' }, sizes.map((s) => el('option', { value: s, textContent: `${s} / page`, selected: s === size })));
  sel.onchange = () => onChange(1, +sel.value);
  const jump = el('input', { type: 'number', min: 1, max: pages, placeholder: 'Go to', className: 'pg-jump', 'aria-label': 'Go to page' });
  jump.onkeydown = (e) => { if (e.key === 'Enter' && +jump.value) go(+jump.value); };
  return el('div', { className: 'pager' },
    el('span', { className: 'muted num' }, `${from.toLocaleString()}–${to.toLocaleString()} of ${total.toLocaleString()}`),
    el('div', { className: 'pg-btns' }, btn('‹', page - 1, { nav: true, disabled: page <= 1, aria: 'Previous page' }), ...parts,
      btn('›', page + 1, { nav: true, disabled: page >= pages, aria: 'Next page' })),
    pages > 7 ? jump : null, sel);
}
const pageSlice = (rows, page, size) => rows.slice((page - 1) * size, page * size);

// Smart search: ticket id, booking ref, PNR or correlation id → the right page.
function smartGo(v) {
  v = (v || '').trim(); if (!v) return;
  if (/^T-\d+$/i.test(v)) location.href = '/crm?view=tickets&open=' + v.toUpperCase();
  else if (/^[A-Z]{2,}-BR-/i.test(v)) location.href = '/?refs=' + encodeURIComponent(v);
  else if (v.length >= 30) location.href = '/failures?cid=' + encodeURIComponent(v);
  else if (/^[A-Z0-9]{5,8}$/i.test(v)) location.href = '/failures?pnr=' + encodeURIComponent(v.toUpperCase());
  else location.href = '/crm?view=tickets&q=' + encodeURIComponent(v);
}

// Create a ticket from a failure / case row (used on Booking failures and Cases pages).
async function createTicket(data) {
  const r = await api('/api/crm/tickets', data);
  toast(r.created ? `Ticket ${r.ticket.id} created` : `Already tracked as ${r.ticket.id}`);
  return r.ticket;
}

// Sidebar app shell, injected on every page.
(function appShell() {
  const p = location.pathname; const view = new URLSearchParams(location.search).get('view');
  const groups = [
    ['CRM', [['/crm', 'Overview', '◎', p.startsWith('/crm') && view !== 'tickets'],
             ['/crm?view=tickets', 'Tickets', '☰', (p.startsWith('/crm') || p === '/tickets') && view === 'tickets', 'open']]],
    ['Investigate', [['/', 'Cases', '⌕', p === '/' || p === '/index.html'], ['/failures', 'Booking failures', '✕', p.startsWith('/failures')],
                     ['/exceptions', 'Exceptions', '⚡', p.startsWith('/exceptions')]]],
    ['Engineering', [['/performance', 'Performance', '⏱', p.startsWith('/performance')], ['/work', 'My work', '☑', p.startsWith('/work')]]],
  ];
  const search = el('input', { type: 'search', placeholder: 'Ticket, ref, PNR, session…', 'aria-label': 'Search tickets, refs, PNRs, sessions' });
  search.onkeydown = (e) => { if (e.key === 'Enter') smartGo(search.value); };
  const side = el('aside', { className: 'side' },
    el('a', { className: 'side-brand', href: '/crm' }, el('div', { className: 'logo', textContent: 'NB' }),
      el('div', {}, el('b', {}, 'NDC Care'), el('div', { className: 'muted', style: { fontSize: '11.5px' } }, 'Not-booked CRM'))),
    el('div', { className: 'side-search' }, search),
    ...groups.map(([g, links]) => el('nav', { className: 'side-group', 'aria-label': g }, el('div', { className: 'side-h', textContent: g }),
      ...links.map(([href, label, icon, active, badge]) => el('a', { className: 'side-link' + (active ? ' active' : ''), href, 'aria-current': active ? 'page' : 'false' },
        el('span', { className: 'side-ico', textContent: icon }), el('span', { className: 'side-lab', textContent: label }),
        badge ? el('span', { className: 'side-badge', id: 'badge-' + badge, hidden: true }) : null)))),
    el('div', { className: 'side-foot muted' }, 'Local · read-only logs', el('br'), 'Tickets stored on this PC'));
  document.body.classList.add('has-side'); document.body.prepend(side);
  document.querySelectorAll('header.bar nav.tabs').forEach((n) => n.remove());
  fetch('/api/crm/stats').then((r) => r.json()).then((s) => {
    const b = document.getElementById('badge-open');
    if (b && s.open) { b.hidden = false; b.textContent = s.open; if (s.overdue) { b.classList.add('warn'); b.title = `${s.overdue} overdue`; } }
  }).catch(() => {});
})();
