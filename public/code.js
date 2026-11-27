'use strict';
// Code viewer, IntelliJ button and the local rule-based Suggest fix panel (shared by Exceptions and My work).
function ideButton(repoPath, line) {
  const b = el('button', { type: 'button', className: 'iconbtn', style: { height: '26px', fontSize: '12px', fontWeight: 600 },
    title: 'Open this line in IntelliJ IDEA (your working copy)' }, el('span', { className: 'ij', textContent: 'IJ' }), 'Open in IntelliJ');
  b.onclick = async () => {
    b.disabled = true;
    try {
      const r = await api('/api/open-ide', { path: repoPath, line });
      toast(`Opened in IntelliJ at line ${r.line}` + (r.shifted ? ` (${r.shifted > 0 ? '+' : ''}${r.shifted} lines on your branch)` : '')
        + (r.notFound ? ' – this line differs on your branch' : ''));
    } catch (e) { toast('⚠ ' + e.message); }
    finally { b.disabled = false; }
  };
  return b;
}

function codeView(code, frame, host, ctx) {
  if (!code) return el('div', { className: 'muted' }, 'No code location.');
  if (code.error) return el('div', { className: 'err' }, 'Could not read the code: ' + code.error);
  if (code.missing) return el('div', { className: 'muted' }, `${frame.className} is not in ${code.ref} (class may be generated, renamed or from a library).`);
  const fixBox = el('div');
  const view = codeTable(code, frame, ctx ? fixButton(ctx, frame, fixBox) : null);
  return ctx ? el('div', {}, view, fixBox) : view;
}

function codeTable(code, frame, fixBtn) {
  const tb = el('tbody', {}, code.lines.map((l, k) => { const n = code.from + k;
    return el('tr', { className: n === code.line ? 'hit' : '' }, el('td', { className: 'ln', textContent: n }), el('td', { textContent: l || ' ' })); }));
  return el('div', { className: 'code' },
    el('div', { className: 'code-h' },
      el('span', { className: 'mono', style: { fontWeight: 600 } }, `${frame.simpleClass}.${frame.methodName}()`),
      el('span', { className: 'muted mono' }, `${code.path}:${code.line}`), copyBtn(`${code.path}:${code.line}`),
      el('div', { style: { flex: 1 } }),
      fixBtn,
      ideButton(code.path, code.line),
      el('a', { href: `vscode://file/${code.localFile}:${code.line}`, title: 'Opens your working copy; lines may differ from ' + code.ref }, 'VS Code'),
      el('span', { className: 'muted' }, '@ ' + code.ref)),
    code.outOfRange ? el('div', { className: 'err', style: { padding: '6px 10px' } }, `Line ${code.line} is beyond the file in ${code.ref}: production runs a different version.`) : null,
    (() => { const hit = (code.lines[code.line - code.from] || '').trim();
      return !code.outOfRange && (!hit || /^(\/\/|\/\*|\*)/.test(hit) || /^[{}]$/.test(hit))
        ? el('div', { className: 'err', style: { padding: '6px 10px', fontSize: '12.5px' } }, `⚠ Line ${code.line} is ${hit ? 'a comment / brace' : 'blank'} in ${code.ref}, so it cannot throw. Production runs a different version of this file than ${code.ref} – the snippet may not show the real failing code.`)
        : null; })(),
    el('div', { className: 'code-scroll' }, el('table', {}, tb)),
    code.alsoIn && code.alsoIn.length ? el('div', { className: 'muted', style: { padding: '4px 10px', fontSize: '11.5px' } }, 'Same class also in: ' + code.alsoIn.join(', ')) : null);
}

/* ================= Suggested fix (local rules, no AI) ================= */
function fixButton(ctx, frame, box) {
  const b = el('button', { type: 'button', className: 'iconbtn fixbtn', title: 'Suggest a code fix for this line (generated locally, nothing is sent anywhere)' }, '💡 Suggest fix');
  b.onclick = async () => {
    if (box.firstChild) { box.replaceChildren(); return; }
    box.replaceChildren(el('div', { className: 'fixpanel muted' }, 'Analysing the code…'));
    try {
      const frames = (ctx.frames && ctx.frames.length ? ctx.frames : [frame]);
      const p = await api('/api/fix/propose', { type: ctx.type, msg: ctx.msg, method: ctx.method, top: frame, frames });
      box.replaceChildren(fixPanel(p, box));
    } catch (e) { box.replaceChildren(el('div', { className: 'fixpanel err' }, '⚠ ' + e.message)); }
  };
  return b;
}

const CONF = { high: ['var(--good)', '✓', 'High confidence'], medium: ['var(--warning)', '!', 'Medium – review'], low: ['var(--serious)', '!', 'Low – review carefully'], none: ['var(--neutral)', '–', 'No suggestion'] };

