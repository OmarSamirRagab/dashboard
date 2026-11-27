// Azure DevOps: post the not-booked investigation to a work item for the team leader:
// 1) upload the PDF as a work-item attachment, 2) link it to the work item, 3) add a comment that @mentions the team leader.
// Config (env): AZDO_ORG_URL (https://dev.azure.com/<org>), AZDO_PROJECT, AZDO_PAT (scopes: Work Items Read & Write, Code Read (My work),
// Identity Read), optional AZDO_TEAM_LEADER (email), AZDO_TEAM (sprint of My work), AZDO_VSSPS_URL (identity API host, derived from the org URL).
'use strict';

const ORG = (process.env.AZDO_ORG_URL || '').replace(/\/+$/, '');
const PROJECT = process.env.AZDO_PROJECT || '';
const PAT = process.env.AZDO_PAT || '';
const VSSPS = (process.env.AZDO_VSSPS_URL || ORG.replace('://dev.azure.com/', '://vssps.dev.azure.com/')).replace(/\/+$/, '');
const API = '7.1';

const configured = () => !!(ORG && PROJECT && PAT);
const auth = () => 'Basic ' + Buffer.from(':' + PAT).toString('base64');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const proj = () => `${ORG}/${encodeURIComponent(PROJECT)}`;

async function call(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { Authorization: auth(), Accept: 'application/json', ...(opts.headers || {}) }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text.slice(0, 300) }; }
  if (res.status === 203 || /<html/i.test(text.slice(0, 200))) throw Object.assign(new Error('Azure DevOps rejected the token (sign-in page returned). Check AZDO_PAT.'), { status: 401 });
  if (!res.ok) {
    const msg = body.message || body.value?.Message || `HTTP ${res.status}`;
    const hint = res.status === 401 ? ' – token invalid or expired' : res.status === 403 ? ' – token lacks Work Items (Read & Write) scope or project access' : res.status === 404 ? ' – work item / project not found' : '';
    throw Object.assign(new Error(`Azure DevOps: ${msg}${hint}`), { status: res.status === 404 ? 404 : 502 });
  }
  return body;
}

async function workItem(id) {
  const w = await call(`${proj()}/_apis/wit/workitems/${id}?fields=System.Title,System.State,System.WorkItemType,System.AssignedTo&api-version=${API}`);
  return { id: w.id, title: w.fields['System.Title'], state: w.fields['System.State'], type: w.fields['System.WorkItemType'],
    assignedTo: (w.fields['System.AssignedTo'] || {}).displayName || '', url: `${proj()}/_workitems/edit/${w.id}` };
}

// Resolve the team leader (email or name) to an identity for a real @mention (sends them a notification).
async function findIdentity(who) {
  const r = await call(`${VSSPS}/_apis/identities?searchFilter=General&filterValue=${encodeURIComponent(who)}&queryMembership=None&api-version=${API}`);
  const list = (r.value || []).filter((i) => i.isActive !== false);
  if (!list.length) throw Object.assign(new Error(`Team leader "${who}" not found in Azure DevOps.`), { status: 404 });
  const i = list[0];
  return { id: i.id, name: i.providerDisplayName || i.customDisplayName || who };
}

