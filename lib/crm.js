// CRM: tickets for failed / not-booked bookings. Single user, local JSON file store (no dependencies).
// Writes are atomic (temp file + rename) and a dated backup is kept per day (last 14 days).
'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.CRM_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'crm.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const STATUSES = ['new', 'investigating', 'waiting-supplier', 'waiting-agency', 'resolved', 'closed'];
const OPEN = new Set(['new', 'investigating', 'waiting-supplier', 'waiting-agency']);
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const PRIO_RANK = { urgent: 0, high: 1, normal: 2, low: 3 };
const EDITABLE = ['status', 'priority', 'owner', 'tags', 'dueAt', 'resolution', 'title', 'pnr', 'ref', 'agencyCode', 'agencyName', 'supplier'];

let db = null; let saveTimer = null;

function load() {
  if (db) return db;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  db = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : { version: 1, seq: 0, tickets: [] };
  db.tickets = db.tickets || [];
  return db;
}
function saveNow() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);
  const day = new Date().toISOString().slice(0, 10); const bk = path.join(BACKUP_DIR, `crm-${day}.json`);
  if (!fs.existsSync(bk)) {
    fs.copyFileSync(FILE, bk);
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^crm-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().slice(0, -14);
    old.forEach((f) => fs.rmSync(path.join(BACKUP_DIR, f), { force: true }));
  }
}
function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 300); }
function flush() { clearTimeout(saveTimer); if (db) saveNow(); }

const now = () => new Date().toISOString();
const err = (msg, status = 400) => Object.assign(new Error(msg), { status });
// Same failure = same session + ref + reason (import never creates duplicates).
const failureKey = (x) => [x.cid || '', x.ref || '', (x.reason || '').slice(0, 200)].join('|');

function suggestPriority(f) {
  if (f.banqueMisr) return 'high';
  if (/Galileo ticket issue failed|NDC booking still on hold|Request rejected by supplier|Supplier-side error|Ticket issuance failed/i.test(f.category || '')) return 'high';
  if (/Duplicate passenger|Booking already in progress|Login failed/i.test(f.category || '')) return 'low';
  return 'normal';
}

function create(input, { source = 'manual' } = {}) {
  load();
  const ref = (input.ref || '').trim(), pnr = (input.pnr || '').trim().toUpperCase(), cid = (input.cid || '').trim();
  if (!ref && !pnr && !cid) throw err('Enter a booking ref, PNR or correlation id.');
  const key = input.failureKey || (source === 'import' ? failureKey(input) : null);
  if (key) { const dup = db.tickets.find((t) => t.failureKey === key); if (dup) return { ticket: dup, created: false }; }
  const id = 'T-' + String(++db.seq).padStart(5, '0');
  const t = {
    id, title: input.title || [input.category || 'Booking issue', ref || pnr].filter(Boolean).join(' – '),
    ref, pnr, cid, failureKey: key || null, source,
    agencyCode: input.agencyCode || '', agencyName: input.agencyName || '', supplier: input.supplier || '',
    category: input.category || '', reason: input.reason || '', action: input.action || '', banqueMisr: !!input.banqueMisr,
    failureTime: input.failureTime || input.time || null,
    status: 'new', priority: PRIORITIES.includes(input.priority) ? input.priority : suggestPriority(input),
    owner: input.owner || 'me', tags: Array.isArray(input.tags) ? input.tags : [], dueAt: input.dueAt || null, resolution: '',
    createdAt: now(), updatedAt: now(), notes: [],
    history: [{ at: now(), action: source === 'import' ? 'created from booking failures' : 'created' }],
  };
  if (input.note) t.notes.push({ id: 'n1', at: now(), text: String(input.note).slice(0, 5000) });
  db.tickets.push(t); save();
  return { ticket: t, created: true };
}

function get(id) { load(); const t = db.tickets.find((x) => x.id === id); if (!t) throw err('Ticket not found', 404); return t; }

function update(id, patch) {
  const t = get(id); const changes = [];
  for (const k of EDITABLE) {
    if (!(k in patch)) continue;
    let v = patch[k];
    if (k === 'status' && !STATUSES.includes(v)) throw err('Unknown status');
    if (k === 'priority' && !PRIORITIES.includes(v)) throw err('Unknown priority');
    if (k === 'tags') v = [...new Set((Array.isArray(v) ? v : String(v).split(',')).map((s) => String(s).trim()).filter(Boolean))].slice(0, 20);
    if (k === 'dueAt') v = v ? new Date(v).toISOString() : null;
    if (typeof v === 'string') v = v.slice(0, 5000);
    if (JSON.stringify(t[k]) === JSON.stringify(v)) continue;
    changes.push({ at: now(), action: 'changed', field: k, from: t[k], to: v });
    t[k] = v;
  }
  if (changes.length) {
    if ('status' in patch && !OPEN.has(t.status) && !t.closedAt) t.closedAt = now();
    if ('status' in patch && OPEN.has(t.status)) t.closedAt = null;
    t.history.push(...changes); t.updatedAt = now(); save();
  }
  return t;
}

function addNote(id, text) {
  const t = get(id); text = String(text || '').trim();
  if (!text) throw err('Empty note');
  const n = { id: 'n' + (t.notes.length + 1), at: now(), text: text.slice(0, 5000) };
  t.notes.push(n); t.history.push({ at: now(), action: 'note added' }); t.updatedAt = now(); save();
  return n;
}

