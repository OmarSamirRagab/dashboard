// Booking-failure classification from the application's own table wonderdb.FAILURE_MESSAGES (UAT database).
// Same matching as FlightWSService.replaceSupplierErrorToFriendlyError: per supplier, error text equalsIgnoreCase
// ERROR_MESSAGE. Logs may hold the already-replaced FRIENDLY_MESSAGE, so that is matched too.
// Read-only: only SELECT statements. Connection from env: UAT_DB_HOST, UAT_DB_PORT, UAT_DB_USER, UAT_DB_PASS, UAT_DB_NAME.
'use strict';

const cfg = () => ({ host: process.env.UAT_DB_HOST, port: Number(process.env.UAT_DB_PORT || 3306), user: process.env.UAT_DB_USER,
  password: process.env.UAT_DB_PASS, database: process.env.UAT_DB_NAME || 'wonderdb' });
const configured = () => !!(process.env.UAT_DB_HOST && process.env.UAT_DB_USER && process.env.UAT_DB_PASS);
const REFRESH_MS = 15 * 60e3;

const SQL = `
SELECT fm.ID AS id, fm.ERROR_MESSAGE AS errorMessage, fm.FRIENDLY_MESSAGE AS friendlyMessage, fm.ERROR_CODE AS errorCode,
       fm.DESCRIPTION AS description, fm.STATUS AS status, fm.SUPPLIER_ID AS supplierId, s.SUPPLIER_NAME AS supplierName,
       fm.FAILURE_MSG_CATEGORY AS categoryCode, e.VALUE AS category
  FROM FAILURE_MESSAGES fm
  LEFT JOIN TT_TS_SUPPLIER s ON s.SUPPLIER_ID = fm.SUPPLIER_ID
  LEFT JOIN TT_ENUM_VALUES e ON e.TYPE_NAME = 'FAILURE_MSG_CATEGORY' AND e.INT_CODE = fm.FAILURE_MSG_CATEGORY`;

const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase();
let state = { entries: [], bySupplier: new Map(), byText: new Map(), loadedAt: null, error: null, loading: null };

function index(entries) {
  const bySupplier = new Map(), byText = new Map();
  for (const e of entries) {
    const sup = norm(e.supplierName);
    for (const [txt, on] of [[e.errorMessage, 'error message'], [e.friendlyMessage, 'friendly message']]) {
      const k = norm(txt); if (!k) continue;
      if (!bySupplier.has(sup)) bySupplier.set(sup, new Map());
      if (!bySupplier.get(sup).has(k)) bySupplier.get(sup).set(k, { e, on });
      if (!byText.has(k)) byText.set(k, []);
      byText.get(k).push({ e, on });
    }
  }
  return { bySupplier, byText };
}
function setEntries(entries) { state = { ...state, entries, ...index(entries), loadedAt: new Date().toISOString(), error: null }; }

async function load() {
  if (!configured()) return status();
  if (state.loading) return state.loading;
  state.loading = (async () => {
    let conn;
    try {
      const mysql = require('mysql2/promise');
      conn = await mysql.createConnection({ ...cfg(), connectTimeout: 10000, dateStrings: true });
      const [rows] = await conn.query(SQL);
      setEntries(rows);
    } catch (e) { state.error = e.code ? `${e.code}: ${e.message}` : e.message; }
    finally { if (conn) await conn.end().catch(() => {}); state.loading = null; }
    return status();
  })();
  return state.loading;
}
async function ensure() { if (configured() && (!state.loadedAt || Date.now() - Date.parse(state.loadedAt) > REFRESH_MS)) await load(); }

// texts: the failure's message variants (reason, raw error, friendly). supplier: the failing supplier name.
function match(supplier, texts) {
  const ks = [...new Set((texts || []).map(norm).filter(Boolean))];
  const sup = state.bySupplier.get(norm(supplier));
  for (const k of ks) { const hit = sup && sup.get(k); if (hit) return view(hit, true); }
  for (const k of ks) { const hits = state.byText.get(k); if (hits && hits.length) return view(hits[0], false); }
  return null;
}
const view = ({ e, on }, sameSupplier) => ({ id: e.id, category: e.category || (e.categoryCode != null ? `code ${e.categoryCode}` : ''), friendlyMessage: e.friendlyMessage || '',
  description: e.description || '', supplier: e.supplierName || '', errorCode: e.errorCode || '', matchedOn: on, sameSupplier });

function status() {
  return { configured: configured(), loaded: !!state.loadedAt, loadedAt: state.loadedAt, count: state.entries.length, error: state.error,
    database: configured() ? `${cfg().user}@${cfg().host}:${cfg().port}/${cfg().database}` : null,
    categories: [...new Set(state.entries.map((e) => e.category).filter(Boolean))].sort() };
}

module.exports = { configured, load, ensure, match, status, _setEntries: setEntries, norm };
