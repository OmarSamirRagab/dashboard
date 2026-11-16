// Cases page: find sessions for refs/agencies, summarize them, pay & book focus, per-booking verdict.
'use strict';
const { fs, path, OSD_URL, TENANT, INDEX, INDEX_PATTERN_ID, PORT, M, C, BIG_FIELDS, BOOK_ACTIONS, PAY_SERVICES, PAY_METHODS, search, range, termsAgg, anyOf, explain, execFile, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath, codeFor, DAY, mapLimit, changesSince, LOGGER_FRAME, isApp, parseFrames, topFrameOf, locKey } = require('./core');

// Step 1: find the sessions (correlationIds) for the ref / agency in the time range.
// With a ref, agency is NOT applied here: the log holding the ref (bookAndPay response) has no agency field,
// so the caller filters the summarized sessions by agency instead.
async function findCorrelationIds({ ref, agency, from, to }) {
  const filter = [range(from, to)];
  if (ref) {
    filter.push({ bool: { minimum_should_match: 1, should: [
      { term: { [C('booking-ref.keyword')]: ref } },
      { multi_match: { query: ref, type: 'phrase', fields: ['*'], lenient: true } },
    ] } });
  }
  if (agency && !ref) {
    filter.push({ bool: { minimum_should_match: 1, should: [
      { term: { [C('agencyCode.keyword')]: agency } },
      { term: { [C('agencyName.keyword')]: agency } },
    ] } });
    // Agency-only: restrict to booking attempts, not every search session.
    filter.push({ term: { [M('methodName.keyword')]: 'processMakePayment' } });
  }
  const r = await search({
    size: 0,
    query: { bool: { filter } },
    aggs: { cid: { terms: { field: M('correlationId.keyword'), size: 50, order: { last: 'desc' } }, aggs: { last: { max: { field: '@timestamp' } } } } },
  });
  return r.aggregations.cid.buckets.map((b) => b.key);
}

// Booking journey phases (best effort, from the method/action names seen in the logs).

const PHASES = {
  search: anyOf({ term: { [M('methodName.keyword')]: 'getSearchResult' } }, { terms: { [C('actionName.keyword')]: ['Search', 'search'] } }),
  fare: anyOf({ prefix: { [M('methodName.keyword')]: 'fareConfirm' } }, { terms: { [C('actionName.keyword')]: ['FareConfirm', 'UpSelling'] } }),
  pax: { term: { [M('methodName.keyword')]: 'paxDetails' } },
  reprice: anyOf({ prefix: { [M('methodName.keyword')]: 'fareReCheck' } }, { term: { [C('actionName.keyword')]: 'PnrReprice' } }),
  payment: anyOf({ terms: { [M('methodName.keyword')]: PAY_METHODS } }, { terms: { [C('externalService.keyword')]: PAY_SERVICES } }),
  book: anyOf({ terms: { [C('actionName.keyword')]: BOOK_ACTIONS } }, { term: { [M('methodName.keyword')]: 'handleBookingException' } }),
};
const BAD = anyOf({ term: { 'severity.text.keyword': 'ERROR' } },
  { bool: { filter: { exists: { field: C('statusCode') } }, must_not: { term: { [C('statusCode')]: 200 } } } },
  { exists: { field: C('errorMessage.keyword') } });
const phaseAggs = Object.fromEntries(Object.entries(PHASES).map(([k, q]) => [`ph_${k}`, { filter: q, aggs: { bad: { filter: BAD } } }]));

