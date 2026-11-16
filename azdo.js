// Azure DevOps: post the not-booked investigation to a work item for the team leader:
// 1) upload the PDF as a work-item attachment, 2) link it to the work item, 3) add a comment that @mentions the team leader.
// Config (env): AZDO_ORG_URL (https://dev.azure.com/<org>), AZDO_PROJECT, AZDO_PAT (scopes: Work Items Read & Write,
// Identity Read), optional AZDO_TEAM_LEADER (email), AZDO_VSSPS_URL (identity API host, derived from the org URL).
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

module.exports = { post, workItem, configured, settings: () => ({ configured: configured(), org: ORG, project: PROJECT, teamLeader: process.env.AZDO_TEAM_LEADER || '' }) };
