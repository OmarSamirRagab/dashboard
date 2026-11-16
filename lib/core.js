// Shared: OpenSearch access + query helpers, git/source-code access, stack-frame helpers.
'use strict';


const fs = require('fs');
const path = require('path');

const OSD_URL = process.env.OSD_URL || 'https://ndc-logs.northeurope.cloudapp.azure.com:18521';
const TENANT = process.env.OSD_TENANT || 'ndc-core';
const INDEX = process.env.OSD_INDEX || 'ndc-core-backend-log';
const INDEX_PATTERN_ID = process.env.OSD_INDEX_PATTERN_ID || '646c81c0-acca-11f1-8b96-41792e8aaa83';
const PORT = Number(process.env.NDC_PORT || 8787);
const { OSD_USER, OSD_PASS } = process.env;
if (!OSD_USER || !OSD_PASS) {
  console.error('Set OSD_USER and OSD_PASS environment variables.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${OSD_USER}:${OSD_PASS}`).toString('base64');

const M = (s) => 'attributes.message.' + s;
const C = (s) => 'attributes.message.context.' + s;
const BIG_FIELDS = [C('request'), C('response'), C('returnValue'), 'body'];
const BOOK_ACTIONS = ['Hold', 'Book', 'BookAfterHold'];
const PAY_SERVICES = ['BanqueMisr', 'TripLink'];
const PAY_METHODS = ['bookAndPay', 'processMakePayment', 'getsessionid', 'getTransactionStatus'];

async function search(body) {
  const res = await fetch(`${OSD_URL}/internal/search/opensearch`, {
    method: 'POST',
    headers: { Authorization: AUTH, 'osd-xsrf': 'true', securitytenant: TENANT, 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: { index: INDEX, body } }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.rawResponse) {
    const msg = (json && (json.message || (json.error && json.error.reason))) || `HTTP ${res.status}`;
    throw new Error(`OpenSearch: ${msg}`);
  }
  return json.rawResponse;
}

const range = (from, to) => ({ range: { '@timestamp': { gte: from || 'now-24h', lte: to || 'now' } } });

const termsAgg = (field, size = 5) => ({ terms: { field, size } });

const anyOf = (...qs) => ({ bool: { minimum_should_match: 1, should: qs } });

// ---------------- Exceptions: explanation + code location ----------------
const { explain } = require('../rules');
const { execFile } = require('child_process');
const REPO_DIR = process.env.REPO_DIR || 'D:\\odeysys';
const GIT_REF = process.env.GIT_REF || 'origin/master';
const git = (args) => new Promise((resolve, reject) =>
  execFile('git', ['-C', REPO_DIR, ...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (e, out) => (e ? reject(e) : resolve(out))));

let javaIndex = null; // "com/tt/x/Y.java" -> [repo paths]
async function getJavaIndex() {
  if (javaIndex) return javaIndex;
  const out = await git(['ls-tree', '-r', '--name-only', GIT_REF]);
  javaIndex = new Map();
  for (const p of out.split('\n')) {
    const m = /src\/main\/java\/(.+\.java)$/.exec(p);
    if (m) { const k = m[1]; if (!javaIndex.has(k)) javaIndex.set(k, []); javaIndex.get(k).push(p); }
  }
  return javaIndex;
}
const fileCache = new Map();
async function gitFile(p) {
  if (!fileCache.has(p)) { if (fileCache.size > 60) fileCache.delete(fileCache.keys().next().value); fileCache.set(p, git(['show', `${GIT_REF}:${p}`]).then((s) => s.split(/\r?\n/))); }
  return fileCache.get(p);
}
// Prefer the module of the WAR that logged the error; never the undeployed odeysysrest-tt unless it is the only one.
function pickPath(paths, host) {
  const war = /admin/i.test(host || '') ? 'odeysysadmin-tt/' : 'odeysysportal-tt/';
  const rank = (p) => (p.startsWith(war) ? 0 : p.startsWith('common-odeysys/') ? 1 : p.startsWith('ttesb-tt/') ? 2 : p.startsWith('odeysysrest-tt/') ? 9 : 5);
  return [...paths].sort((a, b) => rank(a) - rank(b))[0];
}
async function codeFor(frame, host, around = 7) {
  if (!frame || !frame.className || !frame.fileName || frame.lineNumber < 1) return null;
  const pkg = frame.className.replace(/\$.*$/, '').split('.').slice(0, -1).join('/');
  const paths = (await getJavaIndex()).get(`${pkg}/${frame.fileName}`);
  if (!paths) return { missing: true, ref: GIT_REF };
  const p = pickPath(paths, host);
  const lines = await gitFile(p);
  const from = Math.max(1, frame.lineNumber - around), to = Math.min(lines.length, frame.lineNumber + around);
  return { path: p, ref: GIT_REF, line: frame.lineNumber, from, alsoIn: paths.filter((x) => x !== p),
    lines: lines.slice(from - 1, to), localFile: path.join(REPO_DIR, p).replace(/\\/g, '/'), outOfRange: frame.lineNumber > lines.length };
}

const DAY = 24 * 3600e3;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Last commits in GIT_REF that changed the failing line (git log -L), marked if committed after the error.
async function changesSince(code, errIso, max = 3) {
  if (!code || !code.path || !code.line || code.outOfRange) return [];
  const out = await git(['log', GIT_REF, `-L${code.line},${code.line}:${code.path}`, '-s', '--format=%h%x09%aI%x09%an%x09%s', `-${max}`, '--since=120.days']);
  return out.trim().split('\n').filter((l) => l.includes('\t')).map((l) => { const [hash, iso, author, subject] = l.split('\t');
    return { hash, date: iso.slice(0, 10), iso, author, subject, afterError: errIso ? new Date(iso) > new Date(errIso) : false }; });
}

const LOGGER_FRAME = /\.(CallLog|TTPortalLog|TTLog|LogHelper|GlobalApiExceptionHandler|GzipFilter)$/;
const isApp = (f) => /^com\.(tt|ws)\./.test(f.className || '');
function parseFrames(body) {
  try { const b = typeof body === 'string' ? JSON.parse(body) : body; const st = typeof b.stacktrace === 'string' ? JSON.parse(b.stacktrace) : b.stacktrace;
    return Array.isArray(st) ? st.map((f) => ({ className: f.className, methodName: f.methodName, fileName: f.fileName, lineNumber: f.lineNumber,
      simpleClass: (f.className || '').split('.').pop(), app: isApp(f) })) : []; } catch { return []; }
}

const topFrameOf = (frames) => frames.find((f) => f.app && !LOGGER_FRAME.test(f.className)) || frames.find((f) => f.app) || null;
const locKey = (f) => (f ? `${f.simpleClass}.${f.methodName}:${f.lineNumber}` : 'no stack trace');

module.exports = { fs, path, OSD_URL, TENANT, INDEX, INDEX_PATTERN_ID, PORT, M, C, BIG_FIELDS, BOOK_ACTIONS, PAY_SERVICES, PAY_METHODS, search, range, termsAgg, anyOf, explain, execFile, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath, codeFor, DAY, mapLimit, changesSince, LOGGER_FRAME, isApp, parseFrames, topFrameOf, locKey };
