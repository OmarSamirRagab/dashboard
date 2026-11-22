// Performance: discover Odeysys REST endpoints from source, time them against a LOCAL WildFly, suggest fixes.
// Only GET endpoints are found automatically; anything that changes data must be listed in perf.endpoints.json.
'use strict';
const { fs, path, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath } = require('./core');
const perfdb = require('./perfdb');

// "localhost:8080/x" has no scheme: new URL() would read "localhost:" as the protocol, so default to http://.
const baseUrl = (v) => (/^https?:\/\//i.test(v.trim()) ? v.trim() : 'http://' + v.trim()).replace(/\/+$/, '');
const APPS = [
  { key: 'admin', module: 'odeysysadmin-tt', baseUrl: baseUrl(process.env.PERF_ADMIN_URL || 'http://127.0.0.1:8080/odeysysadmin') },
  { key: 'portal', module: 'odeysysportal-tt', baseUrl: baseUrl(process.env.PERF_PORTAL_URL || 'http://127.0.0.1:8080/odeysysportal') },
];
const PERF_FILE = process.env.PERF_FILE || path.join(__dirname, '..', 'perf.endpoints.json');
const RESULTS_DIR = path.join(__dirname, '..', 'perf-results');
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
const isLocal = (u) => { try { return LOCAL_HOST.test(new URL(u).hostname); } catch { return false; } };
const ALLOW_REMOTE = process.env.PERF_ALLOW_REMOTE === '1';

// ---------------- Java source parsing (no compiler: comments stripped, brackets matched) ----------------
// Replace comments with spaces, keeping newlines and string literals, so offsets and line numbers stay valid.
function stripComments(src) {
  let out = '', i = 0; const n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && d === '*') { out += '  '; i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i++; } out += '  '; i += 2; continue; }
    if (c === '"' || c === "'") { const q = c; out += c; i++; while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') { out += src[i++]; } out += src[i++] || ''; } out += src[i] || ''; i++; continue; }
    out += c; i++;
  }
  return out;
}
// Index of the bracket that closes the one at `i` ('(' '{' '['), skipping string literals; -1 if unbalanced.
function matchClose(s, i) {
  const open = s[i], close = { '(': ')', '{': '}', '[': ']' }[open]; let depth = 0;
  for (let k = i; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'") { k++; while (k < s.length && s[k] !== c) { if (s[k] === '\\') k++; k++; } continue; }
    if (c === open) depth++; else if (c === close && --depth === 0) return k;
  }
  return -1;
}
// Split on a separator at bracket depth 0, outside string literals.
function splitTop(s, sep) {
  const parts = []; let depth = 0, cur = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (c === '"' || c === "'") { let j = k + 1; while (j < s.length && s[j] !== c) { if (s[j] === '\\') j++; j++; } cur += s.slice(k, j + 1); k = j; continue; }
    if ('({['.includes(c)) depth++; else if (')}]'.includes(c)) depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim());
}
const lineAt = (s, idx) => { let n = 1; for (let k = 0; k < idx; k++) if (s[k] === '\n') n++; return n; };

const ANNO_RE = /@(RequestMapping|GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping)\b\s*/; // copied per file (lastIndex is per instance)
const VERB_OF = { GetMapping: 'GET', PostMapping: 'POST', PutMapping: 'PUT', DeleteMapping: 'DELETE', PatchMapping: 'PATCH' };

// Annotation arguments -> { value: [expr...], method: [...], ... }; a bare argument is `value`.
function annoArgs(inner) {
  const out = {};
  for (const part of splitTop(inner, ',')) {
    const m = /^(\w+)\s*=\s*([\s\S]+)$/.exec(part);
    const [k, v] = m && !/^"/.test(part) ? [m[1], m[2].trim()] : ['value', part];
    out[k === 'path' ? 'value' : k] = v.startsWith('{') ? splitTop(v.slice(1, v.lastIndexOf('}')), ',') : [v];
  }
  return out;
}

function stringConsts(clean) {
  const out = new Map();
  const re = /\bString\s+(\w+)\s*=\s*([^;]+);/g; let m;
  while ((m = re.exec(clean))) if (!out.has(m[1])) out.set(m[1], m[2].trim());
  return out;
}

// Evaluates "a" + CONST + Other.CONST; unresolved parts come back as {NAME} and mark the result unresolved.
async function evalString(expr, ctx, depth = 0) {
  let unresolved = false; let s = '';
  for (const part of splitTop(expr, '+')) {
    if (/^"/.test(part)) { try { s += JSON.parse(part.replace(/\\(?!["\\/bfnrtu])/g, '\\\\')); } catch { s += part.slice(1, -1); } continue; }
    const r = depth < 5 ? await resolveConst(part, ctx, depth) : null;
    if (r) { s += r.value; unresolved = unresolved || r.unresolved; } else { s += `{${part}}`; unresolved = true; }
  }
  return { value: s, unresolved };
}
async function resolveConst(name, ctx, depth) {
  const q = name.split('.'); const id = q.pop(); const cls = q.pop();
  const tryIn = async (consts, c) => (consts.has(id) ? evalString(consts.get(id), c, depth + 1) : null);
  if (!cls) {
    const r = await tryIn(ctx.consts, ctx); if (r) return r;
    for (const imp of ctx.staticImports) { const f = await classFile(imp, ctx.app); if (f) { const r2 = await tryIn(f.consts, f); if (r2) return r2; } }
    return null;
  }
  if (new RegExp(`\\b(class|interface)\\s+${cls}\\b`).test(ctx.clean)) return tryIn(ctx.consts, ctx); // own or nested class
  const f = await classFile(cls, ctx.app);
  return f ? tryIn(f.consts, f) : null;
}

