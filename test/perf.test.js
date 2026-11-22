'use strict';
// node --test  (Node 18+, no dependencies)
process.env.OSD_USER = process.env.OSD_USER || 'test'; process.env.OSD_PASS = process.env.OSD_PASS || 'test'; // lib/core exits without them
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripComments, endpointsInFile, classify, pathRegex, buildUrl, largestArray, loops, measuredFindings, Session, login, baseUrl, isLocal, generated, hintsOf, bodyFrom, mutatingWord } = require('../lib/perf');
const perfdb = require('../lib/perfdb');

const JAVA = `package com.tt.x;
import org.springframework.web.bind.annotation.*;
// @RequestMapping("/commented-out")
@RestController
@RequestMapping(value = "/v2/" + AirlineControllerV2.BASE)
public class AirlineControllerV2 {
  public static final String BASE = "airline";
  /* @GetMapping("/nope") */
  @Autowired private AirlineService airlineService;

  @RequestMapping(value = "/list", method = RequestMethod.GET, produces = "application/json")
  public ResponseEntity<List<Airline>> list(@RequestParam(value = "q", required = false) String q, HttpServletRequest req) {
    return ok(airlineService.getAll(q, "http://x"));
  }

  @PreAuthorize("hasRole('ADMIN')")
  @GetMapping({"/{id}", "/byId/{id}"})
  public Airline one(@PathVariable("id") Long id) { return airlineService.get(id); }

  @PostMapping("/search")
  public Object search(@RequestBody SearchRq rq) throws Exception { return null; }

  @GetMapping("/deleteCache")
  public void deleteCache() { }

  @GetMapping("/byCode")
  public Airline byCode(@RequestParam String code) { return null; }
}`;

const fileOf = (raw) => { const clean = stripComments(raw); return { path: 'odeysysportal-tt/src/main/java/com/tt/x/AirlineControllerV2.java', app: 'portal', raw, clean, lines: raw.split('\n'),
  consts: new Map([...clean.matchAll(/\bString\s+(\w+)\s*=\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()])), staticImports: [] }; };

test('stripComments keeps strings, line count and offsets', () => {
  const s = 'a // x\nb /* y\nz */ c "http://k" // q';
  const o = stripComments(s);
  assert.equal(o.length, s.length); assert.equal(o.split('\n').length, 3);
  assert.ok(o.includes('"http://k"')); assert.ok(!o.includes('x')); assert.ok(!o.includes('z'));
});

test('endpointsInFile reads class + method mappings, constants, verbs and params', async () => {
  const eps = await endpointsInFile(fileOf(JAVA), '/rest');
  const by = (p) => eps.filter((e) => e.path === p);
  assert.deepEqual(eps.map((e) => e.path), ['/v2/airline/list', '/v2/airline/{id}', '/v2/airline/byId/{id}', '/v2/airline/search', '/v2/airline/deleteCache', '/v2/airline/byCode']);
  assert.ok(!eps.some((e) => /nope|commented/.test(e.path)));
  const list = by('/v2/airline/list')[0];
  assert.deepEqual(list.verbs, ['GET']); assert.equal(list.methodName, 'list'); assert.equal(list.fullPath, '/rest/v2/airline/list');
  assert.equal(list.line, 11); assert.equal(list.produces, '"application/json"');
  assert.deepEqual(list.params, [{ kind: 'RequestParam', name: 'q', type: 'String', required: false }]);
  const one = by('/v2/airline/{id}')[0];
  assert.equal(one.methodName, 'one'); assert.deepEqual(one.params.map((p) => [p.kind, p.name]), [['PathVariable', 'id']]);
  assert.deepEqual(by('/v2/airline/search')[0].verbs, ['POST']);
  assert.equal(by('/v2/airline/byCode')[0].params[0].required, true);
});

test('classify: only safe GETs with all values run automatically', async () => {
  const eps = await endpointsInFile(fileOf(JAVA), '');
  const st = (p, defaults = {}) => classify({ ...eps.find((e) => e.path === p), verb: eps.find((e) => e.path === p).verbs[0] }, defaults);
  assert.equal(st('/v2/airline/list').run, true);
  assert.equal(st('/v2/airline/search').run, true); // POST whose name only reads: body is generated
  assert.match(st('/v2/airline/search').why, /read-only POST \("search"\)/);
  assert.match(st('/v2/airline/deleteCache').why, /"delete"/);
  assert.deepEqual(st('/v2/airline/{id}').missing, ['id']);
  assert.equal(st('/v2/airline/{id}', { id: 5 }).run, true);
  assert.deepEqual(st('/v2/airline/byCode').missing, ['code']);
});

