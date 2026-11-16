// Exceptions page: session explanation, exception history, what-changed comparison.
'use strict';
const { fs, path, OSD_URL, TENANT, INDEX, INDEX_PATTERN_ID, PORT, M, C, BIG_FIELDS, BOOK_ACTIONS, PAY_SERVICES, PAY_METHODS, search, range, termsAgg, anyOf, explain, execFile, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath, codeFor, DAY, mapLimit, changesSince, LOGGER_FRAME, isApp, parseFrames, topFrameOf, locKey } = require('./core');
const { timeline, summarize } = require('./cases');

function phaseOfEvent(m, c) {
  const a = c.actionName || '';
  if (m === 'handleBookingException' || BOOK_ACTIONS.includes(a)) return 'book';
  if (PAY_METHODS.includes(m) || PAY_SERVICES.includes(c.externalService) || /processTicket|processMakePayment/i.test(m)) return 'payment';
  if (/^fareReCheck/.test(m) || a === 'PnrReprice') return 'reprice';
  if (m === 'paxDetails' || m === 'prePaxDetails' || m === 'validatePassengerDetails') return 'pax';
  if (/^fareConfirm/.test(m) || ['FareConfirm', 'UpSelling'].includes(a)) return 'fare';
  if (m === 'getSearchResult' || /^search$/i.test(a)) return 'search';
  return 'other';
}

async function exceptionsFor(cid) {
  const ERR = { bool: { minimum_should_match: 1, should: [
    { term: { 'severity.text.keyword': 'ERROR' } }, { exists: { field: C('exception.keyword') } }, { exists: { field: C('errorMessage.keyword') } }] } };
  const [errs, tl, sum] = await Promise.all([
    search({ size: 300, sort: [{ '@timestamp': 'asc' }], query: { bool: { filter: [{ term: { [M('correlationId.keyword')]: cid } }, ERR] } },
      _source: { excludes: [C('request'), C('response'), C('returnValue')] } }),
    timeline(cid),
    summarize([cid]),
  ]);
  const events = tl.events.filter((e) => !/^search$/i.test((e.context || {}).actionName || ''));
  const groups = new Map();
  for (const h of errs.hits.hits) {
    const s = h._source; const m = (s.attributes && s.attributes.message) || {}; const c = m.context || {};
    const frames = parseFrames(s.body);
    const top = frames.find((f) => f.app && !LOGGER_FRAME.test(f.className)) || frames.find((f) => f.app) || null;
    // Some supplier messages arrive mangled ("Hosts+errors+durings+tickets+issue"); restore spaces for reading and matching.
    const unmangle = (t) => ((t || '').match(/s\+/g) || []).length >= 3 ? t.replace(/s\+/g, ' ').replace(/\+/g, ' ').replace(/s\|/g, '|').replace(/\)s/g, ')') : (t || '');
    const exception = unmangle(c.exception);
    const [type, ...rest] = exception.split(' : ');
    const msgFromMessage = /failed: (\w+)(?: : (.*))?$/.exec(m.message || '');
    const x = { type: (type || (msgFromMessage && msgFromMessage[1]) || '').trim(), msg: rest.join(' : ') || (msgFromMessage && msgFromMessage[2]) || '',
      exception, errorMessage: c.errorMessage || '', message: m.message || '', method: m.methodName, host: s.resource && s.resource['service.name'],
      supplier: c.externalService || '', statusCode: c.statusCode, frames, top, time: s['@timestamp'] };
    x.text = [x.exception, x.errorMessage, x.message, c.friendlyMessage].filter(Boolean).join(' | ');
    x.phase = phaseOfEvent(m.methodName || '', c);
    x.blockingPhase = ['book', 'payment'].includes(x.phase) || ['handleBookingException', 'bookAndPay'].includes(m.methodName);
    const sig = [x.type, x.msg || x.errorMessage || x.message, top ? `${top.className}:${top.lineNumber}` : x.method].join('|');
    if (!groups.has(sig)) groups.set(sig, { x, ids: [], times: [] });
    const g = groups.get(sig); g.ids.push(h._id); g.times.push(x.time);
  }
  const ORDER = { blocking: 0, related: 1, noise: 2 };
  const out = [];
  // Is it still happening in production? Same method + exception (+ message) across ALL sessions.
  async function prodStatus(x) {
    const f = [{ term: { [M('methodName.keyword')]: x.method || '' } }, { term: { 'severity.text.keyword': 'ERROR' } }];
    if (x.exception) f.push({ term: { [C('exception.keyword')]: x.exception } }); else if (x.message) f.push({ term: { [M('message.keyword')]: x.message } });
    const r = await search({ size: 0, query: { bool: { filter: f } }, aggs: {
      last: { max: { field: '@timestamp' } }, first: { min: { field: '@timestamp' } },
      d1: { filter: { range: { '@timestamp': { gte: 'now-24h' } } } }, d7: { filter: { range: { '@timestamp': { gte: 'now-7d' } } } } } });
    const a = r.aggregations;
    return { lastSeen: a.last.value_as_string || null, firstSeen: a.first.value_as_string || null, last24h: a.d1.doc_count, last7d: a.d7.doc_count, total: r.hits.total && (r.hits.total.value ?? r.hits.total) };
  }
  for (const { x, ids, times } of groups.values()) {
    x.firstLocal = times[0];
    const ex = explain(x);
    // Context: last few non-search events before the first occurrence (what led to it).
    const idx = events.findIndex((e) => ids.includes(e.id));
    const before = (idx > 0 ? events.slice(Math.max(0, idx - 5), idx) : []).map((e) => ({ time: e.time, method: e.method, message: e.message,
      supplier: (e.context || {}).externalService, action: (e.context || {}).actionName, statusCode: (e.context || {}).statusCode, level: e.level }));
    let code = null;
    try { code = await codeFor(x.top, x.host); } catch (e) { code = { error: e.message }; }
    let prod = null, fixes = [];
    try { [prod, fixes] = await Promise.all([prodStatus(x), changesSince(code, times[0])]); } catch (e) { console.error(`[server][exceptionsFor] status: ${e.message}`); }
    out.push({ id: ids[0], count: ids.length, prod, fixes, first: times[0], last: times[times.length - 1], phase: x.phase, host: x.host,
      type: x.type, msg: x.msg, exception: x.exception, errorMessage: x.errorMessage, message: x.message, method: x.method, supplier: x.supplier,
      frames: x.frames, top: x.top, code, before, ...ex });
  }
  out.sort((a, b) => ORDER[a.impact] - ORDER[b.impact] || (a.first < b.first ? 1 : -1));
  return { session: sum[0] || null, totalErrors: errs.hits.hits.length, exceptions: out, gitRef: GIT_REF };
}

