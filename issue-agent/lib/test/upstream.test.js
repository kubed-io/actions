const test = require('node:test');
const assert = require('node:assert/strict');
const { markerOf, noteOf, sameRef } = require('../upstream');

const CFG = { app: '235398881', owner: '4399427' };
const by = (id, body) => ({ user: { id }, body });

test('markerOf: the marker on an issue by the App or Dr K names the epic', () => {
  assert.deepEqual(markerOf(by(235398881, 'x\n<!-- upstream: kubed-io/quick-mcp#16 -->\n'), CFG),
    { repo: 'kubed-io/quick-mcp', number: 16, ref: 'kubed-io/quick-mcp#16' });
  assert.equal(markerOf(by(4399427, '<!-- upstream: kubed-io/quick-mcp#16 -->'), CFG).number, 16);
});

test("markerOf: a stranger's issue, a quoted or inline marker, two different markers are none", () => {
  assert.equal(markerOf(by(99, '<!-- upstream: kubed-io/quick-mcp#16 -->'), CFG), null);
  assert.equal(markerOf(by(235398881, '> <!-- upstream: kubed-io/quick-mcp#16 -->'), CFG), null);
  assert.equal(markerOf(by(235398881, 'see <!-- upstream: kubed-io/quick-mcp#16 --> here'), CFG), null);
  assert.equal(markerOf(by(235398881, '<!-- upstream: kubed-io/quick-mcp#16 -->\n<!-- upstream: kubed-io/quick-mcp#12 -->'), CFG), null);
});

test('markerOf: the same marker twice is still one; no body, no user or a zero number is none', () => {
  assert.equal(markerOf(by(235398881, '<!-- upstream: kubed-io/quick-mcp#16 -->\n<!-- upstream: Kubed-IO/quick-mcp#16 -->'), CFG).ref, 'kubed-io/quick-mcp#16');
  assert.equal(markerOf(by(235398881, null), CFG), null);
  assert.equal(markerOf({ body: '<!-- upstream: kubed-io/quick-mcp#16 -->' }, CFG), null);
  assert.equal(markerOf(by(235398881, '<!-- upstream: kubed-io/quick-mcp#0 -->'), CFG), null);
  assert.equal(markerOf(null, CFG), null);
});

test('sameRef: the repo is case-insensitive, the number exact', () => {
  assert.equal(sameRef('Kubed-IO/Quick-MCP#16', 'kubed-io/quick-mcp#16'), true);
  assert.equal(sameRef('kubed-io/quick-mcp#160', 'kubed-io/quick-mcp#16'), false);
  assert.equal(sameRef('kubed-io/quick-mcp-x#16', 'kubed-io/quick-mcp#16'), false);
  assert.equal(sameRef('', ''), false);
  assert.equal(sameRef(undefined, 'kubed-io/quick-mcp#16'), false);
});

test("noteOf: n8n's markers open the comment; anywhere else, or bad JSON, they are nothing", () => {
  assert.deepEqual(noteOf('<!-- upstream-release {"upstream": "kubed-io/quick-mcp#16", "version": "0.2.0", "final": true} -->\n🚀'),
    { kind: 'release', upstream: 'kubed-io/quick-mcp#16', version: '0.2.0', final: true });
  assert.equal(noteOf('hi\n<!-- upstream-message {"upstream": "kubed-io/quick-mcp#16"} -->'), null);
  assert.equal(noteOf('<!-- upstream-message {upstream} -->'), null);
});

test('noteOf: the message and the report markers', () => {
  assert.deepEqual(noteOf('<!-- upstream-message {"upstream": "kubed-io/quick-mcp#16"} -->\nKeep the tool name.'),
    { kind: 'message', upstream: 'kubed-io/quick-mcp#16' });
  assert.deepEqual(noteOf('<!-- downstream-report {"repo": "kubed-io/selenium-flow", "number": 210} -->\n📨'),
    { kind: 'report', repo: 'kubed-io/selenium-flow', number: 210 });
  // an rc note is not final; a note with no upstream is nothing
  assert.equal(noteOf('<!-- upstream-release {"upstream": "kubed-io/quick-mcp#16", "version": "0.2.0-rc.2", "final": false} -->').final, false);
  assert.equal(noteOf('<!-- upstream-release {"version": "0.2.0"} -->'), null);
  assert.equal(noteOf('<!-- downstream-report {"repo": "kubed-io/selenium-flow"} -->'), null);
  assert.equal(noteOf(''), null);
  assert.equal(noteOf(undefined), null);
});
