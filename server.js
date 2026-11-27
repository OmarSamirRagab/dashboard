// NDC not-booked case investigator: local read-only UI over OpenSearch Dashboards.
// Credentials come from env vars OSD_USER / OSD_PASS (never stored in files).
'use strict';
const http = require('http');
const { fs, path, OSD_URL, TENANT, INDEX, INDEX_PATTERN_ID, PORT, M, C, BIG_FIELDS, BOOK_ACTIONS, PAY_SERVICES, PAY_METHODS, search, range, termsAgg, anyOf, explain, execFile, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath, codeFor, DAY, mapLimit, changesSince, LOGGER_FRAME, isApp, parseFrames, topFrameOf, locKey } = require('./lib/core');
const { findCorrelationIds, PHASES, BAD, phaseAggs, summarize, timeline, doc, MAX_REFS, parseRefs, refWindow, findRefSessions, GATEWAY_METHODS, payBookFocus, focusVerdict, matchesAgency, findCases } = require('./lib/cases');
const { IDEA_PORT, IDEA_EXE, workingCopyLine, openInIdea } = require('./lib/ide');
const { phaseOfEvent, exceptionsFor, historyFilter, exceptionHistory, exceptionSuggest, errorChanges, recentMerges } = require('./lib/exceptions');
const { FAIL_METHODS, unmangleText, cleanReason, bookingFailures } = require('./lib/failures');

// ---------------- Suggested fixes (local rules, no AI) ----------------
const fixer = require('./fixer').createFixer({ git, GIT_REF, REPO_DIR, getJavaIndex, gitFile, codeFor, openInIdea });