let simpleIndex = null; // "Foo" -> [repo paths of Foo.java]
async function bySimpleName(name) {
  if (!simpleIndex) {
    simpleIndex = new Map();
    for (const paths of (await getJavaIndex()).values()) for (const p of paths) {
      const k = p.split('/').pop().replace(/\.java$/, ''); if (!simpleIndex.has(k)) simpleIndex.set(k, []); simpleIndex.get(k).push(p);
    }
  }
  return simpleIndex.get(name) || [];
}
const parsed = new Map(); // repo path -> parsed file (kept for the process lifetime: discovery reuses them)
async function parseFile(p, app) {
  if (parsed.has(p)) return parsed.get(p);
  const raw = (await gitFile(p)).join('\n'); const clean = stripComments(raw);
  const staticImports = [...clean.matchAll(/import\s+static\s+[\w.]*\.(\w+)\.\*\s*;/g)].map((m) => m[1]);
  const f = { path: p, app, raw, clean, lines: raw.split('\n'), consts: stringConsts(clean), staticImports };
  parsed.set(p, f); return f;
}
async function classFile(simple, app) {
  const paths = await bySimpleName(simple);
  return paths.length ? parseFile(pickPath(paths, app === 'admin' ? 'admin' : 'portal'), app) : null;
}

// Every handler mapping in one @RestController file.
async function endpointsInFile(f, prefix) {
  const { clean } = f; const out = [];
  const classIdx = clean.search(/\b(class|interface)\s+\w+/);
  const className = (/\b(?:class|interface)\s+(\w+)/.exec(clean) || [])[1] || f.path.split('/').pop();
  let classPaths = [{ value: '', unresolved: false }], classVerbs = null;
  const annoRe = new RegExp(ANNO_RE.source, 'g'); let m;
  while ((m = annoRe.exec(clean))) {
    const at = m.index; let end = annoRe.lastIndex, args = {};
    if (clean[end] === '(') { const close = matchClose(clean, end); args = annoArgs(clean.slice(end + 1, close)); end = close + 1; }
    const paths = args.value ? await Promise.all(args.value.map((e) => evalString(e, f))) : [{ value: '', unresolved: false }];
    const verbs = VERB_OF[m[1]] ? [VERB_OF[m[1]]] : args.method ? args.method.map((x) => x.replace(/.*\./, '')) : null;
    if (at < classIdx) { classPaths = paths; classVerbs = verbs; continue; }
    // the method signature runs from here to the first '{' outside parentheses
    let k = end, sigEnd = -1;
    while (k < clean.length) { const c = clean[k]; if (c === '(') { k = matchClose(clean, k) + 1; continue; } if (c === '{') { sigEnd = k; break; } if (c === ';') break; k++; }
    if (sigEnd < 0) continue;
    const sig = clean.slice(end, sigEnd); const g = lastGroup(sig); if (!g) continue;
    const nm = /(\w+)\s*$/.exec(sig.slice(0, g.open)); if (!nm) continue;
    const bodyEnd = matchClose(clean, sigEnd);
    const params = parseParams(sig.slice(g.open + 1, g.close));
    for (const cp of classPaths) for (const mp of paths) {
      const p = ('/' + [cp.value, mp.value].filter(Boolean).join('/')).replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
      out.push({ app: f.app, verbs: verbs || classVerbs || ['ANY'], path: p, fullPath: prefix + p, unresolved: cp.unresolved || mp.unresolved,
        className, methodName: nm[1], file: f.path, line: lineAt(clean, at), bodyFrom: lineAt(clean, sigEnd), bodyTo: lineAt(clean, bodyEnd), params,
        produces: (args.produces || []).join(' ') });
    }
  }
  return out;
}

// The parameter list is the last top-level (...) of a signature; annotation arguments come before it.
function lastGroup(sig) {
  let g = null;
  for (let k = 0; k < sig.length; k++) {
    const c = sig[k];
    if (c === '"') { k++; while (k < sig.length && sig[k] !== '"') { if (sig[k] === '\\') k++; k++; } continue; }
    if (c === '(') { const close = matchClose(sig, k); if (close < 0) return g; g = { open: k, close }; k = close; }
  }
  return g;
}

function parseParams(list) {
  const out = [];
  for (const p of splitTop(list, ',')) {
    const a = /@(PathVariable|RequestParam|RequestBody|RequestHeader)\b\s*(\(([^)]*)\))?/.exec(p); if (!a) continue;
    const varName = (/(\w+)\s*$/.exec(p) || [])[1]; const inner = a[3] || '';
    const named = /(?:value|name)\s*=\s*"([^"]*)"/.exec(inner) || /^\s*"([^"]*)"/.exec(inner);
    const type = p.replace(/@[\w.]+\s*(\([^)]*\))?/g, '').trim().split(/\s+/).slice(-2, -1)[0] || '';
    out.push({ kind: a[1], name: named ? named[1] : varName, type,
      required: !/required\s*=\s*false/.test(inner) && !/defaultValue\s*=/.test(inner) && !/^Optional/.test(type) });
  }
  return out;
}

// DispatcherServlet url-pattern from web.xml: "/rest/*" -> "/rest", "/" -> "".
async function dispatcherPrefix(module) {
  try {
    const xml = (await gitFile(`${module}/src/main/webapp/WEB-INF/web.xml`)).join('\n');
    const s = /<servlet>\s*[\s\S]*?<servlet-name>\s*([^<]+?)\s*<\/servlet-name>[\s\S]*?DispatcherServlet[\s\S]*?<\/servlet>/.exec(xml);
    if (!s) return { prefix: '', note: 'no DispatcherServlet in web.xml' };
    const map = new RegExp(`<servlet-mapping>\\s*<servlet-name>\\s*${s[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*</servlet-name>\\s*<url-pattern>\\s*([^<]+?)\\s*</url-pattern>`).exec(xml);
    const pat = map ? map[1] : '/';
    return { prefix: pat.startsWith('*.') ? '' : pat.replace(/\/?\*$/, '').replace(/\/$/, ''), suffix: pat.startsWith('*.') ? pat.slice(1) : '', pattern: pat };
  } catch { return { prefix: '', note: `no WEB-INF/web.xml in ${GIT_REF}` }; }
}

// Words that mean "changes data": a GET whose path or method name contains one is never called automatically.
const MUTATING = new Set(('delete remove update save insert add create cancel void refund reissue issue book hold pay approve reject reset send logout ' +
  'upload import sync generate clear flush refresh evict change activate deactivate lock unlock block unblock enable disable assign submit confirm ' +
  'execute run process notify edit modify mark revoke retry release split merge transfer topup deduct credit debit recharge set ' +
  'schedule scheduler scheduled procedure job jobs trigger initiate start stop kill restart rebuild reload recalculate migrate purge invoke fire ' +
  'otp login register password verify').split(' '));
