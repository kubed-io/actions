const test = require('node:test');
const assert = require('node:assert/strict');
const accept = require('../accept');
const { render } = require('../proposal');
const fake = require('./fake');

const DRK = 4399427;
const APP = 235398881;
const ENV = { OWNER_ID: String(DRK), APP_ID: String(APP) };
const ITEMS = [{ type: 'Feature', title: 'Parity first', why: 'the base' }, { type: 'Bug', title: 'A clash', why: '' }];
const URL5 = 'https://api.github.com/repos/kubed-io/selenium-flow/issues/5';
const PARENT = 'GET /repos/{owner}/{repo}/issues/{issue_number}/parent';

function go({ ticked = 1, item = 1, actor = DRK, author = APP, state = 'open', parent, issueUrl = URL5 } = {}) {
  const body = `The split.\n\n${render(ITEMS)}`.replace(ticked === 1 ? '- [ ] 🐛' : '- [ ] ✨', ticked === 1 ? '- [x] 🐛' : '- [x] ✨');
  const github = fake.github({
    'issues.getComment': { id: 77, user: { id: author }, issue_url: issueUrl, body },
    'issues.get': { number: 5, state },
    [PARENT]: ({ issue_number: n }) => (n === 5 && parent ? { number: parent } : Object.assign(new Error('none'), { status: 404 })),
  });
  const core = fake.core();
  const payload = { client_payload: { number: 5, comment_id: 77, item, actor } };
  return accept.run({ github, context: fake.context({ eventName: 'repository_dispatch', payload }), core, env: ENV }).then(() => core.outputs);
}

test("the owner's tick on the App's proposal is the item, filed under this issue", async () => {
  assert.deepEqual(await go(), { ok: 'true', number: '5', parent: '5', family: '5', type: 'Bug', title: 'A clash', why: '' });
});

test("on a sub-issue the suggestion is a sibling: filed under that issue's parent", async () => {
  const out = await go({ parent: 3 });
  assert.deepEqual([out.parent, out.family], ['3', '3']);
});

test('anyone else, another author, another thread, an unticked box or a closed issue: nothing', async () => {
  for (const over of [{ actor: 12345 }, { author: 12345 }, { issueUrl: URL5.replace(/5$/, '6') }, { ticked: 0 }, { item: 4 }, { state: 'closed' }]) {
    assert.equal((await go(over)).ok, 'false', JSON.stringify(over));
  }
});
