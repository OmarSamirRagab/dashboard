'use strict';
// Azure DevOps posting against a local mock of the REST API (no real Azure DevOps involved).
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

test('post: uploads the PDF, links it, and comments with an @mention', async () => {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = []; req.on('data', (d) => b.push(d)); req.on('end', () => {
      const body = Buffer.concat(b); calls.push({ m: req.method, u: req.url, auth: req.headers.authorization, ct: req.headers['content-type'], body });
      const j = (o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url.startsWith('/org/Proj/_apis/wit/workitems/123?fields')) return j({ id: 123, fields: { 'System.Title': 'Not booked bookings', 'System.State': 'Active', 'System.WorkItemType': 'Bug' } });
      if (req.url.startsWith('/vssps/_apis/identities')) return j({ value: [{ id: 'abc-guid', providerDisplayName: 'Team Leader', isActive: true }] });
      if (req.url.startsWith('/org/Proj/_apis/wit/attachments')) return j({ id: 'att1', url: 'http://mock/attachments/att1' });
      if (req.method === 'PATCH') return j({ id: 123 });
      if (req.url.startsWith('/org/Proj/_apis/wit/workItems/123/comments')) return j({ id: 77 });
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  Object.assign(process.env, { AZDO_ORG_URL: `${base}/org`, AZDO_PROJECT: 'Proj', AZDO_PAT: 'test-pat', AZDO_VSSPS_URL: `${base}/vssps` });
  delete require.cache[require.resolve('../azdo')];
  const azdo = require('../azdo');
  try {
    assert.equal(azdo.configured(), true);
    const r = await azdo.post({ workItemId: 123, teamLeader: 'tl@x.ae', comment: 'Line 1\n<b>2</b>', pdf: Buffer.from('%PDF-1.4 test'), fileName: 'r.pdf' });
    assert.equal(r.commentId, 77); assert.equal(r.mentioned, 'Team Leader'); assert.equal(r.attachment.fileName, 'r.pdf');
    assert.ok(calls.every((c) => c.auth === 'Basic ' + Buffer.from(':test-pat').toString('base64')), 'PAT sent as basic auth');
    const up = calls.find((c) => c.u.includes('/attachments')); assert.equal(up.ct, 'application/octet-stream'); assert.equal(up.body.toString(), '%PDF-1.4 test');
    const patch = calls.find((c) => c.m === 'PATCH'); assert.equal(patch.ct, 'application/json-patch+json');
    assert.equal(JSON.parse(patch.body)[0].value.rel, 'AttachedFile');
    const comment = JSON.parse(calls.find((c) => c.u.includes('/comments')).body).text;
    assert.match(comment, /data-vss-mention="version:2\.0,abc-guid"/);
    assert.ok(comment.includes('&lt;b&gt;2&lt;/b&gt;'), 'comment text is escaped'); assert.ok(comment.includes('<br>'));
    await assert.rejects(azdo.post({ workItemId: 'x', comment: 'c' }), /valid work item/);
  } finally { srv.close(); for (const k of ['AZDO_ORG_URL', 'AZDO_PROJECT', 'AZDO_PAT', 'AZDO_VSSPS_URL']) delete process.env[k]; }
});