// A POST is called only when its name says it reads (search, list, report…) and contains none of the words above.
const READING = new Set('search list filter report reports export download get find fetch view count lookup load show summary details detail history all autocomplete suggest'.split(' '));
const words = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const mutatingWord = (ep) => [...words(ep.path), ...words(ep.methodName)].find((w) => MUTATING.has(w));
const readingWord = (ep) => [...words(ep.path), ...words(ep.methodName)].find((w) => READING.has(w));

// Values nobody has to look up: date ranges and paging. Dates as yyyy-MM-dd.
function generated(name) {
  const n = name.toLowerCase(); const day = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
  if (/date|day$/.test(n)) return /from|start|begin/.test(n) ? day(-30) : /(^|[a-z])to(date)?$|todate|end|till|until/.test(n) ? day(0)
    : /journey|depart|travel|checkin|flight/.test(n) ? day(14) : /return|checkout/.test(n) ? day(21) : day(0);
  if (/^(page|offset|first)$/.test(n)) return '0';
  if (/^(pageno|pagenumber|pageindex)$/.test(n)) return '1';
  if (/^(size|pagesize|limit|perpage|length|maxresults|rows|recordsperpage)$/.test(n)) return '20';
  return undefined;
}

// Entity words for DB lookups: path segments, controller name, DTO name ("/Master2/airline/{id}" -> airline).
function hintsOf(ep, extra = []) {
  const strip = (s) => (s || '').replace(/(Controller|Service|Impl|Dto|DTO|Req|Request|Rq|Model|Bean|Vo|VO|V\d+)+$/g, '');
  const segs = ep.fullPath.split('/').filter((s) => s && !s.startsWith('{')).reverse();
  return [...new Set([...segs, ...segs.flatMap(words), ...extra.map(strip), strip(ep.className), ...words(strip(ep.className))].filter((w) => w && w.length > 2))];
}