function fixPanel(p, box) {
  const usable = p.suggestions.filter(s => s.valid);
  const parts = [el('div', { className: 'fix-h' },
    el('b', {}, usable.length ? `${usable.length} suggested fix${usable.length > 1 ? 'es' : ''}` : 'No automatic fix'),
    el('span', { className: 'muted', style: { fontSize: '12px' } }, `rule-based, from the code at ${p.gitRef} · pick one, review the diff, apply`),
    el('div', { style: { flex: 1 } }),
    el('button', { type: 'button', className: 'iconbtn', onclick: () => box.replaceChildren() }, 'Close'))];
  if (!p.suggestions.length) parts.push(el('div', { className: 'muted' }, 'No rule matches this exception type / line yet. Use the explanation above and fix it by hand.'));
  const branch = el('input', { type: 'text', value: p.suggestedBranch, className: 'mono', style: { maxWidth: '420px' } });
  p.suggestions.forEach((s, i) => parts.push(suggestionCard(s, i, branch)));
  if (usable.length) parts.push(el('div', { className: 'fix-apply' },
    el('label', { className: 'field', style: { flex: 1 } }, el('span', {}, `Fix branch in ${(cfg.fix || {}).worktree} (created from ${(cfg.fix || {}).gitRef} if new)`), branch)),
    el('div', { className: 'muted', style: { fontSize: '12px' } }, 'Apply writes only into that separate worktree and opens the file in IntelliJ. Your current branch is not touched. Nothing is committed or pushed.'));
  return el('div', { className: 'fixpanel' }, parts);
}

function suggestionCard(s, i, branchInput) {
  const [c, icon, label] = CONF[s.confidence] || CONF.none;
  const res = el('div');
  const btn = s.valid ? el('button', { type: 'button', className: 'primary', style: { height: '32px' } }, el('span', { className: 'ij', textContent: 'IJ' }), ' Apply & open in IntelliJ') : null;
  if (btn) btn.onclick = async () => {
    btn.disabled = true; res.replaceChildren(el('div', { className: 'muted' }, 'Applying…'));
    try {
      const r = await api('/api/fix/apply', { id: s.id, branch: branchInput.value.trim() });
      res.replaceChildren(el('div', { className: 'fix-ok' },
        el('div', {}, el('b', {}, '✓ Applied'), ` in ${r.worktree} on branch `, el('span', { className: 'mono' }, r.branch), r.createdWorktree ? ` (new worktree from ${(cfg.fix || {}).gitRef})` : ''),
        el('div', { className: 'muted' }, r.opened && !r.opened.error ? `Opened in IntelliJ at line ${r.results[0].line}.` : `Could not open IntelliJ: ${(r.opened || {}).error || 'n/a'}`),
        el('div', { className: 'muted' }, r.next),
        el('details', {}, el('summary', { className: 'linkbtn' }, 'git diff'), el('pre', { textContent: r.diff || '(no diff)' }))));
      toast('Fix applied on ' + r.branch);
    } catch (e) {
      res.replaceChildren(el('div', { className: 'err' }, '⚠ ' + e.message));
      const m = /uncommitted changes on (\S+)\./.exec(e.message); if (m) branchInput.value = m[1];
      btn.disabled = false;
    }
  };
  return el('div', { className: 'sugg' },
    el('div', { className: 'fix-h' },
      el('span', { className: 'muted num', style: { fontWeight: 700 } }, `${i + 1}.`),
      el('b', {}, s.title),
      el('span', { className: 'pill', style: { '--c': c } }, el('span', { className: 'ico' + (s.confidence === 'medium' ? ' dark-ink' : ''), textContent: icon }), label),
      el('div', { style: { flex: 1 } }), btn),
    el('div', { className: 'ink2', style: { fontSize: '13px' } }, s.why),
    ...s.edits.map(diffView), res);
}

function diffView(ed) {
  // Show find/replace as a diff: unchanged context lines are shown once, removed/added lines are marked.
  const a = ed.find.split('\n'), b = ed.replace.split('\n');
  let pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0; while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const line = (cls, sign, t) => el('div', { className: 'dl ' + cls }, el('span', { className: 'sign' }, sign), t || ' ');
  const rows = [...a.slice(0, pre).map(t => line('', ' ', t)), ...a.slice(pre, a.length - suf).map(t => line('del', '−', t)),
    ...b.slice(pre, b.length - suf).map(t => line('add', '+', t)), ...a.slice(a.length - suf).map(t => line('', ' ', t))];
  return el('div', { className: 'diff' },
    el('div', { className: 'diff-h' }, el('span', { className: 'mono' }, `${ed.file}${ed.line ? ':' + ed.line : ''}`),
      ed.valid ? null : el('span', { className: 'err' }, ` ⚠ ${ed.problem}`)),
    el('div', { className: 'diff-b' }, rows));
}
