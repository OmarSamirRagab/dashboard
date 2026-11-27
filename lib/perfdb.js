// Sample values for the Performance page from the local MySQL, through MySQL Shell (no npm dependency).
// Read-only: one SELECT ... LIMIT 1 per column, in a read-only session, with a per-query time limit.
// Connection from env PERF_DB_HOST/PORT/NAME/USER/PASS (start.ps1 -Perf asks; kept in memory only).
'use strict';
const { fs, path } = require('./core');

const DB = { host: process.env.PERF_DB_HOST || '127.0.0.1', port: Number(process.env.PERF_DB_PORT || 3306), name: process.env.PERF_DB_NAME || '',
  user: process.env.PERF_DB_USER || '' };
const MYSQLSH = process.env.MYSQLSH || ['C:\\Program Files\\MySQL\\MySQL Shell 8.0\\bin\\mysqlsh.exe'].find((p) => fs.existsSync(p)) || 'mysqlsh';
const CACHE = path.join(__dirname, '..', 'perf-results', 'dbvalues.json');
const configured = () => !!(DB.name && DB.user && process.env.PERF_DB_PASS);
const label = () => `${DB.user}@${DB.host}:${DB.port}/${DB.name}`;

// Runs SQL through mysqlsh --json=raw; returns the rows of the last result set.
function sql(query, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const p = require('child_process').spawn(MYSQLSH, ['--sql', '--json=raw', `--host=${DB.host}`, `--port=${DB.port}`, `--user=${DB.user}`, `--schema=${DB.name}`,
      '--passwords-from-stdin', '-e', query], { windowsHide: true });
    let out = '', err = '';
    const timer = setTimeout(() => { p.kill(); reject(new Error(`MySQL query timed out after ${timeoutMs / 1000}s`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'MySQL Shell (mysqlsh) not found – install it or set MYSQLSH' : e.message)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      const objs = out.split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const text = (err + '\n' + out.split(/\r?\n/).filter((l) => l && !l.startsWith('{')).join('\n')).trim();
      const jsonErr = objs.find((o) => o.error); if (code !== 0 || jsonErr) return reject(new Error((jsonErr && (jsonErr.error.message || JSON.stringify(jsonErr.error))) || text || `mysqlsh exit ${code}`));
      const withRows = objs.filter((o) => Array.isArray(o.rows)); resolve(withRows.length ? withRows[withRows.length - 1].rows : []);
    });
    p.stdin.end((process.env.PERF_DB_PASS || '') + '\n');
  });
}
const qi = (s) => '`' + String(s).replace(/`/g, '``') + '`'; // identifiers come from information_schema, quoted anyway
const qs = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "''") + "'";

// ---------------- cache: schema + one value per column ----------------
let cache = null;
function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { cache = { schema: [], values: {} }; }
  index(); return cache;
}
function save() { fs.mkdirSync(path.dirname(CACHE), { recursive: true }); fs.writeFileSync(CACHE, JSON.stringify(cache)); }

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const singular = (s) => s.replace(/ies$/, 'y').replace(/(ss)$/, '$1').replace(/([^s])s$/, '$1');
const tableNorm = (t) => singular(norm(t).replace(/^(tbl|tb|mst)(?=[a-z]{3})/, ''));
let byCol = new Map(), byTable = new Map();
function index() {
  byCol = new Map(); byTable = new Map();
  for (const [t, c, key] of cache.schema) {
    const col = { t, c, key, tn: tableNorm(t) };
    const n = norm(c); if (!byCol.has(n)) byCol.set(n, []); byCol.get(n).push(col);
    if (!byTable.has(col.tn)) byTable.set(col.tn, []); byTable.get(col.tn).push(col);
  }
}

// Which column holds sample values for a parameter? `hints` are entity words from the path, controller and DTO.
// 1) same-named column in a hinted table; 2) xxxId / id -> primary key of the xxx / hinted table;
// 3) same-named column elsewhere, only when that is unambiguous (<= 3 tables), never for a bare "id".
function resolveColumn(name, hints) {
  load(); const n = norm(name); if (!n || !cache.schema.length) return null;
  const cols = byCol.get(n) || [];
  const ent = n.length > 2 && n.endsWith('id') ? n.slice(0, -2) : null;
  const ents = [...new Set([...(ent ? [ent] : []), ...hints.map(norm)].filter((e) => e.length > 2).map(singular))];
  for (const e of ents) { const c = cols.find((x) => x.tn === e); if (c) return c; }
  if (ent || n === 'id') for (const e of ents) { const pk = (byTable.get(e) || []).find((x) => x.key === 'PRI'); if (pk) return pk; }
  if (n !== 'id' && cols.length && cols.length <= 3) return [...cols].sort((a, b) => (b.key === 'PRI') - (a.key === 'PRI') || (b.key !== '') - (a.key !== '') || a.t.length - b.t.length)[0];
  return null;
}
const keyOf = (col) => `${col.t}.${col.c}`;
const valueOf = (col) => (col ? load().values[keyOf(col)] : undefined);

async function loadSchema() {
  if (!configured()) { const e = new Error('Database not configured – start.ps1 -Perf asks for PERF_DB_NAME, PERF_DB_USER and the password'); e.status = 400; throw e; }
  const rows = await sql('SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLUMN_KEY AS k FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME, ORDINAL_POSITION');
  load(); cache = { at: new Date().toISOString(), db: label(), schema: rows.map((r) => [r.t, r.c, r.k || '']), values: cache.db === label() ? cache.values : {} };
  index(); save(); return cache.schema.length;
}

// One recent/non-empty value per column, 40 columns per mysqlsh call; a failing batch is retried column by column.
async function fetchValues(cols) {
  load(); const todo = cols.filter((c) => !(keyOf(c) in cache.values)); let failed = 0;
  const one = (c, i) => `(SELECT /*+ MAX_EXECUTION_TIME(3000) */ ${i} AS i, CAST(${qi(c.c)} AS CHAR) AS v FROM ${qi(c.t)} ` +
    (c.key === 'PRI' ? `ORDER BY ${qi(c.c)} DESC LIMIT 1)` : `WHERE ${qi(c.c)} IS NOT NULL AND CAST(${qi(c.c)} AS CHAR) <> '' LIMIT 1)`);
  const run = async (batch) => {
    const rows = await sql(`SET SESSION TRANSACTION READ ONLY; ${batch.map(one).join(' UNION ALL ')};`);
    for (const c of batch) cache.values[keyOf(c)] = null; // looked up, even if the table is empty
    for (const r of rows) cache.values[keyOf(batch[r.i])] = r.v;
  };
  for (let k = 0; k < todo.length; k += 40) {
    const batch = todo.slice(k, k + 40);
    try { await run(batch); } catch { for (const c of batch) { try { await run([c]); } catch { failed++; } } }
  }
  cache.at = new Date().toISOString(); save();
  return { looked: todo.length, failed };
}

function state() {
  load(); const vals = Object.values(cache.values);
  return { configured: configured(), db: configured() ? label() : null, cachedFrom: cache.db || null, at: cache.at || null,
    columns: cache.schema.length, values: vals.filter((v) => v != null).length, mysqlsh: MYSQLSH };
}

module.exports = { sql, qs, loadSchema, fetchValues, resolveColumn, valueOf, keyOf, state, norm, singular, _setCache: (c) => { cache = c; index(); } };