// @RequestBody DTO -> field tree (own + superclass fields, @JsonProperty names), two levels of nested DTOs.
const SIMPLE = /^(String|Integer|int|Long|long|Double|double|Float|float|BigDecimal|BigInteger|Boolean|boolean|Short|short|Byte|byte|Character|char|Date|LocalDate|LocalDateTime|Timestamp|Object|UUID)$/;
async function dtoFields(type, app, depth = 0, seen = new Set()) {
  if (depth > 2 || seen.has(type) || SIMPLE.test(type) || /^(Map|HashMap|JsonNode|JSONObject|String)\b/.test(type)) return [];
  seen.add(type);
  const f = await classFile(type, app); if (!f) return [];
  const out = [];
  const sup = /\bclass\s+\w+(?:<[^>{]*>)?\s+extends\s+(\w+)/.exec(f.clean); if (sup) out.push(...await dtoFields(sup[1], app, depth, seen));
  const re = /(?:@JsonProperty\s*\(\s*(?:value\s*=\s*)?"([^"]+)"[^)]*\)\s*)?(?:@[\w.]+(?:\([^)]*\))?\s*)*\b(?:private|protected|public)\s+(?!static\b)(?:final\s+)?([\w.]+(?:\s*<[^;=]*?>)?(?:\[\])?)\s+(\w+)\s*(?:=[^;]*)?;/g; let m;
  while ((m = re.exec(f.clean))) {
    const t = m[2].replace(/\s+/g, ''); const name = m[1] || m[3];
    if (/^(List|Set|Collection|ArrayList|HashSet)\b|\[\]$/.test(t)) continue; // lists stay empty: no filter
    const base = t.replace(/<.*$/, '').split('.').pop();
    if (SIMPLE.test(base)) out.push({ name, type: base });
    else if (/^[A-Z]/.test(base) && !/^(Map|HashMap|Optional|Enum)$/.test(base)) { const kids = await dtoFields(base, app, depth + 1, seen); if (kids.length) out.push({ name, type: base, kids }); }
  }
  return out;
}
function bodyFrom(fields, val) {
  const o = {};
  for (const fl of fields) {
    if (fl.kids) { const k = bodyFrom(fl.kids, val); if (Object.keys(k).length) o[fl.name] = k; continue; }
    const v = val(fl.name); if (v === undefined) continue; // unknown values are left out: no filter
    o[fl.name] = /^(Integer|int|Long|long|Short|short|Byte|byte|Double|double|Float|float|BigDecimal|BigInteger)$/.test(fl.type) && v !== '' && !Number.isNaN(Number(v)) ? Number(v)
      : /^(Boolean|boolean)$/.test(fl.type) ? /^(1|true|y|yes)$/i.test(v) : v;
  }
  return o;
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(PERF_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error(`${path.basename(PERF_FILE)}: ${e.message}`); }
}

let discovered = null, lastDbNeeds = [];
async function discover(force) {
  if (discovered && !force) return discovered;
  const cfg = loadConfig(); const defaults = cfg.params || {};
  const apps = [];
  for (const app of APPS) {
    const out = await git(['grep', '-l', '-E', '@RestController', GIT_REF, '--', `${app.module}/src/main/java`]).catch((e) => (e.code === 1 ? '' : Promise.reject(e)));
    const files = out.split('\n').map((l) => l.trim().replace(`${GIT_REF}:`, '')).filter(Boolean);
    const disp = await dispatcherPrefix(app.module);
    apps.push({ key: app.key, module: app.module, baseUrl: app.baseUrl, local: isLocal(app.baseUrl), ...disp, files });
  }
  const all = [];
  for (const a of apps) for (const p of a.files) {
    const f = await parseFile(p, a.key);
    all.push(...(await endpointsInFile(f, a.prefix)).map((e) => ({ ...e, suffix: a.suffix || '' })));
  }
  // Per endpoint and name: value typed on the page > value from the DB > generated (dates, paging).
  const db = perfdb.state(); const dbNeeds = new Map();
  const valueFor = (n, hints) => {
    if (defaults[n] !== undefined) return { v: String(defaults[n]), src: 'manual' };
    const col = db.columns ? perfdb.resolveColumn(n, hints) : null;
    if (col) { const v = perfdb.valueOf(col); if (v === undefined) dbNeeds.set(perfdb.keyOf(col), col); else if (v !== null) return { v, src: 'db', col: perfdb.keyOf(col) }; }
    const g = generated(n); return g === undefined ? undefined : { v: g, src: 'generated' };
  };
  const seen = new Map(); const endpoints = [];
  for (const e of all) for (const verb of e.verbs) {
    let id = `${e.app} ${verb} ${e.fullPath}`; const n = (seen.get(id) || 0) + 1; seen.set(id, n); if (n > 1) id += ` #${n}`;
    const ep = { id, ...e, verb, source: 'code' }; delete ep.verbs;
    const bodyType = (ep.params.find((p) => p.kind === 'RequestBody') || {}).type;
    const hints = hintsOf(ep, bodyType ? [bodyType] : []);
    const names = [...[...ep.fullPath.matchAll(/\{(\w+)[^}]*\}/g)].map((m) => m[1]), ...ep.params.filter((p) => p.kind === 'RequestParam' && p.required).map((p) => p.name)];
    ep.values = {}; for (const nm of names) { const v = valueFor(nm, hints); if (v) ep.values[nm] = v; }
    ep.status = classify(ep, Object.fromEntries(Object.entries(ep.values).map(([k, x]) => [k, x.v])));
    if (ep.status.run && ep.verb === 'POST' && bodyType) {
      const fields = await dtoFields(bodyType.replace(/<.*$/, ''), ep.app).catch(() => []);
      const bodyVals = {};
      ep.body = bodyFrom(fields, (nm) => { const v = valueFor(nm, hints); if (v) bodyVals[nm] = v; return v && v.v; });
      ep.bodyType = bodyType; ep.bodyValues = bodyVals;
    }
    endpoints.push(ep);
  }
  for (const [i, c] of (cfg.endpoints || []).entries()) {
    const app = c.app || 'portal', verb = (c.method || 'GET').toUpperCase();
    const a = apps.find((x) => x.key === app);
    const full = (a ? a.prefix : '') + c.path;
    const match = endpoints.find((e) => e.app === app && (e.verb === verb || e.verb === 'ANY') && pathRegex(e.fullPath).test(full));
    endpoints.push({ id: `curated ${i + 1} ${app} ${verb} ${c.path}`, name: c.name, app, verb, path: c.path, fullPath: full, suffix: a ? a.suffix || '' : '',
      query: c.query, body: c.body, headers: c.headers, source: 'curated', status: { run: true, why: 'listed in ' + path.basename(PERF_FILE) },
      ...(match ? { className: match.className, methodName: match.methodName, file: match.file, line: match.line, bodyFrom: match.bodyFrom, bodyTo: match.bodyTo } : {}) });
  }
  discovered = { at: new Date().toISOString(), ref: GIT_REF, apps: apps.map(({ files, ...a }) => ({ ...a, controllers: files.length })),
    login: Object.fromEntries(APPS.map((a) => [a.key, !!(cfg.login && cfg.login[a.key])])), configFile: PERF_FILE, configFound: fs.existsSync(PERF_FILE), params: defaults, db: { ...db, missing: dbNeeds.size },
    allowRemote: ALLOW_REMOTE, endpoints };
  lastDbNeeds = [...dbNeeds.values()];
  return discovered;
}
const pathRegex = (p) => new RegExp('^' + p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$');

// Can this endpoint be called automatically? Returns { run, why, missing }.
function classify(ep, defaults) {
  if (ep.unresolved) return { run: false, why: 'path uses a constant that could not be resolved' };
  const w = mutatingWord(ep);
  const readPost = ep.verb === 'POST' && !w && readingWord(ep);
  if (ep.verb !== 'GET' && ep.verb !== 'ANY' && !readPost) return { run: false, why: `${ep.verb} changes data – add it to perf.endpoints.json with a test body` };
  if (w) return { run: false, why: `name contains "${w}" – may change data` };
  if (!readPost && ep.params.some((p) => p.kind === 'RequestBody')) return { run: false, why: 'needs a request body' };
  const missing = [...[...ep.fullPath.matchAll(/\{(\w+)[^}]*\}/g)].map((m) => m[1]), ...ep.params.filter((p) => p.kind === 'RequestParam' && p.required).map((p) => p.name)]
    .filter((n, i, a) => a.indexOf(n) === i && defaults[n] === undefined);
  if (missing.length) return { run: false, why: 'needs values for ' + missing.join(', '), missing };
  return { run: true, why: readPost ? `read-only POST ("${readingWord(ep)}") – body built from the DTO` : ep.verb === 'ANY' ? 'mapping accepts any method; called with GET' : 'read-only GET' };
}

// ---------------- Runner ----------------
const subst = (v) => (typeof v === 'string' ? v.replace(/\$\{(PERF_[A-Z0-9_]+)\}/g, (_, k) => process.env[k] || '')
  : Array.isArray(v) ? v.map(subst) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)])) : v);
const getPath = (o, p) => p.split('.').reduce((x, k) => (x == null ? x : x[k]), o);

function buildUrl(ep, app, defaults) {
  let p = ep.fullPath.replace(/\{(\w+)[^}]*\}/g, (_, n) => encodeURIComponent(defaults[n] ?? ''));
  const qs = new URLSearchParams();
  for (const prm of ep.params || []) if (prm.kind === 'RequestParam' && prm.required && defaults[prm.name] !== undefined) qs.set(prm.name, defaults[prm.name]);
  for (const [k, v] of Object.entries(ep.query || {})) qs.set(k, v);
  return app.baseUrl + p + (ep.suffix || '') + (qs.toString() ? '?' + qs : '');
}

function largestArray(j, depth = 0) {
  if (Array.isArray(j)) return j.length;
  if (!j || typeof j !== 'object' || depth > 3) return 0;
  return Math.max(0, ...Object.values(j).map((v) => largestArray(v, depth + 1)));
}

