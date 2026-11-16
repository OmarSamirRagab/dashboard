// Local, rule-based fix suggestions for logged Java exceptions. No AI, nothing leaves the machine.
// Input: the failing source file (from GIT_REF), the failing frame, the caller frame, and the exception type.
// Output: suggestions, each a set of exact search/replace edits on GIT_REF files, plus why/confidence.
'use strict';

const KEYWORDS = new Set(['this', 'super', 'new', 'return', 'if', 'for', 'while', 'switch', 'catch', 'throw', 'else', 'case', 'try', 'synchronized']);
const LOGGING = /^\s*(logHelper|LogHelper|CallLog|TTPortalLog|TTLog|log|logger|LOGGER|LOG)\s*\./;

const indentOf = (s) => (/^\s*/.exec(s) || [''])[0];
const unitOf = (ind) => (ind.includes('\t') ? '\t' : '    ');
const trimEnd = (s) => s.replace(/\s+$/, '');

// The statement containing line idx (0-based): walk up over continuation lines, down to the terminating ';' or '{'.
function statementAt(lines, idx) {
  let s = idx;
  while (s > 0) {
    const prev = lines[s - 1].trim();
    const cur = lines[s].trim();
    if (cur.startsWith('.') || cur.startsWith('+') || cur.startsWith('?') || cur.startsWith(':') || cur.startsWith('&&') || cur.startsWith('||')) { s--; continue; }
    if (!prev || /[;{}]$/.test(prev) || prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('@')) break;
    s--;
  }
  let e = idx;
  while (e < lines.length - 1 && !/[;{]\s*(\/\/.*)?$/.test(lines[e].trim())) e++;
  return { start: s, end: e, text: lines.slice(s, e + 1).join('\n') };
}

// Enclosing method declaration (scan upwards for a signature at a lower indentation).
function enclosingMethod(lines, idx) {
  const re = /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract|default)\s+)*(?:<[^>]+>\s+)?([\w.$<>\[\], ?]+?)\s+(\w+)\s*\(([^)]*)\)?\s*(?:throws\s+[\w.,\s]+)?\{?\s*$/;
  for (let i = idx; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m && !KEYWORDS.has(m[2]) && !/^(new|return|else)$/.test(m[1].trim()) && !/[=;]/.test(lines[i])) {
      // parameters may span lines
      let params = m[3] || '';
      if (!lines[i].includes(')')) { for (let k = i + 1; k < Math.min(lines.length, i + 8); k++) { params += ' ' + lines[k]; if (lines[k].includes(')')) break; } }
      const names = params.split(')')[0].split(',').map((p) => p.trim().split(/\s+/).pop()).filter((p) => /^\w+$/.test(p || ''));
      return { line: i, returnType: m[1].trim(), name: m[2], params: names };
    }
  }
  return null;
}

// Expressions that can be null on a statement: plain receivers ("a" in a.b()) and getter-chain prefixes (a.getB()).
function nullCandidates(stmt) {
  const code = stmt.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\/\/.*$/gm, '');
  const out = [];
  const add = (expr) => { if (!out.includes(expr)) out.push(expr); };
  const chainRe = /(?<![\w.$\])"])([a-z_][\w$]*)((?:\s*\.\s*(?:get|is)\w*\(\s*\))*)\s*\.\s*[A-Za-z_]\w*\s*\(/g;
  let m;
  while ((m = chainRe.exec(code))) {
    const root = m[1];
    if (KEYWORDS.has(root)) continue;
    add(root);
    const calls = (m[2].match(/\.\s*(?:get|is)\w*\(\s*\)/g) || []).map((c) => c.replace(/\s+/g, ''));
    let acc = root;
    for (const c of calls) { acc += c; add(acc); }
  }
  return out;
}

const declaredVar = (stmt) => { const m = /^\s*(?:final\s+)?[\w.<>\[\], ?]+\s+(\w+)\s*=/.exec(stmt); return m ? m[1] : null; };
const declaredType = (lines, upto, name) => {
  const re = new RegExp(`([A-Z][\\w.<>]*)\\s+${name}\\s*[=;,)]`);
  for (let i = upto; i >= Math.max(0, upto - 400); i--) { const m = re.exec(lines[i]); if (m) return m[1]; }
  return null;
};