// Step 2: one summary per session, with a verdict on where/why it stopped.
async function summarize(cids, from, to) {
  if (!cids.length) return [];
  const r = await search({
    size: 0,
    query: { bool: { filter: [{ terms: { [M('correlationId.keyword')]: cids } }] } },
    aggs: { cid: { terms: { field: M('correlationId.keyword'), size: cids.length }, aggs: {
      first: { min: { field: '@timestamp' } },
      last: { max: { field: '@timestamp' } },
      agencyCode: termsAgg(C('agencyCode.keyword'), 5),
      payAgency: { filter: { term: { [M('methodName.keyword')]: 'processMakePayment' } }, aggs: { a: termsAgg(C('agencyCode.keyword'), 1), n: termsAgg(C('agencyName.keyword'), 1) } },
      agencyName: termsAgg(C('agencyName.keyword'), 1),
      refs: termsAgg(C('booking-ref.keyword'), 5),
      statuses: termsAgg(C('bookingStatus.keyword'), 5),
      exceptions: { filter: { term: { [M('methodName.keyword')]: 'handleBookingException' } }, aggs: { e: termsAgg(C('exception.keyword'), 3) } },
      payErrors: { filter: { bool: { filter: [{ term: { [M('methodName.keyword')]: 'processMakePayment' } }, { exists: { field: C('errorMessage.keyword') } }] } }, aggs: { e: termsAgg(C('errorMessage.keyword'), 3) } },
      errors: { filter: { exists: { field: C('errorMessage.keyword') } }, aggs: { e: termsAgg(C('errorMessage.keyword'), 3) } },
      supplierBook: { filter: { bool: { filter: [
        { term: { [M('message.keyword')]: 'End external system call' } },
        { terms: { [C('actionName.keyword')]: BOOK_ACTIONS } },
      ] } }, aggs: {
        ok: { filter: { term: { [C('statusCode')]: 200 } } },
        bad: { filter: { bool: { must: { exists: { field: C('statusCode') } }, must_not: { term: { [C('statusCode')]: 200 } } } },
          aggs: { svc: termsAgg(C('externalService.keyword'), 3), act: termsAgg(C('actionName.keyword'), 3), code: termsAgg(C('statusCode'), 3) } },
      } },
      payment: { filter: { bool: { minimum_should_match: 1, should: [
        { terms: { [C('externalService.keyword')]: PAY_SERVICES } },
        { terms: { [M('methodName.keyword')]: ['getsessionid', 'getTransactionStatus'] } },
      ] } }, aggs: { svc: termsAgg(C('externalService.keyword'), 3), m: termsAgg(M('methodName.keyword'), 5) } },
      bookAndPay: { filter: { terms: { [M('methodName.keyword')]: PAY_METHODS.slice(0, 2) } } },
      lastStep: { top_hits: { size: 1, sort: [{ '@timestamp': 'desc' }], _source: [M('methodName'), M('message'), C('externalService'), C('actionName'), C('statusCode')] } },
      ...phaseAggs,
      supplier: { filter: { bool: { must_not: { terms: { [C('actionName.keyword')]: ['Search', 'search'] } }, filter: { exists: { field: C('externalService.keyword') } } } },
        aggs: { s: { terms: { field: C('externalService.keyword'), size: 3 } } } },
    } } },
  });
  const keys = (a) => (a && a.buckets ? a.buckets.map((b) => b.key) : []);
  return r.aggregations.cid.buckets.map((b) => {
    const last = (b.lastStep.hits.hits[0] || {})._source || {};
    const lm = (last.attributes && last.attributes.message) || {};
    const lctx = lm.context || {};
    const bad = b.supplierBook.bad;
    const suppliers = keys(b.supplier.s).filter((s) => !PAY_SERVICES.includes(s) && !['Database', 'Redis', 'NDCMessaging', 'OrderService'].includes(s));
    let verdict, kind;
    if (b.exceptions.doc_count) { kind = 'exception'; verdict = 'Booking exception: ' + (keys(b.exceptions.e)[0] || '(no message)'); }
    else if (bad.doc_count) { kind = 'supplier'; verdict = `Supplier rejected: ${keys(bad.svc).join(', ')} ${keys(bad.act).join('/')} HTTP ${keys(bad.code).join(',')}`; }
    else if (b.payErrors.doc_count) { kind = 'payment-error'; verdict = 'Payment step error: ' + keys(b.payErrors.e)[0]; }
    else if (b.bookAndPay.doc_count && !b.supplierBook.doc_count) {
      kind = 'payment-incomplete';
      verdict = b.payment.doc_count
        ? `Stopped at payment (${keys(b.payment.svc).join(', ') || 'gateway'}: ${keys(b.payment.m).join(', ')}) – no supplier booking call followed`
        : 'bookAndPay called but no supplier booking call followed';
    }
    else if (b.supplierBook.ok.doc_count) { kind = 'supplier-ok'; verdict = 'Supplier Hold/Book returned 200 – check post-booking steps (ticketing / DB update)'; }
    else if (!b.bookAndPay.doc_count) { kind = 'no-booking'; verdict = 'No booking attempt in this session (search/pricing only)'; }
    else { kind = 'unknown'; verdict = 'Unclear – read the timeline'; }
    // Business rule: a session that called Banque Misr (card payment) is NOT booked, whatever else happened.
    // The underlying reason is kept in the verdict text.
    let reason = null;
    if (keys(b.payment.svc).includes('BanqueMisr')) {
      reason = { kind, verdict };
      kind = 'not-booked-bm';
      const why = reason.kind === 'supplier-ok' ? 'supplier Hold/Book returned 200 but the booking is not confirmed'
        : reason.kind === 'payment-incomplete' ? 'no supplier booking call followed'
          : reason.kind === 'no-booking' || reason.kind === 'unknown' ? null : reason.verdict;
      verdict = `Not booked – Banque Misr card payment used (${keys(b.payment.m).join(', ') || 'gateway call'})${why ? '; ' + why : ''}`;
    }
    return {
      correlationId: b.key, events: b.doc_count,
      first: b.first.value_as_string, last: b.last.value_as_string,
      // The booking agency is the one on processMakePayment; a session id can also carry other agencies' searches.
      agencyCode: keys(b.payAgency.a)[0] || keys(b.agencyCode)[0] || '',
      agencyName: keys(b.payAgency.n)[0] || keys(b.agencyName)[0] || '',
      agencies: keys(b.agencyCode),
      refs: keys(b.refs), statuses: keys(b.statuses), suppliers,
      errors: keys(b.errors.e),
      lastStep: [lm.methodName, lm.message, lctx.externalService, lctx.actionName, lctx.statusCode].filter((x) => x !== undefined && x !== '').join(' · '),
      kind, verdict, reasonKind: reason ? reason.kind : null,
      // per phase: 0 = not reached, 1 = reached, 2 = reached with an error / non-200 (search errors are normal noise)
      phases: Object.fromEntries(Object.keys(PHASES).map((k) => {
        const p = b[`ph_${k}`];
        return [k, !p.doc_count ? 0 : k !== 'search' && p.bad.doc_count ? 2 : 1];
      })),
    };
  }).sort((a, b) => (a.last < b.last ? 1 : -1));
}