function bulk(ids, set) {
  const out = [];
  for (const id of ids || []) { try { out.push(update(id, set).id); } catch { /* skip missing */ } }
  return { updated: out.length };
}

function remove(id) { load(); const i = db.tickets.findIndex((x) => x.id === id); if (i < 0) throw err('Ticket not found', 404); db.tickets.splice(i, 1); save(); return { deleted: id }; }

const isOverdue = (t, at = Date.now()) => OPEN.has(t.status) && t.dueAt && Date.parse(t.dueAt) < at;

// List with filters, sorting and server-side pagination.
function list(q = {}) {
  load();
  const page = Math.max(1, parseInt(q.page, 10) || 1), size = Math.min(200, Math.max(5, parseInt(q.size, 10) || 25));
  const text = (q.q || '').trim().toLowerCase();
  const statuses = q.status ? String(q.status).split(',') : null;
  let rows = db.tickets.filter((t) => {
    if (q.view === 'open' && !OPEN.has(t.status)) return false;
    if (q.view === 'overdue' && !isOverdue(t)) return false;
    if (q.view === 'urgent' && !(OPEN.has(t.status) && (t.priority === 'urgent' || t.priority === 'high'))) return false;
    if (q.view === 'today' && !(t.createdAt.slice(0, 10) === now().slice(0, 10))) return false;
    if (statuses && !statuses.includes(t.status)) return false;
    if (q.priority && t.priority !== q.priority) return false;
    if (q.category && t.category !== q.category) return false;
    if (q.agency && t.agencyCode !== q.agency) return false;
    if (q.supplier && t.supplier !== q.supplier) return false;
    if (q.tag && !t.tags.includes(q.tag)) return false;
    if (text && ![t.id, t.ref, t.pnr, t.cid, t.agencyCode, t.agencyName, t.supplier, t.title, t.reason, t.category, ...t.tags].join(' ').toLowerCase().includes(text)) return false;
    return true;
  });
  const sort = q.sort || 'updatedAt', dir = q.dir === 'asc' ? 1 : -1;
  const keyOf = { priority: (t) => PRIO_RANK[t.priority], status: (t) => STATUSES.indexOf(t.status), dueAt: (t) => t.dueAt || '9999' };
  const kf = keyOf[sort] || ((t) => t[sort] || '');
  rows.sort((a, b) => { const x = kf(a), y = kf(b); return (x < y ? -1 : x > y ? 1 : 0) * (sort === 'priority' || sort === 'status' ? -dir : dir); });
  const total = rows.length;
  const items = rows.slice((page - 1) * size, page * size).map(({ history, notes, ...t }) => ({ ...t, notesCount: notes.length, overdue: isOverdue(t) }));
  return { items, total, page, size, pages: Math.max(1, Math.ceil(total / size)) };
}

function stats() {
  load();
  const T = db.tickets; const today = now().slice(0, 10), weekAgo = Date.now() - 7 * 86400e3;
  const by = (f) => T.reduce((m, t) => { const k = f(t); if (k) m[k] = (m[k] || 0) + 1; return m; }, {});
  return {
    total: T.length, open: T.filter((t) => OPEN.has(t.status)).length,
    newToday: T.filter((t) => t.createdAt.slice(0, 10) === today).length,
    overdue: T.filter((t) => isOverdue(t)).length,
    resolvedWeek: T.filter((t) => t.closedAt && Date.parse(t.closedAt) >= weekAgo).length,
    urgentOpen: T.filter((t) => OPEN.has(t.status) && (t.priority === 'urgent' || t.priority === 'high')).length,
    byStatus: by((t) => t.status), byPriorityOpen: by((t) => (OPEN.has(t.status) ? t.priority : null)),
    byCategoryOpen: by((t) => (OPEN.has(t.status) ? t.category || '(none)' : null)),
    byAgencyOpen: by((t) => (OPEN.has(t.status) ? t.agencyCode || '(unknown)' : null)),
    bySupplierOpen: by((t) => (OPEN.has(t.status) ? t.supplier || '(unknown)' : null)),
    dueSoon: T.filter((t) => OPEN.has(t.status) && t.dueAt).sort((a, b) => (a.dueAt < b.dueAt ? -1 : 1)).slice(0, 8)
      .map((t) => ({ id: t.id, title: t.title, dueAt: t.dueAt, overdue: isOverdue(t), priority: t.priority, status: t.status })),
    recent: T.slice().sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)).slice(0, 8).map((t) => ({ id: t.id, title: t.title, status: t.status, priority: t.priority, updatedAt: t.updatedAt })),
    tags: [...new Set(T.flatMap((t) => t.tags))].sort(),
  };
}

// Which failure rows already have a ticket (for the Booking failures page).
function lookup(keys) { load(); const m = {}; for (const t of db.tickets) if (t.failureKey && keys.includes(t.failureKey)) m[t.failureKey] = { id: t.id, status: t.status }; return m; }

// Import failure rows (from bookingFailures) as tickets; existing ones are skipped.
function importFailures(rows) {
  let created = 0, skipped = 0; const ids = [];
  for (const r of rows) {
    const res = create({ ...r, failureKey: failureKey(r), failureTime: r.time }, { source: 'import' });
    if (res.created) { created++; ids.push(res.ticket.id); } else skipped++;
  }
  return { created, skipped, ids };
}

module.exports = { STATUSES, PRIORITIES, OPEN: [...OPEN], create, get, update, addNote, bulk, remove, list, stats, lookup, importFailures, failureKey, flush, _reset: () => { db = null; } };