// Make a find string unique in the file by adding lines above it.
function uniqueFind(lines, start, end) {
  const src = lines.join('\n');
  for (let s = start; s >= Math.max(0, start - 6); s--) {
    const find = lines.slice(s, end + 1).join('\n');
    if (src.split(find).length - 1 === 1) return { find, start: s };
  }
  return null;
}

function importEdit(file, lines, fqcn) {
  const simple = fqcn.split('.').pop(); const pkg = fqcn.slice(0, fqcn.lastIndexOf('.'));
  if (lines.some((l) => l.trim() === `import ${fqcn};` || l.trim() === `import ${pkg}.*;`)) return null;
  if (fqcn.startsWith('java.lang.')) return null;
  const imports = lines.map((l, i) => [l, i]).filter(([l]) => /^import\s+[\w.]+(\.\*)?;\s*$/.test(l));
  // clash: another class with the same simple name already imported
  if (imports.some(([l]) => new RegExp(`\\.${simple};\\s*$`).test(l))) return { clash: true };
  if (!imports.length) return null;
  const [lastLine] = imports[imports.length - 1];
  return { file, find: lastLine, replace: `${lastLine}\nimport ${fqcn};`, explanation: `Add import ${fqcn}.` };
}

// What to do when the value is missing, based on the enclosing method.
function missingAction(meth, cls, exprLabel, opts = {}) {
  if (opts.sessionUser) return { kind: 'unauthorized', code: 'throw new UnAuthorizedException("Your session has expired. Please log in again.");',
    imports: ['com.tt.exception.UnAuthorizedException'], label: 'Answer 401 "session expired"', confidence: 'high' };
  if (meth && meth.returnType === 'void') return { kind: 'return', code: 'return;', label: 'Return early (skip the rest of the method)', confidence: 'low' };
  return { kind: 'throw', code: `throw new IllegalStateException("[${cls}][${meth ? meth.name : '?'}] ${exprLabel.replace(/"/g, '')} is null");`,
    label: 'Fail with a clear message instead of an NPE', confidence: 'low' };
}

