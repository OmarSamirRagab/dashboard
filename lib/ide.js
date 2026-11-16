// Open source files in IntelliJ (built-in server, fallback idea64.exe).
'use strict';
const { fs, path, OSD_URL, TENANT, INDEX, INDEX_PATTERN_ID, PORT, M, C, BIG_FIELDS, BOOK_ACTIONS, PAY_SERVICES, PAY_METHODS, search, range, termsAgg, anyOf, explain, execFile, REPO_DIR, GIT_REF, git, getJavaIndex, gitFile, pickPath, codeFor, DAY, mapLimit, changesSince, LOGGER_FRAME, isApp, parseFrames, topFrameOf, locKey } = require('./core');

// ---------------- Open a file in IntelliJ ----------------
// 1) IntelliJ's built-in server (port 63342, IDE must be running);  2) fallback: launch idea64.exe --line N file.
const IDEA_PORT = Number(process.env.IDEA_PORT || 63342);
const IDEA_EXE = process.env.IDEA_EXE || [
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'IntelliJ IDEA Ultimate 2024.3.4.1', 'bin', 'idea64.exe'),
  'C:\\Program Files\\JetBrains\\IntelliJ IDEA Community Edition 2024.3.4\\bin\\idea64.exe',
].find((p) => fs.existsSync(p));

// The snippet is from GIT_REF; the working copy may be on another branch. Find the same code line nearest to the
// reported line in the working copy so IntelliJ lands on the right statement.
async function workingCopyLine(repoPath, line) {
  const abs = path.join(REPO_DIR, repoPath);
  if (!fs.existsSync(abs)) return { abs, line, exists: false, shifted: 0 };
  const refLines = await gitFile(repoPath);
  const target = (refLines[line - 1] || '').trim();
  const wc = fs.readFileSync(abs, 'utf8').split(/\r?\n/);
  if (!target || (wc[line - 1] || '').trim() === target) return { abs, line, exists: true, shifted: 0 };
  let best = -1;
  wc.forEach((l, i) => { if (l.trim() === target && (best < 0 || Math.abs(i + 1 - line) < Math.abs(best - line))) best = i + 1; });
  return best > 0 ? { abs, line: best, exists: true, shifted: best - line } : { abs, line, exists: true, shifted: 0, notFound: true };
}

async function openInIdea(repoPath, line, opts = {}) {
  let wc;
  if (opts.absolute) {
    // Used by the fixer for files in the fix worktree; nothing outside it may be opened this way.
    const root = path.resolve(process.env.FIX_WORKTREE || `${REPO_DIR}-fix`) + path.sep;
    const abs = path.resolve(repoPath);
    if (!abs.startsWith(root) || !fs.existsSync(abs)) throw new Error('File is not in the fix worktree');
    wc = { abs, line, exists: true, shifted: 0 };
  } else {
    // only files that exist in the repo index can be opened
    const idx = await getJavaIndex();
    if (![...idx.values()].some((ps) => ps.includes(repoPath))) throw new Error('Unknown file');
    wc = await workingCopyLine(repoPath, line);
  }
  if (!wc.exists) throw new Error(`${repoPath} does not exist in your working copy (branch differs from ${GIT_REF}).`);
  const fileArg = wc.abs.replace(/\\/g, '/');
  try {
    const r = await fetch(`http://127.0.0.1:${IDEA_PORT}/api/file?file=${encodeURIComponent(fileArg)}&line=${wc.line}`, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return { via: 'IntelliJ (running)', ...wc };
  } catch { /* IDE not running or port closed: fall back to the launcher */ }
  if (!IDEA_EXE) throw new Error('IntelliJ is not running and idea64.exe was not found (set IDEA_EXE).');
  require('child_process').spawn(IDEA_EXE, ['--line', String(wc.line), wc.abs], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { via: 'idea64.exe', ...wc };
}

module.exports = { IDEA_PORT, IDEA_EXE, workingCopyLine, openInIdea };