async function post({ workItemId, teamLeader, comment, pdf, fileName }) {
  if (!configured()) throw Object.assign(new Error('Azure DevOps is not configured: start the server with AZDO_ORG_URL, AZDO_PROJECT and AZDO_PAT.'), { status: 412 });
  const id = Number(workItemId);
  if (!Number.isInteger(id) || id <= 0) throw Object.assign(new Error('Enter a valid work item number.'), { status: 400 });
  const wi = await workItem(id);                       // fails early if the item doesn't exist / no access
  const leader = teamLeader ? await findIdentity(teamLeader) : null;

  let attachment = null;
  if (pdf) {
    const up = await call(`${proj()}/_apis/wit/attachments?fileName=${encodeURIComponent(fileName)}&api-version=${API}`,
      { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pdf });
    await call(`${proj()}/_apis/wit/workitems/${id}?api-version=${API}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json-patch+json' },
      body: JSON.stringify([{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: up.url, attributes: { comment: 'Not-booked investigation report (NDC case investigator)' } } }]) });
    attachment = { url: up.url, fileName };
  }

  const mention = leader ? `<a href="#" data-vss-mention="version:2.0,${esc(leader.id)}">@${esc(leader.name)}</a> ` : '';
  const html = `<div>${mention}${esc(comment).replace(/\r?\n/g, '<br>')}</div>`
    + (attachment ? `<div><br>📎 Report: <a href="${esc(attachment.url)}?fileName=${encodeURIComponent(fileName)}">${esc(fileName)}</a> (also under Attachments)</div>` : '');
  const c = await call(`${proj()}/_apis/wit/workItems/${id}/comments?api-version=${API}-preview.4`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: html }) });
  return { workItem: wi, commentId: c.id, mentioned: leader ? leader.name : null, attachment };
}

// ---------------- My work: open items assigned to the token's user ----------------
const need = () => { if (!configured()) throw Object.assign(new Error('Azure DevOps is not configured: start with start.ps1 -Azure (AZDO_ORG_URL, AZDO_PROJECT, AZDO_PAT).'), { status: 412 }); };
const LIST_FIELDS = ['System.Id', 'System.Title', 'System.State', 'System.WorkItemType', 'System.IterationPath', 'System.AreaPath', 'System.ChangedDate',
  'System.CreatedDate', 'Microsoft.VSTS.Common.Priority', 'Microsoft.VSTS.Common.Severity', 'System.Tags', 'Microsoft.VSTS.Scheduling.RemainingWork', 'System.Parent'];

async function currentIteration() {
  const team = process.env.AZDO_TEAM || `${PROJECT} Team`;
  try {
    const r = await call(`${ORG}/${encodeURIComponent(PROJECT)}/${encodeURIComponent(team)}/_apis/work/teamsettings/iterations?$timeframe=current&api-version=${API}`);
    const it = (r.value || [])[0]; return it ? { path: it.path, name: it.name, start: it.attributes && it.attributes.startDate, end: it.attributes && it.attributes.finishDate } : null;
  } catch { return null; } // team name differs or no iterations: the page just does not mark the sprint
}

async function myItems() {
  need();
  const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND [System.AssignedTo] = @Me
    AND [System.State] NOT IN ('Closed', 'Done', 'Removed') ORDER BY [System.ChangedDate] DESC`;
  const [q, sprint] = await Promise.all([
    call(`${proj()}/_apis/wit/wiql?$top=200&api-version=${API}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: wiql }) }),
    currentIteration()]);
  const ids = (q.workItems || []).map((w) => w.id).slice(0, 200);
  const items = ids.length ? (await call(`${ORG}/_apis/wit/workitemsbatch?api-version=${API}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, fields: LIST_FIELDS }) })).value : [];
  return { org: ORG, project: PROJECT, sprint, items: items.map((w) => { const f = w.fields;
    return { id: w.id, title: f['System.Title'], state: f['System.State'], type: f['System.WorkItemType'], iteration: f['System.IterationPath'], area: f['System.AreaPath'],
      changed: f['System.ChangedDate'], created: f['System.CreatedDate'], priority: f['Microsoft.VSTS.Common.Priority'] || null, severity: f['Microsoft.VSTS.Common.Severity'] || null,
      tags: f['System.Tags'] || '', remaining: f['Microsoft.VSTS.Scheduling.RemainingWork'] ?? null, parent: f['System.Parent'] || null, url: `${proj()}/_workitems/edit/${w.id}` }; }) };
}

