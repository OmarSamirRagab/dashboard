// "Handled by backend code": a failure message that the odeysys backend itself produces (a string literal in a
// constant, enum, throw or log in the Java code), e.g. "Your booking is being processed", the duplicate-booking
// validation, wallet balance. Those are classified by code, not by FAILURE_MESSAGES (which maps supplier errors).
// Read-only: `git grep` on the *.java files of GIT_REF (never properties files, never the undeployed odeysysrest-tt).
'use strict';
const { git, GIT_REF, REPO_DIR, path, mapLimit } = require('./core');

const cache = new Map(); // needle -> Promise<hit|null>
const MIN = 14, MAX = 80;

// The longest fixed piece of the message (dynamic parts such as numbers, ids, quoted values and JSON cut it).
function needleOf(msg) {
  const parts = String(msg || '').replace(/\s+/g, ' ')
    .split(/\d{2,}|["'{}\[\]|<>=]| : | - |\bfor\s+\/|\$/)
    .map((s) => s.replace(/^[\s.,:;!()-]+|[\s.,:;!()-]+$/g, ''))
    .filter((s) => s.length >= MIN && /[a-z]{3,}/i.test(s) && s.split(' ').length >= 3);
  if (!parts.length) return null;
  let n = parts.sort((a, b) => b.length - a.length)[0];
  if (n.length > MAX) n = n.slice(0, MAX).replace(/\s+\S*$/, '');
  return n;
}

// Lines that only *compare* against the text (recognising a supplier's error) are not the backend producing it.
const COMPARE = /\.(contains|equals|equalsIgnoreCase|indexOf|startsWith|endsWith|matches)\s*\(\s*"[^"]*$|\.(contains|equalsIgnoreCase|equals|indexOf|startsWith|matches)\s*\(\s*"/;
const rank = (p) => (p.startsWith('common-odeysys/') ? 0 : p.startsWith('ttesb-tt/') ? 1 : 2);

async function lookup(needle) {
  let out = '';
  try { out = await git(['grep', '-n', '-i', '-F', '-e', needle, GIT_REF, '--', '*.java', ':!odeysysrest-tt/**', ':!**/*Test.java']); }
  catch (e) { return null; } // exit code 1 = no match
  const hits = [];
  for (const l of out.split('\n')) {
    const m = /^[^:]+:(.+?\.java):(\d+):(.*)$/.exec(l); if (!m) continue;
    const text = m[3].trim();
    if (COMPARE.test(text) || /^\s*(\/\/|\*)/.test(text)) continue;
    hits.push({ path: m[1], line: +m[2], text: text.slice(0, 240) });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => rank(a.path) - rank(b.path) || (/throw|Exception\(|static final|\(".*"\)\s*[,;]/.test(b.text) - /throw|Exception\(|static final|\(".*"\)\s*[,;]/.test(a.text)));
  const h = hits[0];
  return { ...h, file: h.path.split('/').pop(), localFile: path.join(REPO_DIR, h.path).replace(/\\/g, '/'), needle, places: hits.length };
}

function match(msg) {
  const needle = needleOf(msg); if (!needle) return Promise.resolve(null);
  const k = needle.toLowerCase();
  if (!cache.has(k)) { if (cache.size > 2000) cache.clear(); cache.set(k, lookup(needle)); }
  return cache.get(k);
}

// rows: failures; sets row.backend for those not classified by the DB. Distinct messages are looked up once.
async function annotate(rows) {
  const msgs = [...new Set(rows.filter((r) => !r.db).map((r) => r.raw || r.reason).filter(Boolean))];
  const found = new Map();
  await mapLimit(msgs, 4, async (m) => { found.set(m, await match(m)); });
  for (const r of rows) if (!r.db) r.backend = found.get(r.raw || r.reason) || null;
}

module.exports = { needleOf, match, annotate };
