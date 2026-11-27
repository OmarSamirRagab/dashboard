// My work: Azure DevOps items assigned to me, with the fix in git (linked PRs/commits + local commits that mention
// the ID) and, for bugs with a Java stack trace, the code line and the local rule-based suggested fix.
'use strict';
const { REPO_DIR, GIT_REF, git, codeFor, isApp, topFrameOf, LOGGER_FRAME } = require('./core');
const azdo = require('../azdo');

// Java stack trace in free text: "x.y.SomeException: msg" + "at com.tt.A.m(A.java:12)" lines.
function parseTrace(text) {
  const frames = [];
  const re = /at\s+((?:[\w$]+\.)+[\w$]+)\.([\w$<>]+)\(([\w$]+\.java):(\d+)\)/g; let m;
  while ((m = re.exec(text || ''))) frames.push({ className: m[1], methodName: m[2], fileName: m[3], lineNumber: Number(m[4]), simpleClass: m[1].split('.').pop() });
  frames.forEach((f) => { f.app = isApp(f); });
  const ex = /\b((?:[a-z][\w$]*\.)+[A-Z][\w$]*(?:Exception|Error))\b(?::[ \t]*([^\r\n]*))?/.exec(text || '');
  if (!frames.length && !ex) return null;
  const top = frames.length ? (topFrameOf(frames) || frames[0]) : null;
  return { type: ex ? ex[1].split('.').pop() : '', fullType: ex ? ex[1] : '', msg: ex && ex[2] ? ex[2].trim().slice(0, 500) : '', frames, top,
    appFrames: frames.filter((f) => f.app && !LOGGER_FRAME.test(f.className)).length };
}

const idRe = (id) => `(^|[^0-9])${Number(id)}([^0-9]|$)`;
// Commits on any fetched branch whose message mentions the ID, and branches whose name contains it.
async function localGit(id) {
  const out = { commits: [], branches: [], error: null };
  try {
    const log = await git(['log', '--all', '-E', `--grep=${idRe(id)}`, '-n', '30', '--format=%H%x09%h%x09%aI%x09%an%x09%s', '--shortstat']);
    let cur = null;
    for (const l of log.split('\n')) {
      if (l.includes('\t')) { const [hash, short, date, author, subject] = l.split('\t'); cur = { hash, short, date, author, subject }; out.commits.push(cur); }
      else if (cur && /changed/.test(l)) cur.stat = l.trim();
    }
    if (out.commits.length) {
      const refs = await git(['branch', '-a', '--format=%(refname:short)', '--contains', out.commits[out.commits.length - 1].hash]).catch(() => '');
      out.reachedFrom = refs.split('\n').map((s) => s.trim()).filter((s) => /^(origin\/)?(master|main|uat|develop|release)/i.test(s)).slice(0, 6);
    }
    const br = await git(['for-each-ref', '--format=%(refname:short)%09%(committerdate:iso-strict)', 'refs/heads', 'refs/remotes']);
    out.branches = br.split('\n').filter(Boolean).map((l) => { const [name, date] = l.split('\t'); return { name, date }; })
      .filter((b) => new RegExp(idRe(id)).test(b.name)).slice(0, 20);
  } catch (e) { out.error = e.message; }
  return out;
}

async function detail(id) {
  const w = await azdo.itemDetail(id);
  const text = [w.repro, w.description, w.systemInfo, ...w.comments.map((c) => c.text)].join('\n');
  const trace = parseTrace(text);
  if (trace && trace.top) trace.code = await codeFor(trace.top, /admin/i.test(`${w.title} ${w.iteration}`) ? 'admin' : null, 7).catch((e) => ({ error: e.message }));
  const local = await localGit(w.id);
  // Commits linked in Azure that also exist locally can show their diff here.
  for (const c of w.links.commits) c.local = await git(['cat-file', '-e', `${c.hash}^{commit}`]).then(() => true, () => false);
  return { ...w, trace, local, repo: REPO_DIR, ref: GIT_REF };
}

// Diff of one commit from the local repo (only commits that exist there; output capped).
async function commitDiff(hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash || '')) throw Object.assign(new Error('Bad commit hash'), { status: 400 });
  await git(['cat-file', '-e', `${hash}^{commit}`]).catch(() => { throw Object.assign(new Error(`Commit ${hash} is not in ${REPO_DIR} – git fetch first`), { status: 404 }); });
  const out = await git(['show', '--stat', '--patch', '--format=%H%n%an <%ae>%n%aI%n%n%B', '-M', hash]);
  return { hash, text: out.length > 400000 ? out.slice(0, 400000) + '\n… (diff cut at 400 KB)' : out };
}

module.exports = { parseTrace, localGit, detail, commitDiff, list: () => azdo.myItems() };
