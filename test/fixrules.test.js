'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { suggestFor, statementAt, enclosingMethod, nullCandidates } = require('../fixrules');

const java = (s) => s.replace(/^\n/, '').split('\n');

test('statementAt spans continuation lines', () => {
  const L = java(`
class A {
    void f() {
        logHelper.logRequestINFO(x, ctx
                .add(K, user.getAgencyCode())
                .add(K2, user.getAgencyName()));
    }
}`);
  // 0-based: line 2 = logHelper..., lines 3-4 = .add(...) continuations
  const st = statementAt(L, 4);
  assert.equal(st.start, 2); assert.equal(st.end, 4);
});

test('enclosingMethod reads multi-line parameters', () => {
  const L = java(`
class A {
    private Dto toDto(
            Status responseStatus,
            int userId,
            String context
    ) {
        String a = responseStatus.getActionType().name();
    }
}`);
  const m = enclosingMethod(L, 7);
  assert.equal(m.name, 'toDto');
  assert.deepEqual(m.params, ['responseStatus', 'userId', 'context']);
});

test('nullCandidates finds receivers and getter chains, not strings', () => {
  const c = nullCandidates('log(dto.getA().getB().name(), "x.y()")');
  assert.ok(c.includes('dto')); assert.ok(c.includes('dto.getA()')); assert.ok(c.includes('dto.getA().getB()'));
});

test('stream lambda parameter NPE -> filter(Objects::nonNull) in the caller (high)', () => {
  const L = java(`
import java.util.List;
import java.util.stream.Collectors;
class S {
    public void log(List<Status> list, int userId, Ctx context) {
        List<Dto> out = list.stream()
                .map(r -> toDto(r, userId, context.name()))
                .collect(Collectors.toList());
    }
    private Dto toDto(
            Status responseStatus,
            int userId,
            String context
    ) {
        String actionType = responseStatus.getActionType() != null
                ? responseStatus.getActionType().name()
                : context.toUpperCase();
        return null;
    }
}`);
  const s = suggestFor({ type: 'NullPointerException', file: 'S.java', lines: L, frame: { simpleClass: 'S', methodName: 'toDto', lineNumber: 15 },
    caller: { file: 'S.java', lines: L, frame: { simpleClass: 'S', methodName: 'lambda$log$0', lineNumber: 7 } } });
  assert.equal(s[0].rule, 'npe-stream-filter'); assert.equal(s[0].confidence, 'high');
  assert.match(s[0].edits[0].replace, /\.filter\(Objects::nonNull\)/);
  assert.ok(s[0].edits.some((e) => /import java\.util\.Objects;/.test(e.replace)), 'adds the Objects import');
  assert.ok(!s.some((x) => /getActionType\(\) is null/.test(x.title)), 'does not guard a value the statement already null-checks');
});

test('session user NPE -> 401 UnAuthorizedException (high)', () => {
  const L = java(`
import java.util.Map;
class P {
    public Object get(Object req) {
        UserSessionBean userSessionBean = (UserSessionBean) req.getAttribute("U");
        logHelper.logRequestINFO(req, logContext
                .add(K, userSessionBean.getAgencyCode()));
        return userSessionBean.getAgentId();
    }
}`);
  const s = suggestFor({ type: 'NullPointerException', file: 'P.java', lines: L, frame: { simpleClass: 'P', methodName: 'get', lineNumber: 6 } });
  const top = s.find((x) => x.confidence === 'high');
  assert.equal(top.rule, 'npe-guard-unauthorized');
  assert.match(top.edits[0].replace, /throw new UnAuthorizedException/);
  const logOnly = s.find((x) => x.rule === 'npe-skip-logging');
  assert.equal(logOnly.confidence, 'low', 'value is used again later, so skipping the log is low confidence');
});

test('NumberFormatException -> NumberUtils with import', () => {
  const L = java(`
package a;
import java.util.List;
public class T {
    public int f(String s) {
        int n = Integer.parseInt(s.trim());
        return n;
    }
}`);
  // lineNumber is 1-based like a stack frame: line 5 = "int n = Integer.parseInt(...)"
  const s = suggestFor({ type: 'NumberFormatException', file: 'T.java', lines: L, frame: { simpleClass: 'T', methodName: 'f', lineNumber: 5 } });
  assert.equal(s[0].rule, 'nfe-safe-parse');
  assert.match(s[0].edits[0].replace, /NumberUtils\.toInt\(s\.trim\(\), 0\)/);
  assert.ok(s[0].edits.some((e) => /org\.apache\.commons\.lang3\.math\.NumberUtils/.test(e.replace)));
});