test('buildUrl fills path variables and required params from defaults', () => {
  const ep = { fullPath: '/rest/v2/airline/{id:.+}', params: [{ kind: 'RequestParam', name: 'code', required: true }], suffix: '' };
  assert.equal(buildUrl(ep, { baseUrl: 'http://127.0.0.1:8080/odeysysportal' }, { id: 'MS', code: 'a b' }), 'http://127.0.0.1:8080/odeysysportal/rest/v2/airline/MS?code=a+b');
  assert.ok(pathRegex('/v2/airline/{id}').test('/v2/airline/12')); assert.ok(!pathRegex('/v2/airline/{id}').test('/v2/airline/12/x'));
});

test('loops finds for/while blocks and lambdas; largestArray finds the biggest list', () => {
  const src = stripComments('void a() {\n for (X x : xs) {\n  dao.get(x);\n }\n xs.forEach(x -> dao.get(x));\n}');
  const ls = loops(src, 1, 6);
  assert.deepEqual(ls, [[2, 4, true], [5, 5, false]]);
  assert.equal(largestArray({ data: { rows: [1, 2, 3] }, other: [1] }), 3);
});

test('measuredFindings: slow, cold start, payload, auth', () => {
  const th = { warn: 1000, crit: 5000 };
  const base = { status: 200, runs: [13000, 13100, 12900], median: 13000, min: 12900, max: 13100, cold: 14000, ttfb: 12900, bytes: 2e6, encoding: '', items: 4000 };
  const rules = measuredFindings(base, th).map((f) => f.rule);
  assert.deepEqual(rules, ['slow', 'payload', 'gzip', 'paging']);
  assert.equal(measuredFindings(base, th)[0].sev, 'critical');
  assert.ok(measuredFindings({ ...base, cold: 9000, median: 1500, runs: [1500, 1500, 1500], min: 1500, max: 9000 }, th).some((f) => f.rule === 'cold'));
  assert.deepEqual(measuredFindings({ ...base, status: 302, location: '/login' }, th).map((f) => f.rule), ['auth']);
  assert.deepEqual(measuredFindings({ ...base, error: 'ECONNREFUSED' }, th).map((f) => f.rule), ['error']);
});

test('form login posts url-encoded fields, keeps the session cookie and detects a rejected login', async () => {
  const http = require('node:http'); let seen = null;
  const srv = http.createServer((q, r) => { let b = ''; q.on('data', (d) => (b += d)); q.on('end', () => {
    if (q.url === '/odeysysadmin/Admin2/loginAction') {
      const f = new URLSearchParams(b); seen = { type: q.headers['content-type'], user: f.get('userName') };
      const good = f.get('password') === 'pw1';
      r.writeHead(302, good ? { Location: '/odeysysadmin/home', 'Set-Cookie': 'JSESSIONID=abc; Path=/; HttpOnly' } : { Location: '/odeysysadmin/login.jsp?error=Invalid+user' }); return r.end();
    }
    r.writeHead(200); r.end(q.headers.cookie || '');
  }); }).listen(0, '127.0.0.1');
  await new Promise((ok) => srv.once('listening', ok));
  const base = `http://127.0.0.1:${srv.address().port}/odeysysadmin`;
  const cfg = { method: 'POST', path: '/Admin2/loginAction', form: true, body: { userName: '${PERF_USER}', password: '${PERF_PASS}' }, failIf: 'invalid|incorrect' };
  try {
    process.env.PERF_USER = 'tester'; process.env.PERF_PASS = 'pw1';
    const s = new Session({ baseUrl: base }); const ok = await login(s, cfg, 5000);
    assert.equal(ok.ok, true); assert.equal(ok.status, 302); assert.deepEqual(seen, { type: 'application/x-www-form-urlencoded', user: 'tester' });
    const after = await s.call('GET', base + '/x', undefined, {}, 5000);
    assert.equal(after.buf.toString(), 'JSESSIONID=abc');
    process.env.PERF_PASS = 'wrong';
    const bad = await login(new Session({ baseUrl: base }), cfg, 5000);
    assert.equal(bad.ok, false); assert.match(bad.error, /login rejected/);
  } finally { srv.close(); delete process.env.PERF_USER; delete process.env.PERF_PASS; }
});