class Session {
  constructor(app) { this.app = app; this.cookies = new Map(); this.headers = {}; }
  store(res) { for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) { const [kv] = c.split(';'); const i = kv.indexOf('='); if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim()); } }
  async call(method, url, body, extra, timeoutMs) {
    const headers = { Accept: 'application/json, */*', 'Accept-Encoding': 'gzip, deflate', ...this.headers, ...extra };
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    const t0 = performance.now();
    const res = await fetch(url, { method, headers, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const ttfb = performance.now() - t0;
    const buf = Buffer.from(await res.arrayBuffer()); const total = performance.now() - t0;
    this.store(res);
    return { status: res.status, ttfb, total, bytes: buf.length, encoding: res.headers.get('content-encoding') || '', type: res.headers.get('content-type') || '', location: res.headers.get('location') || '', buf };
  }
}

async function login(sess, cfg, timeoutMs) {
  if (!cfg) return { configured: false };
  const unset = [...new Set([...JSON.stringify(cfg).matchAll(/\$\{(PERF_[A-Z0-9_]+)\}/g)].map((m) => m[1]).filter((k) => !process.env[k]))];
  if (unset.length) return { configured: true, ok: false, error: `${unset.join(', ')} not set (start.ps1 -Perf asks for it)` };
  // "form": true posts the body as an HTML form (classic login actions); otherwise it is sent as JSON.
  const body = cfg.body === undefined ? undefined : cfg.form ? new URLSearchParams(subst(cfg.body)).toString() : subst(cfg.body);
  const headers = { ...(cfg.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...subst(cfg.headers || {}) };
  const t = await sess.call((cfg.method || 'POST').toUpperCase(), sess.app.baseUrl + (cfg.path || ''), body, headers, timeoutMs);
  let token = null;
  if (cfg.token) { try { token = getPath(JSON.parse(t.buf.toString('utf8')), cfg.token); } catch { /* not JSON */ } }
  if (token) sess.headers[cfg.header || 'Authorization'] = (cfg.prefix ?? 'Bearer ') + token;
  // Form logins usually answer 200/302 either way: "failIf" (regex) on the redirect target or page text marks a failed login.
  const hit = cfg.failIf && new RegExp(`.{0,40}(?:${cfg.failIf}).{0,40}`, 'i').exec(`${t.location}\n${t.buf.toString('utf8', 0, 20000)}`);
  const failed = !!hit;
  const ok = t.status < 400 && (!cfg.token || !!token) && !failed;
  return { configured: true, ok, status: t.status, ms: Math.round(t.total), location: t.location || undefined,
    error: ok ? null : failed ? `login rejected, HTTP ${t.status}: "${hit[0].trim()}"${t.location ? ' (redirected to ' + t.location + ')' : ''}` : cfg.token && !token ? `no token at "${cfg.token}" in the login response` : `HTTP ${t.status}` };
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)]; };

async function measure(ep, sess, defaults, opts) {
  const url = buildUrl(ep, sess.app, ep.values ? Object.fromEntries(Object.entries(ep.values).map(([k, x]) => [k, x.v])) : defaults);
  const body = ep.body === undefined ? undefined : subst(ep.body);
  const runs = []; let last = null, error = null, cold = null;
  for (let k = 0; k <= opts.iterations; k++) {
    try {
      const r = await sess.call(ep.verb === 'ANY' ? 'GET' : ep.verb, url, body, subst(ep.headers || {}), opts.timeoutMs);
      if (k === 0) cold = r.total; else runs.push(r);
      last = r;
      if (r.status >= 500 || r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) break; // errors: don't hammer
    } catch (e) { error = e.name === 'TimeoutError' ? `timed out after ${opts.timeoutMs / 1000}s` : (e.cause && e.cause.code) || e.message; if (k === 0) cold = null; break; }
    if (opts.stopped()) break;
  }
  const times = runs.map((r) => r.total); const all = cold != null ? [cold, ...times] : times;
  let items = 0;
  if (last && /json/.test(last.type) && last.bytes < 30e6) { try { items = largestArray(JSON.parse(last.buf.toString('utf8'))); } catch { /* not JSON */ } }
  const res = { id: ep.id, url: url.replace(sess.app.baseUrl, ''), at: new Date().toISOString(), error,
    sent: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 2000),
    status: last ? last.status : null, location: last && last.location ? last.location : undefined,
    cold: cold != null ? Math.round(cold) : null, runs: times.map(Math.round),
    median: times.length ? Math.round(median(times)) : all.length ? Math.round(all[0]) : null,
    p95: times.length ? Math.round(pct(times, 95)) : null, min: all.length ? Math.round(Math.min(...all)) : null, max: all.length ? Math.round(Math.max(...all)) : null,
    ttfb: runs.length ? Math.round(median(runs.map((r) => r.ttfb))) : last ? Math.round(last.ttfb) : null,
    bytes: last ? last.bytes : null, encoding: last ? last.encoding : null, type: last ? last.type.split(';')[0] : null, items };
  return res;
}

let job = null;
async function startRun({ ids, iterations, concurrency, timeoutSec }) {
  if (job && job.state === 'running') { const e = new Error('A run is already in progress'); e.status = 409; throw e; }
  const d = await discover(); const cfg = loadConfig(); const defaults = cfg.params || {};
  const byId = new Map(d.endpoints.map((e) => [e.id, e]));
  const eps = [...new Set(ids || [])].map((id) => byId.get(id)).filter((e) => e && e.status.run); // only server-known, runnable endpoints
  if (!eps.length) { const e = new Error('No runnable endpoints selected'); e.status = 400; throw e; }
  for (const a of APPS) if (eps.some((e) => e.app === a.key) && !isLocal(a.baseUrl) && !ALLOW_REMOTE) {
    const e = new Error(`${a.baseUrl} is not a local address. The performance page only calls a local WildFly (set PERF_ALLOW_REMOTE=1 to override).`); e.status = 400; throw e;
  }
  const opts = { iterations: Math.min(10, Math.max(1, Number(iterations) || 3)), timeoutMs: Math.min(300, Math.max(5, Number(timeoutSec) || 60)) * 1000 };
  const conc = Math.min(4, Math.max(1, Number(concurrency) || 1));
  job = { id: Date.now().toString(36), state: 'running', started: new Date().toISOString(), total: eps.length, done: 0, results: [], logins: {}, opts: { ...opts, concurrency: conc }, stop: false };
  const j = job; opts.stopped = () => j.stop;
  (async () => {
    const sessions = {};
    for (const a of APPS) if (eps.some((e) => e.app === a.key)) {
      sessions[a.key] = new Session(a);
      try { j.logins[a.key] = await login(sessions[a.key], cfg.login && cfg.login[a.key], opts.timeoutMs); }
      catch (e) { j.logins[a.key] = { configured: true, ok: false, error: (e.cause && e.cause.code) || e.message }; }
    }
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(conc, eps.length) }, async () => {
      while (i < eps.length && !j.stop) { const ep = eps[i++]; const r = await measure(ep, sessions[ep.app], defaults, opts); j.results.push(r); j.done++; }
    }));
    j.state = j.stop ? 'stopped' : 'done'; j.finished = new Date().toISOString();
    const summary = { ...j, ref: d.ref }; delete summary.stop;
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULTS_DIR, 'last.json'), JSON.stringify(summary));
    console.log(`[perf] run ${j.id} ${j.state}: ${j.done}/${j.total} endpoints`);
  })().catch((e) => { j.state = 'error'; j.error = e.message; console.error(`[perf] ${e.message}`); });
  return status();
}
function stopRun() { if (job && job.state === 'running') job.stop = true; return status(); }
function status() { if (!job) return { state: 'idle' }; const { stop, ...s } = job; return s; }