// ---------------- Exception history: exception name + method over time ----------------


function historyFilter({ exception, method, message }) {
  const f = [{ term: { 'severity.text.keyword': 'ERROR' } }];
  if (exception) f.push(anyOf({ term: { [C('exception.keyword')]: exception } }, { prefix: { [C('exception.keyword')]: `${exception} : ` } }));
  if (method) f.push({ term: { [M('methodName.keyword')]: method } });
  if (message) f.push({ match_phrase: { [M('message')]: message } });
  return f;
}

async function exceptionHistory({ exception, method, message, from, to, tz }) {
  const base = historyFilter({ exception, method, message });
  const fromMs = Date.parse(from), toMs = Date.parse(to);
  const spanH = (toMs - fromMs) / 3600e3;
  const interval = spanH <= 48 ? '1h' : spanH <= 24 * 8 ? '6h' : '1d';
  const stepMs = { '1h': 3600e3, '6h': 6 * 3600e3, '1d': 24 * 3600e3 }[interval];
  const inRange = [...base, range(from, to)];
  const [r, life] = await Promise.all([
    search({ size: 0, track_total_hits: true, query: { bool: { filter: inRange } }, aggs: {
      hist: { date_histogram: { field: '@timestamp', fixed_interval: interval, time_zone: tz || 'UTC', min_doc_count: 0, extended_bounds: { min: fromMs, max: toMs } } },
      hosts: termsAgg('resource.service.name.keyword', 12), messages: termsAgg(M('message.keyword'), 8),
      exceptions: termsAgg(C('exception.keyword'), 8), methods: termsAgg(M('methodName.keyword'), 8),
      first: { min: { field: '@timestamp' } }, last: { max: { field: '@timestamp' } } } }),
    // Lifetime status, independent of the selected range
    search({ size: 0, query: { bool: { filter: base } }, aggs: { last: { max: { field: '@timestamp' } }, first: { min: { field: '@timestamp' } },
      d1: { filter: { range: { '@timestamp': { gte: 'now-24h' } } } }, d7: { filter: { range: { '@timestamp': { gte: 'now-7d' } } } } } }),
  ]);
  const total = r.hits.total && (r.hits.total.value ?? r.hits.total);
  const buckets = r.aggregations.hist.buckets.map((b) => ({ t: b.key, n: b.doc_count, loc: {} }));

  // Code locations live in the stack trace (not aggregatable): sample each time bucket and scale to its count.
  const SAMPLE = 120; const locInfo = new Map(); const recent = [];
  await mapLimit(buckets.filter((b) => b.n > 0), 6, async (b) => {
    const h = await search({ size: Math.min(SAMPLE, b.n), sort: [{ '@timestamp': 'desc' }], _source: ['body', '@timestamp', 'resource', M('correlationId')],
      query: { bool: { filter: [...base, { range: { '@timestamp': { gte: b.t, lt: b.t + stepMs, format: 'epoch_millis' } } }] } } });
    const counts = {};
    for (const x of h.hits.hits) {
      const top = topFrameOf(parseFrames(x._source.body)); const k = locKey(top);
      counts[k] = (counts[k] || 0) + 1;
      const t = x._source['@timestamp']; const host = x._source.resource && x._source.resource['service.name'];
      if (!locInfo.has(k)) locInfo.set(k, { key: k, frame: top, first: t, last: t, hosts: {}, sampleHost: host });
      const li = locInfo.get(k); if (t < li.first) li.first = t; if (t > li.last) li.last = t; li.hosts[host] = (li.hosts[host] || 0) + 1;
      recent.push({ time: t, host, cid: x._source.attributes && x._source.attributes.message && x._source.attributes.message.correlationId, loc: k });
    }
    const n = h.hits.hits.length;
    for (const [k, c] of Object.entries(counts)) b.loc[k] = Math.round((c / n) * b.n);
  });
  // Rank locations by estimated total; keep 5, fold the rest into "Other".
  const est = {}; buckets.forEach((b) => Object.entries(b.loc).forEach(([k, v]) => { est[k] = (est[k] || 0) + v; }));
  const ranked = Object.entries(est).sort((a, b) => b[1] - a[1]);
  const keep = ranked.slice(0, 5).map(([k]) => k);
  const locations = await Promise.all(ranked.map(async ([k, n], i) => {
    const li = locInfo.get(k);
    let code = null, changes = [];
    if (i < 5 && li.frame) { try { code = await codeFor(li.frame, li.sampleHost); changes = await changesSince(code, null, 4); } catch { /* ignore */ } }
    return { key: k, estimated: n, share: total ? n / total : 0, first: li.first, last: li.last, frame: li.frame,
      hosts: Object.entries(li.hosts).sort((a, b) => b[1] - a[1]).map(([h, c]) => ({ host: h, n: c })), code, changes, rank: i };
  }));
  const series = buckets.map((b) => { const o = { t: b.t, n: b.n, parts: {} }; let other = b.n;
    keep.forEach((k) => { const v = b.loc[k] || 0; o.parts[k] = v; other -= v; }); o.parts.Other = Math.max(0, other); return o; });
  recent.sort((a, b) => (a.time < b.time ? 1 : -1));
  const seen = new Set(); const sessions = recent.filter((x) => x.cid && !seen.has(x.cid) && seen.add(x.cid)).slice(0, 15);
  const keys = (a) => a.buckets.map((b) => ({ key: b.key, n: b.doc_count }));
  const L = life.aggregations;
  return { query: { exception, method, message, from, to, interval }, total,
    first: r.aggregations.first.value_as_string, last: r.aggregations.last.value_as_string,
    lifetime: { first: L.first.value_as_string, last: L.last.value_as_string, last24h: L.d1.doc_count, last7d: L.d7.doc_count },
    series, keep, locations, sessions, hosts: keys(r.aggregations.hosts), messages: keys(r.aggregations.messages),
    exceptions: keys(r.aggregations.exceptions), methods: keys(r.aggregations.methods), gitRef: GIT_REF, sampled: total > 0 };
}