async function timeline(cid) {
  const r = await search({
    size: 2000, track_total_hits: true,
    sort: [{ '@timestamp': 'asc' }],
    query: { term: { [M('correlationId.keyword')]: cid } },
    _source: { excludes: BIG_FIELDS.concat([M('stacktrace')]) },
  });
  return {
    total: r.hits.total && (r.hits.total.value !== undefined ? r.hits.total.value : r.hits.total),
    events: r.hits.hits.map((h) => {
      const s = h._source; const a = s.attributes || {}; const m = a.message || {}; const c = m.context || {};
      return { id: h._id, index: h._index, time: s['@timestamp'], level: (s.severity && s.severity.text) || a.log_level,
        host: s.resource && s.resource['service.name'], method: m.methodName, message: m.message, context: c };
    }),
  };
}

async function doc(id, index) {
  const r = await search({ size: 1, query: { ids: { values: [id] } }, _source: { includes: BIG_FIELDS.concat([M('stacktrace')]) } });
  const h = r.hits.hits[0]; if (!h) return {};
  const a = h._source.attributes || {}; const m = a.message || {}; const c = m.context || {};
  return { request: c.request, response: c.response, returnValue: c.returnValue, stacktrace: m.stacktrace, body: h._source.body };
}

const MAX_REFS = 300;

const parseRefs = (s) => [...new Set(String(s || '').split(/[\s,;|]+/).map((x) => x.trim()).filter(Boolean))];

