// Explain one booking failure: the problem (rules.js + FAILURE_MESSAGES), and what the supplier actually answered
// (the supplier calls just before the failure, with the error elements pulled out of their response and explained).
// Read-only: OpenSearch searches only.
'use strict';
const { search, M, C, BIG_FIELDS, range, explain, mapLimit } = require('./core');
const { doc } = require('./cases');
const classify = require('./classify');

const NOT_SUPPLIER = ['Database', 'Redis', 'NDCMessaging', 'OrderService'];
const BEFORE = 30 * 60e3, AFTER = 2 * 60e3;

// Error / warning elements in an XML or JSON response: [{ kind, code, type, text, path }]
const ERR_TAG = /<(?:[\w.-]+:)?(Error|Errors|ErrorInfo|ErrorText|ErrorMessage|ErrorDescription|Warning|Fault|faultstring|Message|ShortText|Text|Description|StatusMessage|ResponseMessage|FreeText|ErrorDetails|Reason)\b([^>]*)>([^<]{2,800})<\//gi;
const ATTR = (attrs, names) => { for (const n of names) { const m = new RegExp(`\\b(?:[\\w-]+:)?${n}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs); if (m) return m[1]; } return ''; };
const JSON_KEY = /^(errors?|errorMessage|errorDescription|errorText|message|description|detail|details|fault|faultstring|warning|warnings|title|reason|statusMessage|shortText|text)$/i;
const JSON_CODE = /^(code|errorCode|statusCode|status|type|errorType)$/i;

function extractErrors(text) {
  if (!text || typeof text !== 'string') return [];
  const out = []; const seen = new Set();
  const push = (e) => { const t = e.text.replace(/\s+/g, ' ').trim(); if (!t || t.length < 3 || /^(ok|success|true|false|null)$/i.test(t)) return;
    const k = (e.code || '') + '|' + t.toLowerCase(); if (seen.has(k)) return; seen.add(k); out.push({ ...e, text: t.slice(0, 600) }); };
  // XML (also XML embedded in JSON strings: unescape \" and \/ first)
  const xml = text.includes('<') ? text.replace(/\\"/g, '"').replace(/\\\//g, '/') : '';
  if (xml) {
    ERR_TAG.lastIndex = 0; let m;
    while ((m = ERR_TAG.exec(xml)) && out.length < 25) {
      const tag = m[1], attrs = m[2] || '';
      // Generic tags (Text, Message, Description…) count only inside an error/warning context or with an error-like attribute.
      const generic = /^(Message|Text|Description|ShortText|FreeText|Reason|ResponseMessage|StatusMessage)$/i.test(tag);
      const ctx = xml.slice(Math.max(0, m.index - 400), m.index);
      if (generic && !/(Error|Warning|Fault|Exception)[^<>]*>[^]*$/i.test(ctx) && !/(code|type)\s*=/i.test(attrs)) continue;
      push({ kind: /warn/i.test(tag) || /warn/i.test(ctx.slice(-200)) ? 'warning' : 'error', tag, code: ATTR(attrs, ['Code', 'ErrorCode', 'ShortText', 'Number']) || (/faultstring/i.test(tag) ? ((/<(?:[w.-]+:)?faultcode>([^<]+)</i.exec(xml) || [])[1] || '') : ''),
        type: ATTR(attrs, ['Type', 'ErrorType', 'Status']), text: m[3].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&apos;/g, "'") });
    }
  }
  // JSON
  let j = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (j && typeof j === 'object') {
    const walk = (v, path, inErr) => {
      if (out.length >= 25 || v == null) return;
      if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`, inErr));
      if (typeof v !== 'object') return;
      const code = Object.entries(v).find(([k, x]) => JSON_CODE.test(k) && (typeof x === 'string' || typeof x === 'number') && String(x) !== '200');
      for (const [k, x] of Object.entries(v)) {
        const errCtx = inErr || /error|fault|warning/i.test(k);
        if (typeof x === 'string' && JSON_KEY.test(k) && (errCtx || /error|fault/i.test(k))) push({ kind: /warn/i.test(path + k) ? 'warning' : 'error', tag: k, code: code ? String(code[1]) : '', type: '', text: x, path: path + '.' + k });
        else if (typeof x === 'object') walk(x, path + '.' + k, errCtx);
      }
    };
    walk(j, '$', false);
  }
  return out;
}