// Work item HTML -> plain text (the page never renders Azure HTML).
const htmlText = (h) => String(h || '').replace(/<(br|\/p|\/div|\/li|\/tr|\/h\d)[^>]*>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();

// vstfs:///Git/Commit/{project}%2F{repo}%2F{sha}, .../Git/PullRequestId/{project}%2F{repo}%2F{id}, .../Git/Ref/{project}%2F{repo}%2FGB{branch}
function parseArtifact(url) {
  const m = /^vstfs:\/\/\/Git\/(Commit|PullRequestId|Ref)\/(.+)$/i.exec(url || ''); if (!m) return null;
  const p = decodeURIComponent(m[2]).split('/'); if (p.length < 3) return null;
  const rest = p.slice(2).join('/'); // branch names may contain "/"
  return { kind: m[1].toLowerCase(), projectId: p[0], repoId: p[1], ref: m[1].toLowerCase() === 'ref' ? rest.replace(/^GB/, '') : rest };
}

async function itemDetail(id) {
  need();
  const w = await call(`${proj()}/_apis/wit/workitems/${Number(id)}?$expand=relations&api-version=${API}`);
  const f = w.fields;
  const comments = await call(`${proj()}/_apis/wit/workItems/${w.id}/comments?$top=30&order=desc&api-version=${API}-preview.4`).then((r) => r.comments || []).catch(() => []);
  const links = { prs: [], commits: [], branches: [], errors: [] };
  await Promise.all((w.relations || []).filter((r) => r.rel === 'ArtifactLink').map(async (r) => {
    const a = parseArtifact(r.url); if (!a) return;
    const base = `${ORG}/${a.projectId}/_apis/git/repositories/${a.repoId}`;
    try {
      if (a.kind === 'pullrequestid') {
        const pr = await call(`${base}/pullrequests/${a.ref}?api-version=${API}`);
        links.prs.push({ id: pr.pullRequestId, title: pr.title, status: pr.status, mergeStatus: pr.mergeStatus, source: (pr.sourceRefName || '').replace('refs/heads/', ''),
          target: (pr.targetRefName || '').replace('refs/heads/', ''), by: (pr.createdBy || {}).displayName, created: pr.creationDate, closed: pr.closedDate || null,
          repo: (pr.repository || {}).name, url: `${(pr.repository || {}).webUrl}/pullrequest/${pr.pullRequestId}`, mergeCommit: (pr.lastMergeCommit || {}).commitId || null });
      } else if (a.kind === 'commit') {
        const c = await call(`${base}/commits/${a.ref}?api-version=${API}`);
        links.commits.push({ hash: c.commitId, subject: (c.comment || '').split('\n')[0], author: (c.author || {}).name, date: (c.author || {}).date, changes: c.changeCounts || null, url: c.remoteUrl });
      } else links.branches.push({ name: a.ref, repoId: a.repoId });
    } catch (e) { links.errors.push(`${a.kind === 'pullrequestid' ? 'PR' : a.kind} ${a.ref}: ${e.message}${/lacks|403/.test(e.message) ? ' (the token needs Code: Read)' : ''}`); }
  }));
  return { id: w.id, title: f['System.Title'], state: f['System.State'], type: f['System.WorkItemType'], url: `${proj()}/_workitems/edit/${w.id}`,
    assignedTo: (f['System.AssignedTo'] || {}).displayName || '', createdBy: (f['System.CreatedBy'] || {}).displayName || '', iteration: f['System.IterationPath'],
    priority: f['Microsoft.VSTS.Common.Priority'] || null, severity: f['Microsoft.VSTS.Common.Severity'] || null, tags: f['System.Tags'] || '',
    description: htmlText(f['System.Description']), repro: htmlText(f['Microsoft.VSTS.TCM.ReproSteps']), systemInfo: htmlText(f['Microsoft.VSTS.TCM.SystemInfo']),
    acceptance: htmlText(f['Microsoft.VSTS.Common.AcceptanceCriteria']),
    comments: comments.map((c) => ({ by: (c.createdBy || {}).displayName, date: c.createdDate, text: htmlText(c.text) })), links };
}

module.exports = { post, workItem, myItems, itemDetail, htmlText, parseArtifact, configured, settings: () => ({ configured: configured(), org: ORG, project: PROJECT, teamLeader: process.env.AZDO_TEAM_LEADER || '' }) };
