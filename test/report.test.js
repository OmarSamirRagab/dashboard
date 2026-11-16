'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { renderHtml, renderTableHtml } = require('../report');

test('table report escapes HTML in values', () => {
  const html = renderTableHtml({ title: 'T <b>', columns: [{ key: 'm', label: 'Message' }], rows: [{ m: '<script>alert(1)</script> & "x"' }] });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;'));
  assert.ok(html.includes('T &lt;b&gt;'));
});

test('table report formats time columns in the given timezone', () => {
  const html = renderTableHtml({ tz: 'Africa/Cairo', columns: [{ key: 't', label: 'Time', time: true }], rows: [{ t: '2026-11-16T10:00:00Z' }] });
  assert.ok(html.includes('2026-11-16 12:00:00'), 'UTC 10:00 is 12:00 in Cairo');
});

test('cases report shows verdict labels and not-found refs', () => {
  const html = renderHtml({ title: 'X', tz: 'UTC', searched: 2, rows: [{ ref: 'NDCEG-BR-1', kind: 'not-booked-bm', verdict: 'Not booked', focus: { steps: [{ step: 'bookAndPay', state: 'ok', detail: 'called' }] } }],
    notFound: [{ ref: 'NDCEG-BR-2' }] });
  assert.ok(html.includes('Not booked · Banque Misr'));
  assert.ok(html.includes('Not found (1)'));
  assert.ok(html.includes('NDCEG-BR-2'));
});
