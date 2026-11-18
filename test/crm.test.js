'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-test-'));
process.env.CRM_DATA_DIR = dir;
const crm = require('../lib/crm');

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('create, dedupe on import, update with history, notes', () => {
  const f = { cid: 'C1', ref: 'NDCEG-BR-1', reason: 'Reservation is already cancelled.', category: 'Supplier reservation already cancelled', agencyCode: 'AGN1', supplier: 'Galileo', time: '2026-11-16T10:00:00Z' };
  const a = crm.importFailures([f, f]);
  assert.equal(a.created, 1); assert.equal(a.skipped, 1);
  const again = crm.importFailures([f]); assert.equal(again.created, 0);
  const id = a.ids[0];
  const t = crm.update(id, { status: 'investigating', priority: 'urgent', tags: 'galileo, follow-up, galileo' });
  assert.equal(t.status, 'investigating'); assert.deepEqual(t.tags, ['galileo', 'follow-up']);
  assert.ok(t.history.some((h) => h.field === 'priority' && h.to === 'urgent'));
  crm.addNote(id, 'Called the agency');
  assert.equal(crm.get(id).notes.length, 1);
  assert.throws(() => crm.update(id, { status: 'bogus' }), /Unknown status/);
  crm.update(id, { status: 'resolved' }); assert.ok(crm.get(id).closedAt);
  crm.update(id, { status: 'investigating' }); assert.equal(crm.get(id).closedAt, null);
});

test('list: filters, search and pagination', () => {
  for (let i = 0; i < 30; i++) crm.create({ ref: 'NDCEG-BR-X' + i, agencyCode: i % 2 ? 'AGN2' : 'AGN3', priority: i < 3 ? 'urgent' : 'normal' });
  const p1 = crm.list({ size: 10, page: 1 }); const p4 = crm.list({ size: 10, page: 4 });
  assert.equal(p1.items.length, 10); assert.equal(p1.total, 31); assert.equal(p1.pages, 4); assert.equal(p4.items.length, 1);
  assert.equal(crm.list({ agency: 'AGN2' }).total, 15);
  assert.equal(crm.list({ q: 'ndceg-br-x29' }).total, 1);
  assert.equal(crm.list({ sort: 'priority', size: 5 }).items[0].priority, 'urgent');
  assert.ok(!('history' in p1.items[0]), 'list rows are light (no history/notes)');
  assert.throws(() => crm.create({}), /booking ref, PNR or correlation id/);
});

test('bulk update, overdue view, stats, persisted file', () => {
  const ids = crm.list({ size: 5 }).items.slice(0, 3).map((t) => t.id); // page size has a minimum of 5
  assert.equal(crm.bulk(ids, { status: 'waiting-supplier' }).updated, 3);
  crm.update(ids[0], { dueAt: '2020-01-01T00:00:00Z' });
  assert.equal(crm.list({ view: 'overdue' }).total, 1);
  const s = crm.stats(); assert.equal(s.overdue, 1); assert.equal(s.byStatus['waiting-supplier'], 3);
  crm.flush();
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'crm.json'), 'utf8'));
  assert.equal(onDisk.tickets.length, s.total);
  assert.ok(fs.readdirSync(path.join(dir, 'backups')).some((f) => /^crm-\d{4}-\d{2}-\d{2}\.json$/.test(f)), 'daily backup written');
});