function savedRun(name) {
  try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${name}.json`), 'utf8')); } catch { return null; }
}
function saveBaseline() {
  const last = savedRun('last'); if (!last) { const e = new Error('No finished run to save'); e.status = 400; throw e; }
  fs.writeFileSync(path.join(RESULTS_DIR, 'baseline.json'), JSON.stringify(last)); return { ok: true, at: last.finished };
}

// Sample values from the local DB: read the schema, then one value per column that some endpoint needs.
async function fillFromDb() {
  const columns = await perfdb.loadSchema();
  await discover(true);
  const r = await perfdb.fetchValues(lastDbNeeds);
  const d = await discover(true);
  console.log(`[perf] DB values: ${columns} columns, ${r.looked} looked up, ${r.failed} failed`);
  return { ...d, fill: { columns, ...r } };
}

// Sample values from the page: merged into "params" of perf.endpoints.json (an empty value removes the name).
function saveParams(params) {
  if (!params || typeof params !== 'object') { const e = new Error('params object required'); e.status = 400; throw e; }
  const cfg = loadConfig(); cfg.params = { ...(cfg.params || {}) };
  for (const [k, v] of Object.entries(params)) {
    if (!/^\w{1,80}$/.test(k)) { const e = new Error(`Bad parameter name: ${k}`); e.status = 400; throw e; }
    const s = String(v ?? '').trim().slice(0, 500);
    if (s) cfg.params[k] = s; else delete cfg.params[k];
  }
  fs.writeFileSync(PERF_FILE, JSON.stringify(cfg, null, 2) + '\n');
  return discover(true);
}

// ---------------- Suggestions ----------------
// Measured: from the timings and the response. Code: patterns in the handler and the service/DAO methods it calls
// (heuristics, two levels deep; they point at likely causes, they do not prove them).
function measuredFindings(r, th) {
  const out = []; const f = (sev, rule, title, detail) => out.push({ sev, rule, title, detail, kind: 'measured' });
  if (r.error) { f('critical', 'error', 'Request failed', `${r.error}. Fix the failure before measuring speed.`); return out; }
  if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) {
    f('warning', 'auth', `HTTP ${r.status} – not logged in`, `The time is for the ${r.status >= 300 && r.status < 400 ? 'redirect' + (r.location ? ' to ' + r.location : '') : 'rejection'}, not the real work. Configure "login" for this app in perf.endpoints.json.`);
    return out;
  }
  if (r.status >= 500) f('critical', 'error', `HTTP ${r.status}`, 'Server error: the time is not meaningful until the error is fixed (check the WildFly log).');
  else if (r.status >= 400) f('warning', 'error', `HTTP ${r.status}`, 'Client error: the sample values in perf.endpoints.json are probably wrong.');
  if (r.median >= th.crit) f('critical', 'slow', `Slow: ${(r.median / 1000).toFixed(1)} s typical`, `Over the ${th.crit / 1000} s limit on every warm call.`);
  else if (r.median >= th.warn) f('warning', 'slow', `${(r.median / 1000).toFixed(1)} s typical`, `Over the ${th.warn / 1000} s target.`);
  if (r.cold != null && r.median != null && r.cold > 1000 && r.cold > 3 * r.median)
    f('warning', 'cold', `First call ${(r.cold / 1000).toFixed(1)} s, then ${(r.median / 1000).toFixed(1)} s`, 'Something is built on first use (cache fill, JAXB/Hibernate init, connection pool). Warm it at startup (e.g. a @PostConstruct or ApplicationListener<ContextRefreshedEvent>) so the first user does not pay for it.');
  if (r.runs.length >= 3 && r.max > 2 * r.min && r.max - r.min > 500)
    f('info', 'variance', `Unstable: ${(r.min / 1000).toFixed(1)}–${(r.max / 1000).toFixed(1)} s`, 'Large spread between identical calls: look for lock contention (synchronized), a small DB/HTTP connection pool, GC pauses or an external supplier call.');
  if (r.bytes > 1e6) f('warning', 'payload', `Large response: ${(r.bytes / 1e6).toFixed(1)} MB`, 'Return only the fields the screen uses (a slim DTO instead of the entity) and page the list.');
  if (r.bytes > 50e3 && !r.encoding) f('info', 'gzip', `Not compressed (${Math.round(r.bytes / 1024)} KB)`, 'The response has no Content-Encoding. Make sure the GzipFilter covers this URL pattern in web.xml.');
  if (r.items > 500) f('warning', 'paging', `Returns ${r.items.toLocaleString()} rows at once`, 'Add paging (page/size + setFirstResult/setMaxResults) or a search filter; the browser rarely shows all of them.');
  if (r.median >= th.warn && r.ttfb != null && r.median - r.ttfb > 0.3 * r.median && r.median - r.ttfb > 300)
    f('info', 'transfer', `${Math.round((r.median - r.ttfb) / 1000 * 10) / 10} s spent sending the body`, 'Most of the time is after the first byte: response size / serialization, not the query.');
  return out;
}

const CODE_RULES = [
  { rule: 'jaxb', sev: 'critical', re: /JAXBContext\.newInstance\s*\(/, title: 'JAXBContext created per request',
    fix: 'JAXBContext.newInstance takes 100 ms–seconds. Create it once (static final or a Spring bean) and reuse it; create Marshaller/Unmarshaller per call (they are cheap but not thread-safe).' },
  { rule: 'mapper', sev: 'warning', re: /new\s+(ObjectMapper|Gson|GsonBuilder|XmlMapper)\s*\(|(DocumentBuilderFactory|XMLInputFactory|TransformerFactory|SAXParserFactory)\.newInstance\s*\(/, title: 'Expensive (de)serializer created per call',
    fix: 'ObjectMapper and Gson are thread-safe: keep one static instance. Factories (DocumentBuilderFactory etc.) should also be created once.' },
  { rule: 'sleep', sev: 'critical', re: /Thread\.sleep\s*\(/, title: 'Thread.sleep on the request path', fix: 'The request waits on purpose. Remove it, or poll asynchronously instead of blocking the request thread.' },
  { rule: 'unpaged', sev: 'warning', re: /\b(findAll|getAll\w*|loadAll)\s*\(|\.list\s*\(\s*\)/, unless: /setMaxResults|setFirstResult|Pageable|PageRequest|\blimit\b/i, title: 'Loads a whole table / list without paging',
    fix: 'Page in the query (Criteria/Query setFirstResult + setMaxResults) or filter in SQL instead of loading everything and filtering in Java.' },
  { rule: 'count', sev: 'warning', re: /(findAll|getAll\w*|list)\s*\([^)]*\)\s*\.size\s*\(\s*\)/, title: 'Loads rows only to count them', fix: 'Use a select count(*) query.' },
  { rule: 'logpayload', sev: 'info', re: /\b(log|logger|LOG|LOGGER)\.(info|warn)\s*\([^;]*(writeValueAsString|toJson|marshal|toString\(\))/, title: 'Serializes a payload for logging at INFO',
    fix: 'Large payloads converted to strings on every call cost CPU and I/O. Log at DEBUG behind isDebugEnabled(), or log IDs only.' },
  { rule: 'sync', sev: 'info', re: /\bsynchronized\b/, title: 'synchronized on the request path', fix: 'Concurrent users queue up here. Narrow the lock or use concurrent collections.' },
];
const DB_CALL = /\b(\w*(?:[Dd]ao|DAO|Repository|Repo)\w*|hibernateTemplate|jdbcTemplate|entityManager)\s*\.\s*(\w+)\s*\(|\b(session|getSession\(\)|getCurrentSession\(\))\s*\.\s*(createQuery|createCriteria|createSQLQuery|createNativeQuery|getNamedQuery|get|load|find)\s*\(/;
const EXT_CALL = /\b(restTemplate|RestTemplate|HttpURLConnection|httpClient|HttpClient|WebServiceTemplate|\w*Stub|\w*[Cc]lient)\s*\.\s*(\w+)\s*\(|\.(exchange|postForObject|getForObject|postForEntity|marshalSendAndReceive|sendAndReceive)\s*\(/;
const SVC_CALL = /\b(\w*(?:[Ss]ervice|Manager|Helper|Facade)\w*)\s*\.\s*(\w+)\s*\(/;
const CACHE_USE = /@Cacheable|CacheService|[Cc]ache\w*\.(get|put)|redis|Redis|cacheManager/;

// Method body lines [from..to] of `name` in a parsed file (first overload that has a body).
function methodRange(f, name) {
  const re = new RegExp(`^[ \\t]*(?:(?:public|protected|private|static|final|synchronized|abstract)\\s+)*[\\w<>\\[\\],.? ]+?\\s+${name}\\s*\\(`, 'gm'); let m;
  while ((m = re.exec(f.clean))) {
    const open = f.clean.indexOf('(', m.index + m[0].length - 1); const close = matchClose(f.clean, open); if (close < 0) continue;
    const after = f.clean.slice(close + 1).match(/^\s*(throws[\w\s.,]+)?\s*([{;])/); if (!after || after[2] !== '{') continue;
    const bo = close + 1 + after[0].length - 1; const bc = matchClose(f.clean, bo);
    return { from: lineAt(f.clean, m.index), to: lineAt(f.clean, bc), synchronized: /\bsynchronized\b/.test(m[0]) };
  }
  return null;
}
// Field name -> declared type, e.g. "airlineService" -> "AirlineService".
function fieldTypes(f) {
  const out = new Map(); const re = /(?:private|protected|public)\s+(?:final\s+)?(\w+)(?:<[^;=()]*>)?\s+(\w+)\s*(?:=[^;]*)?;/g; let m;
  while ((m = re.exec(f.clean))) out.set(m[2], m[1]);
  return out;
}
async function implFile(type, app) {
  const impl = await classFile(type + 'Impl', app); if (impl) return impl;
  return classFile(type, app);
}

// Loops: [fromLine, toLine] of every for/while/forEach block in the given lines.
function loops(clean, fromLine, toLine) {
  const starts = []; let idx = 0; for (let l = 1; l < fromLine; l++) idx = clean.indexOf('\n', idx) + 1;
  const endIdx = (() => { let k = idx; for (let l = fromLine; l <= toLine; l++) k = clean.indexOf('\n', k) + 1 || clean.length; return k; })();
  const seg = clean.slice(idx, endIdx); const re = /\b(for|while)\s*\(|\.forEach\s*\(|\.stream\(\)\s*\.\s*(map|forEach|filter)\s*\(/g; let m;
  while ((m = re.exec(seg))) {
    const at = idx + m.index; const p = clean.indexOf('(', at + m[0].length - 1); const pc = matchClose(clean, p); if (pc < 0) continue;
    let blockEnd = pc;
    if (/^(for|while)/.test(m[0])) { const b = clean.slice(pc + 1).search(/\S/); if (clean[pc + 1 + b] === '{') blockEnd = matchClose(clean, pc + 1 + b); else blockEnd = clean.indexOf(';', pc); }
    starts.push([lineAt(clean, at), lineAt(clean, blockEnd), /^(for|while)/.test(m[0])]);
  }
  return starts;
}

async function analyzeMethod(f, range, label, depth, seen, out) {
  const key = `${f.path}:${range.from}`; if (seen.has(key) || seen.size > 25) return; seen.add(key);
  const lines = f.clean.split('\n'); const ls = loops(f.clean, range.from, range.to);
  const inLoop = (n) => ls.some(([a, b, header]) => (header ? n > a : n >= a) && n <= b); // a for/while header runs once; a lambda line repeats
  const where = (n) => ({ path: f.path, line: n, code: (f.lines[n - 1] || '').trim(), method: label });
  const body = lines.slice(range.from - 1, range.to).join('\n');
  if (range.synchronized) out.push({ ...CODE_RULES.find((r) => r.rule === 'sync'), where: where(range.from) });
  const calls = { db: [], ext: [], svc: [] };
  for (let n = range.from; n <= range.to; n++) {
    const l = lines[n - 1] || '';
    for (const r of CODE_RULES) if (r.re.test(l) && !(r.unless && r.unless.test(body))) out.push({ ...r, where: where(n) });
    const db = DB_CALL.exec(l), ext = EXT_CALL.exec(l), svc = SVC_CALL.exec(l);
    if (db) { calls.db.push(n); if (inLoop(n)) out.push({ rule: 'n+1', sev: 'critical', title: 'Database call inside a loop (N+1)', where: where(n),
      fix: 'One query per item. Load all items in one query (where id in (:ids), or join fetch) before the loop and look them up in a Map.' }); }
    if (ext) { calls.ext.push(n); if (inLoop(n)) out.push({ rule: 'ext-loop', sev: 'critical', title: 'External/supplier call inside a loop', where: where(n),
      fix: 'Calls run one after another. Send them in parallel (CompletableFuture.supplyAsync with a bounded executor) or use a batch API, with a timeout per call.' }); }
    if (svc && !db && !ext) calls.svc.push([n, svc[1], svc[2]]);
  }
  const extOutsideLoop = calls.ext.filter((n) => !inLoop(n));
  if (extOutsideLoop.length >= 2) out.push({ rule: 'ext-seq', sev: 'warning', title: `${extOutsideLoop.length} external calls one after another`, where: where(extOutsideLoop[0]),
    fix: 'If the calls do not depend on each other, start them together (CompletableFuture.allOf) so the wait is the slowest call, not the sum.' });
  if (calls.db.length && !CACHE_USE.test(body) && depth > 0 && /^(get|find|load|fetch|list|search)/i.test(label.split('.').pop()))
    out.push({ rule: 'cache', sev: 'info', title: 'Reads from the database with no cache', where: where(calls.db[0]),
      fix: 'If this is reference data (airlines, airports, currencies, settings), serve it from a cache (the repo already has *CacheService classes and Redis) and evict on change.' });
  if (depth >= 2) return;
  const fields = fieldTypes(f);
  for (const [n, obj, meth] of calls.svc) {
    const type = fields.get(obj); if (!type) continue;
    const target = await implFile(type, f.app); if (!target) continue;
    const r = methodRange(target, meth); if (!r) continue;
    const before = out.length;
    await analyzeMethod(target, r, `${type.replace(/Impl$/, '')}.${meth}`, depth + 1, seen, out);
    for (let k = before; k < out.length; k++) if (!out[k].via) out[k].via = { path: f.path, line: n, method: label };
    if (inLoop(n)) out.push({ rule: 'svc-loop', sev: 'warning', title: `${type}.${meth}() called inside a loop`, where: where(n),
      fix: 'Each iteration repeats the service call (and its queries). Add a batch method that takes the whole list.' });
  }
}

const analysisCache = new Map();
async function analyze(id) {
  const d = await discover(); const ep = d.endpoints.find((e) => e.id === id);
  if (!ep) { const e = new Error('Unknown endpoint'); e.status = 404; throw e; }
  if (!ep.file) return { findings: [], note: 'No source mapping found for this endpoint.' };
  if (analysisCache.has(id)) return analysisCache.get(id);
  const f = await parseFile(ep.file, ep.app); const out = [];
  await analyzeMethod(f, { from: ep.bodyFrom, to: ep.bodyTo }, `${ep.className}.${ep.methodName}`, 0, new Set(), out);
  const uniq = new Map(); for (const x of out) { const k = `${x.rule}|${x.where.path}|${x.where.line}`; if (!uniq.has(k)) uniq.set(k, { ...x, kind: 'code', re: undefined, unless: undefined }); }
  const sevRank = { critical: 0, warning: 1, info: 2 };
  const res = { ref: GIT_REF, handler: { path: ep.file, line: ep.line, from: ep.bodyFrom, to: ep.bodyTo, lines: f.lines.slice(ep.line - 1, Math.min(ep.bodyTo, ep.line + 60)), localFile: path.join(REPO_DIR, ep.file).replace(/\\/g, '/') },
    findings: [...uniq.values()].sort((a, b) => sevRank[a.sev] - sevRank[b.sev]) };
  analysisCache.set(id, res); return res;
}

// Results with measured findings, plus code findings for the slow ones (so the summary can rank fixes).
async function report(name, th) {
  const run = name === 'current' ? (job ? status() : savedRun('last')) : savedRun(name);
  if (!run) return { run: null };
  const d = await discover(); const byId = new Map(d.endpoints.map((e) => [e.id, e]));
  const rows = run.results.map((r) => ({ ...r, findings: measuredFindings(r, th) }));
  if (run.state !== 'running') {
    const slow = rows.filter((r) => r.median >= th.warn && !r.error && r.status < 300).sort((a, b) => b.median - a.median).slice(0, 60);
    for (const r of slow) if (byId.has(r.id)) { try { r.findings.push(...(await analyze(r.id)).findings); } catch (e) { r.analyzeError = e.message; } }
  }
  const base = savedRun('baseline'); const baseBy = base ? new Map(base.results.map((r) => [r.id, r])) : null;
  if (baseBy) for (const r of rows) { const b = baseBy.get(r.id); if (b && b.median != null) r.baseline = b.median; }
  return { run: { ...run, results: undefined }, baselineAt: base ? base.finished : null, rows };
}

module.exports = { APPS, baseUrl, isLocal, discover, startRun, stopRun, status, saveBaseline, saveParams, fillFromDb, generated, hintsOf, bodyFrom, analyze, report, measuredFindings, Session, login,
  stripComments, matchClose, splitTop, endpointsInFile, parseParams, classify, mutatingWord, pathRegex, buildUrl, largestArray, loops };