function suggestFor({ type, msg, file, lines, frame, caller }) {
  const out = [];
  const L = frame.lineNumber - 1;
  if (!lines[L]) return out;
  const cls = frame.simpleClass || (frame.className || '').split('.').pop();
  const st = statementAt(lines, L);
  const meth = enclosingMethod(lines, st.start);
  const ind = indentOf(lines[st.start]); const unit = unitOf(ind);
  const stmtOneLine = st.text.replace(/\s+/g, ' ').trim();

  const pushInsertBefore = (id, title, why, confidence, guardLines, imports = []) => {
    const u = uniqueFind(lines, st.start, st.end);
    if (!u) return;
    const before = lines.slice(u.start, st.start);
    const edits = [{ file, find: u.find, replace: [...before, ...guardLines, ...lines.slice(st.start, st.end + 1)].join('\n'), explanation: title }];
    for (const fq of imports) { const ie = importEdit(file, lines, fq); if (ie && ie.clash) return; if (ie) edits.push(ie); }
    out.push({ rule: id, title, why, confidence, edits });
  };

  if (type === 'NullPointerException') {
    // Injected beans / loggers are practically never the null value.
    const INJECTED = /^(log|logger|logHelper|LOG|LOGGER)$|(Service|Dao|DAO|Manager|Repository|Helper|Util|Utils|Mapper|Template|Client|Factory)$/;
    // Values created with `new` / a builder in this method cannot be null.
    const neverNull = (v) => { const re = new RegExp(`\\b${v}\\s*=\\s*(new\\b|[\\w.]+\\.builder\\(\\))`);
      for (let i = st.start; i >= Math.max(0, (meth ? meth.line : st.start - 200)); i--) if (re.test(lines[i])) return true; return false; };
    // Expressions the statement already null-checks itself (e.g. `x.getA() != null ? ... : ...`).
    const checked = (c) => new RegExp(`${c.replace(/[.()]/g, (ch) => '\\' + ch)}\\s*[!=]=\\s*null|null\\s*[!=]=\\s*${c.replace(/[.()]/g, (ch) => '\\' + ch)}`).test(st.text);
    const cands = nullCandidates(st.text).filter((c) => c !== declaredVar(st.text) && !INJECTED.test(c.split('.')[0])
      && !neverNull(c.split('.')[0]) && !checked(c));
    const params = meth ? meth.params : [];

    // A) the null comes in as a parameter from a stream lambda: filter nulls in the caller's stream.
    const param = cands.find((c) => params.includes(c));
    if (param && caller && caller.lines && /^lambda\$/.test(caller.frame.methodName)) {
      const cl = caller.lines; const ci = caller.frame.lineNumber - 1;
      const cst = statementAt(cl, ci);
      const mapIdx = (() => { for (let i = ci; i >= cst.start; i--) if (/^\s*\.\s*(map|forEach|flatMap)\s*\(/.test(cl[i]) || /\.\s*(map|forEach|flatMap)\s*\(/.test(cl[i])) return i; return -1; })();
      if (mapIdx >= 0 && /^\s*\./.test(cl[mapIdx]) && !cst.text.includes('Objects::nonNull')) {
        const u = uniqueFind(cl, mapIdx, mapIdx);
        if (u) {
          const edits = [{ file: caller.file, find: u.find, replace: [...cl.slice(u.start, mapIdx), `${indentOf(cl[mapIdx])}.filter(Objects::nonNull)`, cl[mapIdx]].join('\n'),
            explanation: 'Drop null elements before they reach the mapping function.' }];
          const ie = importEdit(caller.file, cl, 'java.util.Objects'); if (ie && !ie.clash) edits.push(ie);
          out.push({ rule: 'npe-stream-filter', confidence: 'high', edits,
            title: `Filter null elements in the stream (${caller.frame.simpleClass || ''} line ${caller.frame.lineNumber})`,
            why: `"${param}" is a parameter of ${meth.name}() and is null. It comes from a stream element in the caller, so the collection contains a null entry. Skipping null elements prevents the NPE without changing the result for valid elements.` });
        }
      }
    }

    // B) logging-only statement: skip it when the data is missing (never breaks the business flow).
    if (cands.length && LOGGING.test(lines[st.start]) && !/^\s*\w[\w<>.]*\s+\w+\s*=/.test(lines[st.start])) {
      const chain = cands.filter((c) => !LOGGING.test(c + '.')).slice(0, 4);
      if (chain.length) {
        const cond = chain.map((c) => `${c} != null`).join(' && ');
        const u = uniqueFind(lines, st.start, st.end);
        // If the same value is used again later in the method (outside logging), skipping the log only moves the NPE.
        const usedLater = chain.map((c) => c.split('.')[0]).filter((v, i, a) => a.indexOf(v) === i).filter((v) => {
          for (let i = st.end + 1; i < Math.min(lines.length, st.end + 300); i++) {
            if (meth && enclosingMethod(lines, i) && enclosingMethod(lines, i).line !== meth.line) break;
            const s = statementAt(lines, i);
            if (new RegExp(`\\b${v}\\s*\\.`).test(lines[i]) && !LOGGING.test(lines[s.start])) return true;
          }
          return false;
        });
        if (u) out.push({ rule: 'npe-skip-logging', confidence: usedLater.length ? 'low' : 'high',
          title: 'Only log when the data is present',
          why: 'The failing statement only writes a log entry. Guarding it means a missing value can no longer break the request; the log entry is skipped in that case.'
            + (usedLater.length ? ` But ${usedLater.join(', ')} is used again later in ${meth ? meth.name + '()' : 'the method'}, so the request would probably fail further down – prefer another suggestion.` : ''),
          edits: [{ file, find: u.find, replace: [...lines.slice(u.start, st.start), `${ind}if (${cond}) {`, ...lines.slice(st.start, st.end + 1).map((l) => unit + l), `${ind}}`].join('\n'), explanation: 'Guard the log statement.' }] });
      }
    }

    // C) null guard before the statement for each candidate (session user gets a 401).
    // Parameters fed by a stream lambda are handled by (A); don't also guard them (or their getters) here.
    const streamParamHandled = out.some((s) => s.rule === 'npe-stream-filter');
    const guardable = cands.filter((c) => !(streamParamHandled && params.includes(c.split('.')[0]))).slice(0, 3);
    for (const c of guardable) {
      const root = c.split('.')[0];
      const t = declaredType(lines, st.start, root);
      const sessionUser = t === 'UserSessionBean' && c === root;
      const action = missingAction(meth, cls, c, { sessionUser });
      const chain = [];
      let acc = '';
      for (const part of c.match(/[a-z_][\w$]*|\.(?:get|is)\w*\(\)/g) || [c]) { acc += part; chain.push(acc); }
      const cond = chain.map((x) => `${x} == null`).join(' || ');
      pushInsertBefore(`npe-guard-${action.kind}`, `${action.label} when ${c} is null`,
        sessionUser
          ? `${c} comes from the HTTP session and is null when the session lost the logged-in user (expired or invalidated). The caller already treats this as UnAuthorizedException (HTTP 401); doing the same here returns "session expired" instead of an NPE / HTTP 500.`
          : `${c} is dereferenced on the failing line and is the likely null value. ${action.kind === 'throw' ? 'This does not make the operation succeed; it replaces the NPE with a clear error so the real cause (why it is null) can be fixed.' : 'This skips the rest of the method when the value is missing; check that nothing after it is required.'}`,
        action.confidence,
        [`${ind}if (${cond}) {`, `${ind}${unit}${action.code}`, `${ind}}`], action.imports || []);
    }
    if (!out.length) out.push({ rule: 'npe-none', confidence: 'none', edits: [],
      title: 'No automatic suggestion',
      why: `No dereferenced variable found on the failing statement ("${stmtOneLine.slice(0, 140)}"). It may be auto-unboxing of a null Integer/Long/Boolean, or the production code differs from the shown version.` });
  }

  if (type === 'NumberFormatException') {
    const parseRe = /(Integer\.parseInt|Integer\.valueOf|Long\.parseLong|Long\.valueOf|Double\.parseDouble|Double\.valueOf)\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)/;
    const m = parseRe.exec(lines[L]);
    if (m && !/,/.test(m[2])) {
      const fn = { 'Integer.parseInt': 'toInt', 'Integer.valueOf': 'toInt', 'Long.parseLong': 'toLong', 'Long.valueOf': 'toLong', 'Double.parseDouble': 'toDouble', 'Double.valueOf': 'toDouble' }[m[1]];
      const def = fn === 'toDouble' ? '0d' : fn === 'toLong' ? '0L' : '0';
      const newLine = lines[L].replace(m[0], `NumberUtils.${fn}(${m[2].trim()}, ${def})`);
      const u = uniqueFind(lines, L, L);
      if (u) {
        const edits = [{ file, find: u.find, replace: [...lines.slice(u.start, L), newLine].join('\n'), explanation: `Parse safely; empty or non-numeric text gives ${def}.` }];
        const ie = importEdit(file, lines, 'org.apache.commons.lang3.math.NumberUtils');
        if (!(ie && ie.clash)) { if (ie) edits.push(ie);
          out.push({ rule: 'nfe-safe-parse', confidence: 'medium', edits, title: `Parse ${m[2].trim()} safely (default ${def})`,
            why: `${m[1]}(${m[2].trim()}) fails for empty, null or non-numeric text${msg ? ` (logged value: ${msg})` : ''}. commons-lang3 NumberUtils (already used in the code base) returns ${def} instead. Check that ${def} is a sensible default here.` }); }
      }
    }
  }

  if (/IndexOutOfBoundsException$/.test(type)) {
    const g = /([a-z_][\w$.()]*)\s*\.\s*get\s*\(\s*(\d+)\s*\)/.exec(lines[L]);
    const a = /([a-z_][\w$]*)\s*\[\s*(\d+)\s*\]/.exec(lines[L]);
    const hit = g ? { expr: g[1], n: +g[2], cond: (e, n) => `${e} == null || ${e}.size() <= ${n}` } : a ? { expr: a[1], n: +a[2], cond: (e, n) => `${e} == null || ${e}.length <= ${n}` } : null;
    if (hit) {
      const action = missingAction(meth, cls, `${hit.expr} has no element ${hit.n}`);
      pushInsertBefore(`ioobe-guard-${action.kind}`, `${action.label} when ${hit.expr} has no element ${hit.n}`,
        `${hit.expr} is shorter than expected${msg ? ` (${msg})` : ''} – usually an empty list/array from a supplier response or input. Guarding it avoids reading a missing element.`,
        action.confidence, [`${ind}if (${hit.cond(hit.expr, hit.n)}) {`, `${ind}${unit}${action.code}`, `${ind}}`]);
    }
  }
  return out;
}

module.exports = { suggestFor, statementAt, enclosingMethod, nullCandidates };