test('base URLs without a scheme get http:// and count as local', () => {
  assert.equal(baseUrl('localhost:8080/odeysysadmin/'), 'http://localhost:8080/odeysysadmin');
  assert.equal(baseUrl(' http://127.0.0.1:8080/odeysysportal '), 'http://127.0.0.1:8080/odeysysportal');
  assert.equal(isLocal(baseUrl('localhost:8080/odeysysadmin')), true);
  assert.equal(isLocal('http://10.0.0.5:8080/odeysysadmin'), false);
});

test('login reports unset PERF_* variables instead of sending empty fields', async () => {
  delete process.env.PERF_PORTAL_EMAIL;
  const r = await login(new Session({ baseUrl: 'http://127.0.0.1:9' }), { path: '/v2/auth/loginAction', body: { email: '${PERF_PORTAL_EMAIL}' } }, 1000);
  assert.equal(r.ok, false); assert.match(r.error, /PERF_PORTAL_EMAIL not set/);
});

test('POSTs that change data stay blocked; login/OTP never called', () => {
  const st = (path, methodName, verb = 'POST') => classify({ path, fullPath: path, methodName, verb, params: [{ kind: 'RequestBody', name: 'rq', type: 'X' }] }, {});
  assert.equal(st('/Master2/airline', 'addAirline').run, false);
  assert.equal(st('/v2/booking/cancel', 'cancelBooking').run, false);
  assert.equal(st('/Admin2/loginDetails/search', 'searchLoginDetailsV2').run, false); // "login"
  assert.equal(st('/v2/auth/otp/send', 'sendOTP').run, false);
  assert.equal(st('/Master2/airline/{id}', 'updateAirline', 'PUT').run, false);
  assert.equal(st('/v2/report/sales/list', 'getSalesReport').run, true);
});

test('generated values: date ranges and paging', () => {
  const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  assert.equal(generated('invoiceFromDate'), day(-30)); assert.equal(generated('invoiceToDate'), day(0));
  assert.equal(generated('journeyDate'), day(14)); assert.equal(generated('pageSize'), '20'); assert.equal(generated('page'), '0');
  assert.equal(generated('status'), undefined);
});

test('DB column matching: xxxId -> pk of xxx table, id -> pk of the path entity, ambiguous names skipped', () => {
  perfdb._setCache({ schema: [['tbl_airline', 'airline_id', 'PRI'], ['tbl_airline', 'code', ''], ['airport', 'id', 'PRI'], ['airport', 'code', 'UNI'],
    ['booking', 'id', 'PRI'], ['booking', 'airline_id', 'MUL'], ['a', 'status', ''], ['b', 'status', ''], ['c', 'status', ''], ['d', 'status', ''], ['supplier', 'supplier_name', '']], values: {} });
  const k = (n, h) => { const c = perfdb.resolveColumn(n, h); return c && `${c.t}.${c.c}`; };
  assert.equal(k('airlineId', []), 'tbl_airline.airline_id');
  assert.equal(k('id', ['airports', 'Master2']), 'airport.id');
  assert.equal(k('id', ['nothing']), null);
  assert.equal(k('code', ['airline']), 'tbl_airline.code');
  assert.equal(k('status', []), null); // in 4 tables: ambiguous
  assert.equal(k('supplierName', []), 'supplier.supplier_name');
  assert.deepEqual(hintsOf({ fullPath: '/Master2/airline/{id}', className: 'airlineControllerV2' }).slice(0, 2), ['airline', 'Master2']);
});

test('bodyFrom fills known fields with the right JSON types and leaves unknown ones out', () => {
  const fields = [{ name: 'airlineId', type: 'Long' }, { name: 'active', type: 'Boolean' }, { name: 'name', type: 'String' },
    { name: 'paging', type: 'Paging', kids: [{ name: 'pageSize', type: 'int' }] }, { name: 'empty', type: 'X', kids: [{ name: 'zzz', type: 'String' }] }];
  const v = { airlineId: '12', active: 'true', pageSize: '20' };
  assert.deepEqual(bodyFrom(fields, (n) => v[n]), { airlineId: 12, active: true, paging: { pageSize: 20 } });
});