function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); }

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = ''; req.on('data', (d) => { s += d; if (s.length > 8e6) req.destroy(); });
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(new Error('Bad JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(u.searchParams);
  try {
    if (u.pathname === '/api/cases') {
      const p = req.method === 'POST' ? await readBody(req) : q;
      const items = Array.isArray(p.items) ? p.items.filter((x) => x && typeof x.ref === 'string' && x.ref.trim())
        .map((x) => ({ ref: x.ref.trim(), created: x.created && !Number.isNaN(Date.parse(x.created)) ? new Date(x.created).toISOString() : null })) : [];
      const refs = items.length ? items.map((x) => x.ref) : parseRefs(p.refs || p.ref); const agency = String(p.agency || '').trim();
      if (!refs.length && !agency) return send(res, 400, { error: 'Enter booking reference(s) or an agency.' });
      if (refs.length > MAX_REFS) return send(res, 400, { error: `Too many refs (${refs.length}); max ${MAX_REFS} per run.` });
      const autoRange = p.autoRange === undefined ? true : p.autoRange === true || p.autoRange === 'true';
      const clamp = (v, d) => Math.min(24 * 60, Math.max(5, Number(v) || d));
      return send(res, 200, await findCases({ refs, items, agency, from: p.from, to: p.to, autoRange, before: clamp(p.before, 60), after: clamp(p.after, 120) }));
    }
    if (u.pathname === '/api/azdo/workitem' && q.id) {
      try { return send(res, 200, await require('./azdo').workItem(Number(q.id))); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (u.pathname === '/api/azdo/post' && req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
      const b = await readBody(req);
      try {
        let pdf = null; const fileName = `not-booked-investigation-${new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '')}.pdf`;
        if (b.attachPdf && b.report) { const { renderHtml, renderTableHtml, htmlToPdf } = require('./report'); pdf = await htmlToPdf(b.report.columns ? renderTableHtml(b.report) : renderHtml(b.report)); }
        const r = await require('./azdo').post({ workItemId: b.workItemId, teamLeader: String(b.teamLeader || '').trim(), comment: String(b.comment || '').slice(0, 20000), pdf, fileName });
        console.log(`[server][azdo] comment ${r.commentId} posted on work item ${r.workItem.id}${r.attachment ? ' with ' + fileName : ''}`);
        return send(res, 200, r);
      } catch (e) { console.error(`[server][azdo] ${e.message}`); return send(res, e.status || 500, { error: e.message }); }
    }
    if (u.pathname === '/api/export/pdf' && req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
      const { renderHtml, renderTableHtml, htmlToPdf } = require('./report');
      const body = await readBody(req);
      const pdf = await htmlToPdf(body.columns ? renderTableHtml(body) : renderHtml(body));
      res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length,
        'Content-Disposition': `attachment; filename="not-booked-cases-${new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '')}.pdf"` });
      return res.end(pdf);
    }
    if (u.pathname === '/api/timeline' && q.cid) return send(res, 200, await timeline(q.cid));
    if (u.pathname === '/api/exceptions' && q.cid) return send(res, 200, await exceptionsFor(q.cid.trim()));
    if (u.pathname === '/api/exception-history') {
      const exception = (q.exception || '').trim(), method = (q.method || '').trim(), message = (q.message || '').trim();
      if (!exception && !method && !message) return send(res, 400, { error: 'Enter an exception name and/or a method.' });
      return send(res, 200, await exceptionHistory({ exception, method, message, from: q.from || new Date(Date.now() - 7 * 24 * 3600e3).toISOString(), to: q.to || new Date().toISOString(), tz: q.tz }));
    }
    if (u.pathname === '/api/exception-suggest') return send(res, 200, await exceptionSuggest());
    if (u.pathname === '/api/changes') {
      try { return send(res, 200, await errorChanges({ at: q.at, to: q.to })); } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (u.pathname === '/api/merges') return send(res, 200, await recentMerges());
    if (u.pathname === '/api/failures') {
      const to = q.to || new Date().toISOString(), from = q.from || new Date(Date.now() - 24 * 3600e3).toISOString();
      if (Date.parse(to) - Date.parse(from) > 31 * 24 * 3600e3) return send(res, 400, { error: 'Range too large (max 31 days).' });
      return send(res, 200, await bookingFailures({ from, to, agency: q.agency, supplier: q.supplier }));
    }
    if ((u.pathname === '/api/fix/propose' || u.pathname === '/api/fix/apply') && req.method === 'POST') {
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
      const b = await readBody(req);
      try {
        return send(res, 200, u.pathname.endsWith('propose') ? await fixer.propose(b) : await fixer.apply({ id: String(b.id || ''), branch: String(b.branch || '').trim(), open: b.open !== false }));
      } catch (e) {
        console.error(`[server][${u.pathname}] ${e.message}`);
        return send(res, e.status || 500, { error: e.message, branch: e.branch });
      }
    }
    if (u.pathname === '/api/open-ide' && req.method === 'POST') {
      // JSON only: forces a CORS preflight, so other web pages cannot trigger this endpoint.
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
      const b = await readBody(req);
      return send(res, 200, await openInIdea(String(b.path || ''), Math.max(1, Number(b.line) || 1)));
    }
    if (u.pathname === '/api/code' && q.cls) {
      return send(res, 200, await codeFor({ className: q.cls, fileName: q.file, lineNumber: Number(q.line) }, q.host, 10));
    }
    if (u.pathname === '/api/doc' && q.id) return send(res, 200, await doc(q.id, q.index));
    if (u.pathname.startsWith('/api/work/')) {
      const work = require('./lib/work');
      try {
        if (u.pathname === '/api/work/items') return send(res, 200, await work.list());
        if (u.pathname === '/api/work/item' && /^\d+$/.test(q.id || '')) return send(res, 200, await work.detail(Number(q.id)));
        if (u.pathname === '/api/work/diff' && q.hash) return send(res, 200, await work.commitDiff(q.hash));
      } catch (e) { console.error(`[server][${u.pathname}] ${e.message}`); return send(res, e.status || 500, { error: e.message }); }
    }
    if (u.pathname.startsWith('/api/perf/')) {
      const perf = require('./lib/perf');
      try {
        if (u.pathname === '/api/perf/endpoints') return send(res, 200, await perf.discover(q.refresh === '1'));
        if (u.pathname === '/api/perf/status') return send(res, 200, perf.status());
        if (u.pathname === '/api/perf/report') {
          const th = { warn: Math.max(100, Number(q.warn) || 1000), crit: Math.max(200, Number(q.crit) || 5000) };
          return send(res, 200, await perf.report(['last', 'baseline', 'current'].includes(q.run) ? q.run : 'current', th));
        }
        if (u.pathname === '/api/perf/analyze' && q.id) return send(res, 200, await perf.analyze(q.id));
        if (req.method === 'POST') {
          // JSON only: forces a CORS preflight, so other web pages cannot start runs against the local backend.
          if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'JSON required' });
          const b = await readBody(req);
          if (u.pathname === '/api/perf/run') return send(res, 200, await perf.startRun(b));
          if (u.pathname === '/api/perf/stop') return send(res, 200, perf.stopRun());
          if (u.pathname === '/api/perf/baseline') return send(res, 200, perf.saveBaseline());
          if (u.pathname === '/api/perf/params') return send(res, 200, await perf.saveParams(b.params));
          if (u.pathname === '/api/perf/dbfill') return send(res, 200, await perf.fillFromDb());
        }
      } catch (e) { console.error(`[server][${u.pathname}] ${e.message}`); return send(res, e.status || 500, { error: e.message }); }
    }
    if (u.pathname === '/api/config') return send(res, 200, { osdUrl: OSD_URL, tenant: TENANT, indexPatternId: INDEX_PATTERN_ID,
      fix: { worktree: fixer.FIX_WORKTREE, gitRef: GIT_REF }, azdo: require('./azdo').settings() });
    const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/exceptions': 'exceptions.html', '/exceptions.html': 'exceptions.html',
      '/failures': 'failures.html', '/failures.html': 'failures.html', '/performance': 'performance.html', '/performance.html': 'performance.html', '/work': 'work.html', '/work.html': 'work.html',
      '/app.css': 'app.css', '/common.js': 'common.js', '/code.js': 'code.js' };
    if (STATIC[u.pathname]) {
      const f = STATIC[u.pathname]; const type = f.endsWith('.css') ? 'text/css' : f.endsWith('.js') ? 'text/javascript' : 'text/html';
      res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(__dirname, 'public', f)).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(`[server][${u.pathname}] ${e.message}`);
    send(res, 502, { error: e.message });
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`NDC case investigator on http://127.0.0.1:${PORT}`));