// Suggestions for the form: exception type names and methods with errors in the last 7 days.
let suggestCache = null;
async function exceptionSuggest() {
  if (suggestCache && Date.now() - suggestCache.at < 10 * 60e3) return suggestCache.data;
  const r = await search({ size: 0, query: { bool: { filter: [{ term: { 'severity.text.keyword': 'ERROR' } }, { range: { '@timestamp': { gte: 'now-7d' } } }] } },
    aggs: { ex: termsAgg(C('exception.keyword'), 300), m: termsAgg(M('methodName.keyword'), 150) } });
  const types = {}; r.aggregations.ex.buckets.forEach((b) => { const t = b.key.split(' : ')[0].trim(); if (/^[\w$.]+$/.test(t)) types[t] = (types[t] || 0) + b.doc_count; });
  const data = { exceptions: Object.entries(types).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ key: k, n })),
    methods: r.aggregations.m.buckets.map((b) => ({ key: b.key, n: b.doc_count })) };
  suggestCache = { at: Date.now(), data }; return data;
}

// ---------------- What changed: error signatures after a time T vs the same span before T ----------------
async function errorChanges({ at, to }) {
  const T = Date.parse(at), E = Math.min(Date.parse(to || new Date().toISOString()), Date.now());
  if (Number.isNaN(T) || T >= E) throw Object.assign(new Error('Pick a time in the past.'), { status: 400 });
  const span = Math.min(E - T, 7 * 24 * 3600e3);
  const win = (f, t) => ({ range: { '@timestamp': { gte: new Date(f).toISOString(), lt: new Date(t).toISOString() } } });
  // Baseline: up to 24h → the same clock hours on each of the 3 previous days (traffic has a strong daily cycle);
  // longer → the same length of time just before T.
  const DAY = 24 * 3600e3;
  const baseWins = span <= DAY ? [1, 2, 3].map((d) => [T - d * DAY, T - d * DAY + span]) : [[T - span, T]];
  const sig = { terms: { field: M('methodName.keyword'), size: 400 }, aggs: { e: { terms: { field: C('exception.keyword'), size: 8, missing: '(no exception)' } } } };
  const aggs = { after: { filter: win(T, E), aggs: { m: sig } } };
  baseWins.forEach(([f, t], i) => { aggs['b' + i] = { filter: win(f, t), aggs: { m: sig } }; });
  const r = await search({ size: 0, query: { bool: { filter: [{ term: { 'severity.text.keyword': 'ERROR' } }, win(Math.min(...baseWins.map((w) => w[0])), E)] } }, aggs });
  const flat = (agg) => { const o = new Map(); agg.m.buckets.forEach((m) => m.e.buckets.forEach((e) => o.set(`${m.key}\u0001${e.key}`, e.doc_count))); return o; };
  const after = flat(r.aggregations.after);
  const before = new Map(); // average per baseline window
  baseWins.forEach((_, i) => flat(r.aggregations['b' + i]).forEach((v, k) => before.set(k, (before.get(k) || 0) + v / baseWins.length)));
  const B = Math.min(...baseWins.map((w) => w[0]));
  const rows = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const b = Math.round((before.get(k) || 0) * 10) / 10, a = after.get(k) || 0; const [method, exception] = k.split('\u0001');
    let change = null;
    if (!b && a >= 3) change = 'new';
    else if (b && a >= 5 && a / b >= 2) change = 'increased';
    else if (b >= 5 && !a) change = 'gone';
    else if (b >= 10 && a / b <= 0.4) change = 'decreased';
    if (change) rows.push({ method, exception, before: b, after: a, change });
  }
  const order = { new: 0, increased: 1, gone: 2, decreased: 3 };
  rows.sort((x, y) => order[x.change] - order[y.change] || (y.after + y.before) - (x.after + x.before));
  // Code location for new / increased signatures: most common application frame in a sample of the "after" errors.
  await mapLimit(rows.filter((x) => x.change === 'new' || x.change === 'increased').slice(0, 30), 6, async (x) => {
    const f = [{ term: { 'severity.text.keyword': 'ERROR' } }, { term: { [M('methodName.keyword')]: x.method } }, win(T, E)];
    if (x.exception !== '(no exception)') f.push({ term: { [C('exception.keyword')]: x.exception } });
    const h = await search({ size: 40, sort: [{ '@timestamp': 'asc' }], _source: ['body', '@timestamp', M('message'), M('correlationId')], query: { bool: { filter: f } } });
    const locs = {}; h.hits.hits.forEach((d) => { const k = locKey(topFrameOf(parseFrames(d._source.body))); locs[k] = (locs[k] || 0) + 1; });
    x.location = Object.entries(locs).sort((p, q) => q[1] - p[1])[0]?.[0] || '';
    const first = h.hits.hits[0]; x.firstAfter = first ? first._source['@timestamp'] : null;
    x.sample = first ? { message: first._source.attributes.message.message, cid: first._source.attributes.message.correlationId } : null;
  });
  return { at: new Date(T).toISOString(), to: new Date(E).toISOString(), beforeFrom: new Date(B).toISOString(), hours: +(span / 3600e3).toFixed(1),
    baseline: span <= DAY ? 'same hours on the 3 previous days (average)' : 'the same length of time just before', rows };
}

// Recent merges on the deploy branches (quick picks for "what changed since").
async function recentMerges() {
  const out = [];
  for (const b of ['origin/master', 'origin/UAT']) {
    try {
      const s = await git(['log', b, '--first-parent', '--since=4.days', '--format=%h%x09%cI%x09%s', '-12']);
      s.trim().split('\n').filter(Boolean).forEach((l) => { const [hash, iso, subject] = l.split('\t'); out.push({ branch: b.replace('origin/', ''), hash, time: iso, subject }); });
    } catch { /* branch missing */ }
  }
  return out.sort((x, y) => (x.time < y.time ? 1 : -1));
}

module.exports = { phaseOfEvent, exceptionsFor, historyFilter, exceptionHistory, exceptionSuggest, errorChanges, recentMerges };