const RX = { type: '', frames: [], top: null, phase: 'book', blockingPhase: true };
function explainText(text, supplier) {
  const ex = explain({ ...RX, msg: text, text, method: '', supplier });
  const db = classify.status().loaded ? classify.match(supplier, [text]) : null;
  return { title: ex.known ? ex.title : null, what: ex.known ? ex.what : null, cause: ex.known ? ex.cause : null, agent: ex.known ? ex.agent : [], dev: ex.known ? ex.dev : [],
    db: db && { id: db.id, category: db.category, friendlyMessage: db.friendlyMessage, description: db.description } };
}

async function explainFailure({ cid, time, supplier = '', reason = '' }) {
  if (!cid) throw Object.assign(new Error('cid required'), { status: 400 });
  const t = Date.parse(time) || Date.now();
  const r = await search({ size: 60, sort: [{ '@timestamp': 'desc' }],
    query: { bool: { filter: [{ term: { [M('correlationId.keyword')]: cid } }, range(new Date(t - BEFORE).toISOString(), new Date(t + AFTER).toISOString()),
      { exists: { field: C('externalService.keyword') } }], must_not: [{ terms: { [C('externalService.keyword')]: NOT_SUPPLIER } }] } },
    _source: { excludes: BIG_FIELDS } });
  // One entry per external call: prefer the "End external system call" event (it holds the response).
  const calls = r.hits.hits.map((h) => { const s = h._source, m = (s.attributes || {}).message || {}, c = m.context || {};
    return { id: h._id, index: h._index, time: s['@timestamp'], service: c.externalService, action: c.actionName || '', status: c.statusCode, message: m.message, method: m.methodName, errorMessage: c.errorMessage || '' }; })
    .filter((c) => !/^Start external/i.test(c.message || ''));
  const sup = supplier.toLowerCase();
  const bad = (c) => (c.status && Number(c.status) !== 200) || !!c.errorMessage;
  // Most relevant first: same supplier + failed, then same supplier, then any failed, then the rest (each newest first).
  const score = (c) => (sup && (c.service || '').toLowerCase().includes(sup) ? 2 : 0) + (bad(c) ? 1 : 0) + (/search/i.test(c.action) ? -3 : 0);
  const ranked = calls.slice().sort((a, b) => score(b) - score(a) || (a.time < b.time ? 1 : -1));
  const top = ranked.slice(0, 3);
  await mapLimit(top, 3, async (c) => {
    const d = await doc(c.id, c.index);
    const resp = typeof d.response === 'string' ? d.response : d.response ? JSON.stringify(d.response) : '';
    const body = typeof d.body === 'string' ? d.body : d.body ? JSON.stringify(d.body) : '';
    c.request = d.request || null; c.response = d.response || null; c.returnValue = d.returnValue || null;
    c.errors = extractErrors(resp || body).map((e) => ({ ...e, explain: explainText(e.text, c.service || supplier) }));
    if (c.errorMessage && !c.errors.some((e) => e.text === c.errorMessage)) c.errors.unshift({ kind: 'error', tag: 'errorMessage (log)', code: '', type: '', text: c.errorMessage, explain: explainText(c.errorMessage, c.service || supplier) });
  });
  const key = top[0] || null;
  // Plain summary: what failed, at which supplier step, and what the supplier said.
  const problem = explainText(reason, supplier);
  const firstErr = key && key.errors && key.errors.find((e) => e.kind === 'error');
  const summary = !key ? `No supplier call was logged in this session in the 30 minutes before the failure: the booking stopped inside our system (${problem.title || 'see the message'}).`
    : `${key.service} ${key.action || 'call'} ${key.status ? `answered HTTP ${key.status}` : 'answered'} at ${new Date(key.time).toISOString().slice(11, 19)} UTC` +
      (firstErr ? `, with the error "${firstErr.text.slice(0, 160)}"${firstErr.code ? ` (code ${firstErr.code})` : ''}.` : bad(key) ? '.' : ', without an error in its response: the failure was decided by our system after the supplier answered.') +
      (firstErr && (firstErr.explain.title || firstErr.explain.db) ? ` Meaning: ${firstErr.explain.db && firstErr.explain.db.friendlyMessage ? firstErr.explain.db.friendlyMessage : firstErr.explain.what || firstErr.explain.title}` : '');
  return { cid, time, supplier, reason, problem, summary, calls: top, otherCalls: calls.filter((c) => !top.includes(c)).slice(0, 20).map(({ id, index, time: ct, service, action, status }) => ({ id, index, time: ct, service, action, status })) };
}

module.exports = { extractErrors, explainFailure };
