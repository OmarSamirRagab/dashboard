'use strict';
// node --test  (Node 18+, no dependencies)
process.env.OSD_USER = process.env.OSD_USER || 'test'; process.env.OSD_PASS = process.env.OSD_PASS || 'test'; // lib/core exits without them
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTrace } = require('../lib/work');
const { htmlText, parseArtifact } = require('../azdo');

test('parseTrace finds the exception and picks the first odeysys frame below the loggers', () => {
  const t = parseTrace(`Steps: search CAI-DXB
java.lang.NullPointerException: fare is null
\tat com.tt.common.log.TTLog.error(TTLog.java:40)
\tat com.tt.ndc.AirSearchServiceImpl.mapFare(AirSearchServiceImpl.java:812)
\tat com.tt.ndc.AirSearchServiceImpl.search(AirSearchServiceImpl.java:120)
\tat org.springframework.web.servlet.FrameworkServlet.service(FrameworkServlet.java:897)`);
  assert.equal(t.type, 'NullPointerException'); assert.equal(t.fullType, 'java.lang.NullPointerException'); assert.equal(t.msg, 'fare is null');
  assert.equal(t.frames.length, 4); assert.equal(t.appFrames, 2);
  assert.deepEqual([t.top.className, t.top.methodName, t.top.fileName, t.top.lineNumber], ['com.tt.ndc.AirSearchServiceImpl', 'mapFare', 'AirSearchServiceImpl.java', 812]);
});

test('parseTrace: no trace -> null; exception without frames -> no top', () => {
  assert.equal(parseTrace('The button is misaligned on the search page'), null);
  const t = parseTrace('Got com.tt.exception.BookingException: Booking Has been failed!');
  assert.equal(t.type, 'BookingException'); assert.equal(t.top, null);
});

test('htmlText turns Azure HTML into text and never keeps tags', () => {
  assert.equal(htmlText('<div>Line&nbsp;1<br>a &lt;b&gt; &amp; c</div><ul><li>x</li><li>y</li></ul><script>alert(1)</script>'), 'Line 1\na <b> & c\n• x\n• y\nalert(1)');
  assert.equal(htmlText(null), '');
});

test('parseArtifact reads commit, PR and branch links (branch names with /)', () => {
  assert.deepEqual(parseArtifact('vstfs:///Git/Commit/p1%2Fr1%2Fabc123'), { kind: 'commit', projectId: 'p1', repoId: 'r1', ref: 'abc123' });
  assert.deepEqual(parseArtifact('vstfs:///Git/PullRequestId/p1%2Fr1%2F42'), { kind: 'pullrequestid', projectId: 'p1', repoId: 'r1', ref: '42' });
  assert.deepEqual(parseArtifact('vstfs:///Git/Ref/p1%2Fr1%2FGBfeature%2Fbug-64120'), { kind: 'ref', projectId: 'p1', repoId: 'r1', ref: 'feature/bug-64120' });
  assert.equal(parseArtifact('vstfs:///Build/Build/5'), null);
});
