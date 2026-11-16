// Suggested code fixes for logged exceptions: generated locally by rules (fixrules.js), nothing leaves the machine.
// Apply writes only into a separate git worktree (FIX_WORKTREE), never into your working copy. Nothing is committed.
'use strict';
const fs = require('fs');
const path = require('path');
const { suggestFor } = require('./fixrules');

function createFixer({ git, GIT_REF, REPO_DIR, getJavaIndex, gitFile, codeFor, openInIdea }) {
  const FIX_WORKTREE = process.env.FIX_WORKTREE || `${REPO_DIR}-fix`;
  const proposals = new Map(); // id -> { edits, valid }

  async function fileExistsInRef(p) { return [...(await getJavaIndex()).values()].some((ps) => ps.includes(p)); }
  async function sourceOf(frame) {
    const c = await codeFor(frame, null, 0);
    if (!c || !c.path || c.missing) return null;
    return { file: c.path, lines: await gitFile(c.path), frame };
  }

  // ---------- suggest ----------
  async function propose(input) {
    const frames = (input.frames || []).filter((f) => f && f.className && f.lineNumber > 0);
    const top = input.top || frames[0];
    if (!top) throw Object.assign(new Error('No code location for this exception (no stack trace), so no fix can be suggested.'), { status: 400 });
    const src = await sourceOf(top);
    if (!src) throw Object.assign(new Error(`${top.className} is not in ${GIT_REF}.`), { status: 400 });
    const callerFrame = frames.find((f) => f !== top && (f.className !== top.className || f.methodName !== top.methodName || f.lineNumber !== top.lineNumber)
      && /^com\.(tt|ws)\./.test(f.className));
    const caller = callerFrame ? await sourceOf(callerFrame) : null;

    const raw = suggestFor({ type: (input.type || '').trim(), msg: input.msg || '', file: src.file, lines: src.lines, frame: top, caller });
    const files = { [src.file]: src.lines.join('\n') }; if (caller) files[caller.file] = caller.lines.join('\n');
    const suggestions = raw.map((s) => {
      const edits = s.edits.map((ed) => {
        const text = files[ed.file]; const n = text ? text.split(ed.find).length - 1 : 0;
        const line = n === 1 ? text.slice(0, text.indexOf(ed.find)).split('\n').length : null;
        return { ...ed, line, valid: n === 1, problem: n === 1 ? null : `matches ${n} times` };
      });
      const id = `fx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      const valid = edits.length > 0 && edits.every((e) => e.valid);
      if (valid) proposals.set(id, { edits, valid });
      return { id, ...s, edits, valid };
    });
    while (proposals.size > 200) proposals.delete(proposals.keys().next().value);
    const order = { high: 0, medium: 1, low: 2, none: 3 };
    suggestions.sort((a, b) => order[a.confidence] - order[b.confidence]);
    return { gitRef: GIT_REF, suggestions,
      suggestedBranch: `bugfix/${(top.simpleClass || 'fix').replace(/[^A-Za-z0-9]/g, '')}-${top.methodName.replace(/[^A-Za-z0-9]/g, '')}-L${top.lineNumber}`.slice(0, 80) };
  }

  // ---------- apply (fix worktree only) ----------
  const wtRun = (args) => git(['-C', FIX_WORKTREE, ...args]);
  const branchExists = (b) => git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`]).then(() => true, () => false);

  async function ensureWorktree(branch) {
    if (!/^[A-Za-z0-9._\/-]{3,100}$/.test(branch) || branch.includes('..')) throw Object.assign(new Error('Invalid branch name.'), { status: 400 });
    if (!fs.existsSync(FIX_WORKTREE)) {
      await git(['worktree', 'add', ...((await branchExists(branch)) ? [FIX_WORKTREE, branch] : ['-b', branch, FIX_WORKTREE, GIT_REF])]);
      return { created: true };
    }
    const current = (await wtRun(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (current === branch) return { created: false };
    if ((await wtRun(['status', '--porcelain'])).trim()) {
      throw Object.assign(new Error(`The fix worktree ${FIX_WORKTREE} has uncommitted changes on ${current}. Commit or discard them, or apply to branch "${current}".`), { status: 409, branch: current });
    }
    await wtRun((await branchExists(branch)) ? ['switch', branch] : ['switch', '-c', branch, GIT_REF]);
    return { created: false, switched: true };
  }

  async function apply({ id, branch, open = true }) {
    const p = proposals.get(id);
    if (!p) throw Object.assign(new Error('Suggestion expired; click Suggest fix again.'), { status: 404 });
    for (const ed of p.edits) if (!(await fileExistsInRef(ed.file))) throw Object.assign(new Error(`Unknown file ${ed.file}`), { status: 400 });
    const wt = await ensureWorktree(branch);
    // Check every edit first, then write (all or nothing). Keep the file's own line endings.
    const pending = new Map(); const results = [];
    for (const ed of p.edits) {
      const abs = path.join(FIX_WORKTREE, ed.file);
      const raw = pending.has(abs) ? pending.get(abs) : fs.readFileSync(abs, 'utf8');
      const eol = raw.includes('\r\n') ? '\r\n' : '\n';
      const find = ed.find.replace(/\r?\n/g, eol), repl = ed.replace.replace(/\r?\n/g, eol);
      const n = raw.split(find).length - 1;
      if (n !== 1) throw Object.assign(new Error(`${ed.file}: the code to change was found ${n} times in the fix branch (expected once) – already applied, or the branch differs from ${GIT_REF}. Nothing was changed.`), { status: 409 });
      const at = raw.indexOf(find);
      pending.set(abs, raw.slice(0, at) + repl + raw.slice(at + find.length));
      results.push({ file: ed.file, line: raw.slice(0, at).split(eol).length });
    }
    for (const [abs, content] of pending) fs.writeFileSync(abs, content, 'utf8');
    const diff = await wtRun(['diff', '--', ...new Set(p.edits.map((e) => e.file))]);
    const head = (await wtRun(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    let opened = null;
    if (open && results[0]) {
      try { opened = await openInIdea(path.join(FIX_WORKTREE, results[0].file), results[0].line, { absolute: true }); }
      catch (e) { opened = { error: e.message }; }
    }
    return { worktree: FIX_WORKTREE, branch: head, createdWorktree: wt.created, results, diff, opened,
      next: `Review in IntelliJ, build with JDK 8, then commit from ${FIX_WORKTREE}. Nothing was committed or pushed.` };
  }

  return { propose, apply, FIX_WORKTREE };
}

module.exports = { createFixer };
