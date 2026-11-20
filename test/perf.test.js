'use strict';
// node --test  (Node 18+, no dependencies)
process.env.OSD_USER = process.env.OSD_USER || 'test'; process.env.OSD_PASS = process.env.OSD_PASS || 'test'; // lib/core exits without them
const test = require('node:test');
const assert = require('node:assert/strict');
const { stripComments, endpointsInFile, classify, pathRegex, buildUrl, largestArray, loops, measuredFindings } = require('../lib/perf');

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
  assert.equal(st('/v2/airline/search').run, false);
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