// Booking refs embed their creation date (NDCEG-BR-F261109xxxx = 2026-11-09). Search 1 day before to 3 days after.
function refWindow(ref) {
  const m = /-F(\d{2})(\d{2})(\d{2})/.exec(ref);
  if (!m) return null;
  const d = Date.parse(`20${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d)) return null;
  return { from: new Date(d - DAY).toISOString(), to: new Date(Math.min(d + 3 * DAY, Date.now())).toISOString() };
}

// Sessions containing the ref, with when the ref itself was logged (anchor for the pay & book focus).
async function findRefSessions(ref, from, to) {
  const r = await search({ size: 0, query: { bool: { filter: [range(from, to), { bool: { minimum_should_match: 1, should: [
    { term: { [C('booking-ref.keyword')]: ref } }, { multi_match: { query: ref, type: 'phrase', fields: ['*'], lenient: true } }] } }] } },
    aggs: { cid: { terms: { field: M('correlationId.keyword'), size: 20 }, aggs: { first: { min: { field: '@timestamp' } }, last: { max: { field: '@timestamp' } } } } } });
  return r.aggregations.cid.buckets.map((b) => ({ cid: b.key, refFirst: b.first.value_as_string, refLast: b.last.value_as_string }));
}

// Pay & book focus for one session around the ref: bookAndPay, processMakePayment, payment gateway, supplier booking.
const GATEWAY_METHODS = ['getsessionid', 'getTransactionStatus', 'createCard'];
async function payBookFocus(cid, anchorFrom, anchorTo) {
  const from = new Date(Date.parse(anchorFrom) - 20 * 60e3).toISOString();
  const to = new Date(Date.parse(anchorTo) + 90 * 60e3).toISOString();
  const r = await search({ size: 0, query: { bool: { filter: [{ term: { [M('correlationId.keyword')]: cid } }, range(from, to)] } }, aggs: {
    bap: { filter: { term: { [M('methodName.keyword')]: 'bookAndPay' } }, aggs: { t: { min: { field: '@timestamp' } } } },
    pmp: { filter: { term: { [M('methodName.keyword')]: 'processMakePayment' } }, aggs: { t: { min: { field: '@timestamp' } },
      st: termsAgg(C('bookingStatus.keyword'), 3), err: termsAgg(C('errorMessage.keyword'), 3) } },
    pay: { filter: anyOf({ terms: { [C('externalService.keyword')]: PAY_SERVICES } }, { terms: { [M('methodName.keyword')]: GATEWAY_METHODS } }),
      aggs: { svc: termsAgg(C('externalService.keyword'), 3), m: termsAgg(M('methodName.keyword'), 5), code: termsAgg(C('statusCode'), 4), t: { max: { field: '@timestamp' } } } },
    book: { filter: { bool: { filter: [{ term: { [M('message.keyword')]: 'End external system call' } }, { terms: { [C('actionName.keyword')]: BOOK_ACTIONS } }] } },
      aggs: { svc: { terms: { field: C('externalService.keyword'), size: 3 }, aggs: { act: { terms: { field: C('actionName.keyword'), size: 3 }, aggs: { code: termsAgg(C('statusCode'), 3) } } } }, t: { max: { field: '@timestamp' } } } },
    bookStart: { filter: { bool: { filter: [{ term: { [M('message.keyword')]: 'Start external system call' } }, { terms: { [C('actionName.keyword')]: BOOK_ACTIONS } }] } } },
    exc: { filter: { term: { [M('methodName.keyword')]: 'handleBookingException' } }, aggs: { e: termsAgg(C('exception.keyword'), 2) } },
    // Supplier for this booking: the last non-search, non-infrastructure supplier call in the window.
    sup: { filter: { bool: { filter: [{ exists: { field: C('externalService.keyword') } }],
      must_not: [{ terms: { [C('actionName.keyword')]: ['Search', 'search'] } }, { terms: { [C('externalService.keyword')]: [...PAY_SERVICES, 'Database', 'Redis', 'NDCMessaging', 'OrderService'] } }] } },
      aggs: { s: { terms: { field: C('externalService.keyword'), size: 5, order: { t: 'desc' } }, aggs: { t: { max: { field: '@timestamp' } } } } } },
  } });
  const a = r.aggregations; const keys = (x) => (x && x.buckets ? x.buckets.map((b) => b.key) : []);
  const steps = [];
  // Book-after-hold flow (BookAfterHold supplier action) does not go through bookAndPay / processMakePayment.
  const afterHold = a.book.svc.buckets.some((s) => s.act.buckets.some((x) => x.key === 'BookAfterHold'));
  const notUsed = (step) => ({ step, state: 'none', detail: 'not used (book-after-hold flow)' });
  steps.push(a.bap.doc_count ? { step: 'bookAndPay', state: 'ok', time: a.bap.t.value_as_string, detail: 'called' }
    : afterHold ? notUsed('bookAndPay') : { step: 'bookAndPay', state: 'missing', detail: 'not called' });
  const pmpErr = keys(a.pmp.err);
  steps.push(!a.pmp.doc_count ? (afterHold ? notUsed('processMakePayment') : { step: 'processMakePayment', state: 'missing', detail: 'not called' })
    : pmpErr.length ? { step: 'processMakePayment', state: 'error', time: a.pmp.t.value_as_string, detail: pmpErr.join(' | ') }
      : { step: 'processMakePayment', state: 'ok', time: a.pmp.t.value_as_string, detail: keys(a.pmp.st).length ? `status ${keys(a.pmp.st).join(', ')}` : 'called' });
  if (a.pay.doc_count) {
    const m = keys(a.pay.m); const codes = keys(a.pay.code).filter((c) => c !== 200);
    const svc = keys(a.pay.svc).join(', ') || 'gateway';
    // Card payment (BanqueMisr): getsessionid opens the bank page, getTransactionStatus is the result.
    // TripLink createCard = virtual card that pays the airline; success when no error code.
    const cardOpenNoResult = m.includes('getsessionid') && !m.includes('getTransactionStatus');
    steps.push({ step: 'Payment', state: codes.length ? 'error' : cardOpenNoResult ? 'pending' : 'ok', time: a.pay.t.value_as_string,
      detail: `${svc}: ${m.join(', ')}${codes.length ? ` · HTTP ${codes.join(',')}` : ''}${!codes.length && cardOpenNoResult ? ' · bank page opened, no payment result logged' : ''}` });
  } else steps.push({ step: 'Payment', state: 'none', detail: 'no gateway call (wallet / credit?)' });
  if (a.book.doc_count) {
    const parts = []; let bad = false;
    a.book.svc.buckets.forEach((s) => s.act.buckets.forEach((act) => { const codes = keys(act.code); if (codes.some((c) => c !== 200)) bad = true; parts.push(`${s.key} ${act.key} ${codes.join('/') || '?'}`); }));
    steps.push({ step: 'Supplier book', state: bad ? 'error' : 'ok', time: a.book.t.value_as_string, detail: parts.join(' · ') });
  } else steps.push({ step: 'Supplier book', state: a.bookStart.doc_count ? 'error' : 'missing', detail: a.bookStart.doc_count ? 'started, no response logged' : 'not called' });
  const exc = keys(a.exc.e);
  const payStep = steps.find((s) => s.step === 'Payment');
  // Supplier: the one that got the Hold/Book call for this booking; else the last supplier call in the window.
  return { from, to, steps, exception: exc[0] || null, supplier: (a.book.svc.buckets[0] || {}).key || keys(a.sup.s)[0] || '',
    banqueMisr: !!(payStep && /BanqueMisr/.test(payStep.detail)) };
}

// Verdict for ONE booking (ref), from its pay & book window – a session can hold several bookings.
// Same precedence as the session verdict; Banque Misr card payment overrides everything (business rule).
function focusVerdict(f) {
  if (!f || !f.steps) return null;
  const st = Object.fromEntries(f.steps.map((s) => [s.step, s]));
  const book = st['Supplier book'] || {}, pmp = st.processMakePayment || {}, bap = st.bookAndPay || {}, pay = st.Payment || {};
  let kind, verdict;
  if (f.exception) { kind = 'exception'; verdict = 'Booking exception: ' + f.exception; }
  else if (book.state === 'error') { kind = 'supplier'; verdict = `Supplier rejected: ${book.detail}`; }
  else if (pmp.state === 'error') { kind = 'payment-error'; verdict = 'Payment step error: ' + pmp.detail; }
  else if (bap.state === 'ok' && book.state !== 'ok') { kind = 'payment-incomplete'; verdict = `Stopped at payment (${pay.detail || 'no gateway call'}) – no supplier booking call followed`; }
  else if (book.state === 'ok') { kind = 'supplier-ok'; verdict = `Supplier booking OK (${book.detail}) – check post-booking steps (ticketing / DB update)`; }
  else if (bap.state === 'missing' && pmp.state === 'missing') { kind = 'no-booking'; verdict = 'No booking attempt around this ref (search/pricing only)'; }
  else { kind = 'unknown'; verdict = 'Unclear – read the timeline'; }
  if (f.banqueMisr) {
    const why = kind === 'supplier-ok' ? 'supplier booking returned 200 but the booking is not confirmed'
      : kind === 'payment-incomplete' ? 'no supplier booking call followed' : kind === 'no-booking' || kind === 'unknown' ? null : verdict;
    return { kind: 'not-booked-bm', reasonKind: kind, verdict: `Not booked – Banque Misr card payment used${why ? '; ' + why : ''}` };
  }
  return { kind, verdict, reasonKind: null };
}

const matchesAgency = (c, agency) => !agency || [c.agencyCode, c.agencyName].some((v) => v && v.toLowerCase() === agency.toLowerCase());

// One row per (ref, session). Refs with no session in their window are returned in notFound.
// items: [{ ref, created? }] – with a creation time the ref is searched around it (minutes before/after).
async function findCases({ refs, items, agency, from, to, autoRange, before = 60, after = 120 }) {
  const list = items && items.length ? items : refs.map((ref) => ({ ref }));
  const lookups = list.length
    ? await mapLimit(list, 5, async ({ ref, created }) => {
        const c = created ? Date.parse(created) : NaN;
        const w = !Number.isNaN(c) ? { from: new Date(c - before * 60e3).toISOString(), to: new Date(Math.min(c + after * 60e3, Date.now())).toISOString() }
          : (autoRange && refWindow(ref)) || { from, to };
        const hits = await findRefSessions(ref, w.from, w.to);
        return { ref, created: created || null, window: w, cids: hits.map((h) => h.cid), anchors: Object.fromEntries(hits.map((h) => [h.cid, h])) };
      })
    : [{ ref: '', window: { from, to }, cids: await findCorrelationIds({ agency, from, to }) }];
  const all = [...new Set(lookups.flatMap((l) => l.cids))];
  const summaries = new Map();
  for (let k = 0; k < all.length; k += 100) {
    for (const s of await summarize(all.slice(k, k + 100))) summaries.set(s.correlationId, s);
  }
  const rows = []; const notFound = []; const otherAgency = [];
  for (const l of lookups) {
    const cs = l.cids.map((id) => summaries.get(id)).filter(Boolean);
    const mine = cs.filter((c) => matchesAgency(c, agency));
    if (!cs.length) notFound.push({ ref: l.ref, window: l.window });
    else if (!mine.length) otherAgency.push({ ref: l.ref, agencies: [...new Set(cs.map((c) => c.agencyCode).filter(Boolean))] });
    mine.sort((a, b) => (a.last < b.last ? 1 : -1)).forEach((c) => rows.push({ ref: l.ref, created: l.created, anchor: l.anchors ? l.anchors[c.correlationId] : null, ...c }));
  }
  // Pay & book focus per row, around the ref's own log time (sessions can hold several bookings).
  await mapLimit(rows, 6, async (row) => {
    const a = row.anchor || (row.ref ? null : { refFirst: row.first, refLast: row.last });
    if (!a && !row.ref) return;
    try { row.focus = await payBookFocus(row.correlationId, (a || {}).refFirst || row.first, (a || {}).refLast || row.last); }
    catch (e) { row.focus = { error: e.message }; return; }
    // Per-booking verdict + supplier (the session-level ones are kept as sessionKind/sessionVerdict).
    if (row.ref) {
      const v = focusVerdict(row.focus);
      if (v) { row.sessionKind = row.kind; row.sessionVerdict = row.verdict; row.kind = v.kind; row.verdict = v.verdict; row.reasonKind = v.reasonKind; }
    }
    if (row.focus.supplier) { row.sessionSuppliers = row.suppliers; row.suppliers = [row.focus.supplier]; }
  });
  return { rows, notFound, otherAgency, searched: lookups.length };
}

module.exports = { findCorrelationIds, PHASES, BAD, phaseAggs, summarize, timeline, doc, MAX_REFS, parseRefs, refWindow, findRefSessions, GATEWAY_METHODS, payBookFocus, focusVerdict, matchesAgency, findCases };
