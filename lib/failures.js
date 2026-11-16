// Booking failures page.
'use strict';
const { fs, path, OSD_URL, TENANT, INDEX, INDEX_PATTERN_ID, PORT, M, C, BIG_FIELDS, BOOK_ACTIONS, PAY_SERVICES, PAY_METHODS, search, range, termsAgg, anyOf, explain, execFile, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath, codeFor, DAY, mapLimit, changesSince, LOGGER_FRAME, isApp, parseFrames, topFrameOf, locKey } = require('./core');

// ---------------- Booking failures: every failed booking in a time range ----------------
// Sources: handleBookingException ("Booking Has been failed!"), logBookingFailedBeforeSupplierCall, processMakePayment errorMessage.
// Joined per session (correlationId): agency + supplier from processMakePayment, ref from the event or the session.
const FAIL_METHODS = ['handleBookingException', 'logBookingFailedBeforeSupplierCall'];
// Some supplier messages arrive mangled ("Hosts+errors+durings+tickets+issue"); restore spaces.
const unmangleText = (t) => ((t || '').match(/s\+/g) || []).length >= 3 ? t.replace(/s\+/g, ' ').replace(/\+/g, ' ').replace(/s\|/g, '|').replace(/\)s/g, ')') : (t || '');
const cleanReason = (exc, msg) => {
  let r = unmangleText(exc || msg || '').replace(/^(BookingException|Throwable|FlightNotAvailableException|BadRequestExc)\s*:\s*/, '').trim();
  if (/booking failed before supplier call/i.test(r)) r = 'Failed before supplier call (row still NOT_BOOKED)';
  if (/^Generic error:/.test(r)) r = r.replace(/^Generic error:\s*/, '');
  return r || '(no message)';
};
async function bookingFailures({ from, to, agency, supplier }) {
  const r = await search({ size: 6000, sort: [{ '@timestamp': 'desc' }],
    _source: ['@timestamp', 'resource', M('methodName'), M('message'), M('correlationId'), C('exception'), C('errorMessage'), C('booking-ref'), C('agencyCode'), C('agencyName'), C('externalService'), C('friendlyMessage')],
    query: { bool: { filter: [range(from, to), anyOf(
      { terms: { [M('methodName.keyword')]: FAIL_METHODS } },
      { bool: { filter: [{ term: { [M('methodName.keyword')]: 'processMakePayment' } }, { exists: { field: C('errorMessage.keyword') } }] } })] } } });
  const ev = r.hits.hits.map((h) => { const s = h._source; const m = (s.attributes && s.attributes.message) || {}; const c = m.context || {};
    return { t: s['@timestamp'], host: s.resource && s.resource['service.name'], method: m.methodName, cid: m.correlationId, ref: c['booking-ref'] || null,
      reason: cleanReason(c.exception, c.errorMessage || m.message), exception: c.exception || '', agencyCode: c.agencyCode || '', agencyName: c.agencyName || '',
      supplier: c.externalService || '', friendly: c.friendlyMessage || '', source: m.methodName === 'processMakePayment' ? 'payment' : m.methodName === 'handleBookingException' ? 'exception' : 'before-supplier' }; });
  // Session facts: agency (processMakePayment), supplier (non-search booking/pricing calls), refs with their last time.
  const cids = [...new Set(ev.map((e) => e.cid).filter(Boolean))];
  const sess = new Map();
  for (let k = 0; k < cids.length; k += 500) {
    const part = cids.slice(k, k + 500);
    const a = await search({ size: 0, query: { bool: { filter: [{ terms: { [M('correlationId.keyword')]: part } }] } }, aggs: { c: { terms: { field: M('correlationId.keyword'), size: part.length }, aggs: {
      ag: { filter: { term: { [M('methodName.keyword')]: 'processMakePayment' } }, aggs: { a: termsAgg(C('agencyCode.keyword'), 1), n: termsAgg(C('agencyName.keyword'), 1) } },
      // fallback when the session has no processMakePayment (book-after-hold, admin): agency logged anywhere in the session
      agAny: termsAgg(C('agencyCode.keyword'), 1), agAnyName: termsAgg(C('agencyName.keyword'), 1),
      sup: { filter: { bool: { filter: [{ exists: { field: C('externalService.keyword') } }], must_not: [{ terms: { [C('actionName.keyword')]: ['Search', 'search'] } }, { terms: { [C('externalService.keyword')]: [...PAY_SERVICES, 'Database', 'Redis', 'NDCMessaging', 'OrderService'] } }] } },
        aggs: { s: termsAgg(C('externalService.keyword'), 2) } },
      bm: { filter: { term: { [C('externalService.keyword')]: 'BanqueMisr' } } },
      refs: { terms: { field: C('booking-ref.keyword'), size: 10 }, aggs: { t: { max: { field: '@timestamp' } } } } } } } });
    for (const b of a.aggregations.c.buckets) sess.set(b.key, { agencyCode: (b.ag.a.buckets[0] || b.agAny.buckets[0] || {}).key || '', agencyName: (b.ag.n.buckets[0] || b.agAnyName.buckets[0] || {}).key || '',
      suppliers: b.sup.s.buckets.map((x) => x.key), banqueMisr: b.bm.doc_count > 0, refs: b.refs.buckets.map((x) => ({ ref: x.key, t: x.t.value_as_string })) });
  }
  // The failing supplier = the supplier of the last non-search supplier call before the failure in that session.
  const calls = new Map(); // cid -> [{ t, svc }]
  const INFRA = [...PAY_SERVICES, 'Database', 'Redis', 'NDCMessaging', 'OrderService'];
  for (let k = 0; k < cids.length; k += 300) {
    const part = cids.slice(k, k + 300);
    const c = await search({ size: 10000, sort: [{ '@timestamp': 'asc' }], _source: ['@timestamp', M('correlationId'), C('externalService')],
      query: { bool: { filter: [{ terms: { [M('correlationId.keyword')]: part } }, { term: { [M('message.keyword')]: 'Start external system call' } }, { exists: { field: C('externalService.keyword') } }],
        must_not: [{ terms: { [C('actionName.keyword')]: ['Search', 'search'] } }, { terms: { [C('externalService.keyword')]: INFRA } }] } } });
    for (const h of c.hits.hits) { const s = h._source; const m = s.attributes.message; const cid = m.correlationId;
      if (!calls.has(cid)) calls.set(cid, []); calls.get(cid).push({ t: s['@timestamp'], svc: m.context.externalService }); }
  }
  const failingSupplier = (cid, t) => {
    const list = calls.get(cid) || []; const lim = new Date(Date.parse(t) + 5000).toISOString();
    let best = null; for (const x of list) if (x.t <= lim) best = x; // sorted asc → last one before the failure
    return best ? best.svc : '';
  };
  // One row per (session, ref, reason) within 10 minutes; payment-error events give agency/supplier/ref.
  const rows = []; const byKey = new Map();
  for (const e of ev.slice().reverse()) {
    const s = sess.get(e.cid) || { refs: [], suppliers: [] };
    const ref = e.ref || (s.refs.filter((x) => x.t <= new Date(Date.parse(e.t) + 60e3).toISOString()).sort((a, b) => (a.t < b.t ? 1 : -1))[0] || s.refs[0] || {}).ref || '';
    const key = `${e.cid}|${ref}|${e.reason}`;
    const prev = byKey.get(key);
    if (prev && Date.parse(e.t) - Date.parse(prev.last) < 10 * 60e3) { prev.count++; prev.last = e.t; prev.sources.add(e.source); continue; }
    const [type, ...rest] = (e.exception || '').split(' : ');
    const ex = explain({ type: (type || '').trim(), msg: rest.join(' : '), text: [e.exception, e.reason, e.friendly].join(' | '), method: e.method, frames: [], top: null, phase: 'book', blockingPhase: true, supplier: e.supplier, host: e.host });
    const row = { time: e.t, last: e.t, ref, cid: e.cid, host: e.host, reason: e.reason, friendly: e.friendly,
      category: ex.known ? ex.title : 'Other / unclassified', action: (ex.agent || [])[0] || '', impact: ex.impact,
      agencyCode: e.agencyCode || s.agencyCode || '', agencyName: e.agencyName || s.agencyName || '',
      supplier: (e.supplier && !INFRA.includes(e.supplier) ? e.supplier : '') || failingSupplier(e.cid, e.t) || s.suppliers[0] || '',
      sessionSuppliers: s.suppliers, banqueMisr: !!s.banqueMisr,
      count: 1, sources: new Set([e.source]) };
    byKey.set(key, row); rows.push(row);
  }
  // "Failed before supplier call" is the consequence of another failure in the same session: fold it into that row.
  const merged = rows.filter((x) => {
    if (!(x.sources.size === 1 && x.sources.has('before-supplier'))) return true;
    const sib = rows.find((y) => y !== x && y.cid === x.cid && !(y.sources.size === 1 && y.sources.has('before-supplier'))
      && Math.abs(Date.parse(y.time) - Date.parse(x.time)) < 5 * 60e3);
    if (!sib) return true;
    sib.sources.add('before-supplier'); if (!sib.ref) sib.ref = x.ref; return false;
  });
  const ag = (agency || '').toLowerCase(), sp = (supplier || '').toLowerCase();
  const out = merged.filter((x) => (!ag || [x.agencyCode, x.agencyName].some((v) => v && v.toLowerCase() === ag))
    && (!sp || x.supplier.toLowerCase().includes(sp.trim())))
    .map((x) => ({ ...x, sources: [...x.sources] })).sort((a, b) => (a.time < b.time ? 1 : -1));
  return { rows: out, events: ev.length, truncated: ev.length >= 6000, from, to };
}

module.exports = { FAIL_METHODS, unmangleText, cleanReason, bookingFailures };
