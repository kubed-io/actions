const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const comment = require('../comment');
const parts = require('../parts');
const agent = require('../../../issue-agent/lib/comment');
const state = require('../../../issue-agent/lib/state');
const fake = require('../../../issue-agent/lib/test/fake');

const RUN = 'https://github.com/kubed-io/selenium-flow/actions/runs/7';
const APP = { login: 'kubed-io[bot]', type: 'Bot' };

// a thread GitHub keeps: comments made, edited and deleted, in time order
function thread() {
  const comments = [];
  let id = 100;
  let clock = 0;
  const find = (p) => {
    const c = comments.find((x) => x.id === p.comment_id);
    if (!c) throw Object.assign(new Error('Not Found'), { status: 404 });
    return c;
  };
  const make = (body) => {
    const c = { id: (id += 1), user: APP, body, created_at: `2026-11-03T10:00:${String((clock += 1)).padStart(2, '0')}Z` };
    comments.push(c);
    return c;
  };
  const t = { comments, make };
  const github = fake.github({
    'issues.createComment': (p) => make(p.body),
    'issues.updateComment': (p) => {
      if (t.beforeEdit) t.beforeEdit(p);
      return Object.assign(find(p), { body: p.body });
    },
    'issues.deleteComment': (p) => comments.splice(comments.indexOf(find(p)), 1) && null,
    'issues.listComments': () => [...comments],
  });
  // what n8n does under an in-flight reply: the placeholder again, below it, the old one gone
  const move = (from) => {
    const old = comments.find((c) => c.id === from);
    const copy = make(old.body);
    comments.splice(comments.indexOf(old), 1);
    return copy.id;
  };
  return Object.assign(t, { github, move });
}

function env(over = {}) {
  return { RUNNER_TEMP: fs.mkdtempSync(path.join(os.tmpdir(), 'comment-')), INPUT_NUMBER: '12', INPUT_RUN_URL: RUN, ...over };
}

const context = fake.context({ runId: 7 });

test('one part and one session read exactly as issue-agent\'s reply', () => {
  const seen = { key: 'issue-12', through: 't', id: '9' };
  const body = comment.answerBody({ texts: [agent.answer({ header: '📄 Plan', text: 'Done.\n' })], runUrl: RUN, seen: [{ ...seen, answered: 'x' }] });
  assert.equal(body, agent.reply({ header: '📄 Plan', text: 'Done.', runUrl: RUN, seen }));
});

test('parts join in order; every session\'s marker is read back from the trailing group', () => {
  const seen = [{ key: 'plan', through: 't1', id: '1' }, { key: 'code', through: 't2', id: '2' }];
  const body = comment.answerBody({ texts: ['Planned.', 'Built.', '> [!WARNING]\n> **Not committed:** `x`.'], runUrl: RUN, seen });
  assert.ok(body.startsWith(`${state.TAG}\nPlanned.\n\nBuilt.\n\n> [!WARNING]`));
  assert.ok(body.includes(`<sub>[Run](${RUN})</sub>\n${state.seenMarker(seen[0])}\n${state.seenMarker(seen[1])}`));
  assert.deepEqual(state.readSeenFor(body, 'plan'), seen[0]);
  assert.deepEqual(state.readSeenFor(body, 'code'), seen[1]);
  assert.equal(state.readSeenFor(body, 'other'), null);
});

test('the failure note keeps what finished, with its markers; with nothing, it is issue-agent\'s', () => {
  assert.equal(comment.failureBody({ prompt: 'Go', texts: [], runUrl: RUN, seen: [] }), agent.failure({ prompt: 'Go', runUrl: RUN }));
  const body = comment.failureBody({ prompt: '', texts: ['Planned.'], runUrl: RUN, seen: [{ key: 'plan', through: 't1', id: '1' }] });
  assert.ok(body.startsWith(`${state.TAG}\nPlanned.\n\n⚠️ I didn't finish this one.`));
  assert.deepEqual(state.readSeenFor(body, 'plan'), { key: 'plan', through: 't1', id: '1' });
});

test('start posts issue-agent\'s live placeholder and says where; end writes the parts where n8n moved it', async () => {
  const t = thread();
  const e = env({ INPUT_PROMPT: '' });
  const core = fake.core();
  core.saveState = (k, v) => { e[`STATE_${k}`] = v; };
  await comment.start({ github: t.github, context, core, env: e });
  const first = Number(core.outputs.comment_id);
  assert.equal(t.comments[0].body, agent.placeholder({ runUrl: RUN, runId: 7 }));
  assert.equal(core.outputs.number, '12');
  assert.equal(e.STATE_dir, parts.dirOf(e, 12));

  const dir = parts.dirOf(e, 12);
  parts.addPart(dir, 'issue-agent', 'First.');
  t.make(`${state.TAG}\nan in-flight reply`);
  const moved = t.move(first);
  parts.addPart(dir, 'issue-agent', 'Second.');
  parts.addSeen(dir, { key: 'k', through: 't', id: '3' });

  const out = fake.core();
  await comment.end({ github: t.github, context, core: out, env: e });
  assert.equal(out.outputs.comment_id, String(moved));
  const written = t.comments.find((c) => c.id === moved);
  assert.ok(written.body.startsWith(`${state.TAG}\nFirst.\n\nSecond.`));
  assert.equal(state.readPlaceholder(written.body), null);
  assert.equal(parts.isFinal(dir), true);

  // the job ends: start's post leaves the written comment alone
  const before = t.github.calls.length;
  await comment.post({ github: t.github, context, core: fake.core(), env: e });
  assert.equal(t.github.calls.length, before);
});

test('a comment without the run\'s marker is ended by its id', async () => {
  const t = thread();
  const e = env({ INPUT_LIVE: 'false' });
  const core = fake.core();
  core.saveState = () => {};
  await comment.start({ github: t.github, context, core, env: e });
  assert.equal(state.readPlaceholder(t.comments[0].body), null);
  parts.addPart(parts.dirOf(e, 12), 'issue-agent', 'Done.');
  await comment.end({ github: t.github, context, core: fake.core(), env: e });
  assert.ok(t.comments[0].body.includes('Done.'));
});

test('end with no part takes the spinner down and writes nothing', async () => {
  const t = thread();
  const e = env();
  const core = fake.core();
  core.saveState = () => {};
  await comment.start({ github: t.github, context, core, env: e });
  const out = fake.core();
  await comment.end({ github: t.github, context, core: out, env: e });
  assert.equal(t.comments.length, 0);
  assert.equal(out.outputs.comment_id, '');
});

test('n8n moves it between the lookup and the edit: once more; with none left, a new comment', async () => {
  const t = thread();
  const e = env();
  const core = fake.core();
  core.saveState = () => {};
  await comment.start({ github: t.github, context, core, env: e });
  parts.addPart(parts.dirOf(e, 12), 'issue-agent', 'Done.');
  // the lookup sees the old one, which is gone by the edit
  let moved = 0;
  t.beforeEdit = (p) => { if (!moved) moved = t.move(p.comment_id); };
  const out = fake.core();
  await comment.end({ github: t.github, context, core: out, env: e });
  assert.equal(t.comments.length, 1);
  assert.equal(out.outputs.comment_id, String(moved));
  assert.ok(t.comments[0].body.includes('Done.'));
  assert.equal(t.github.calls.filter((c) => c.name === 'issues.updateComment').length, 2);

  const gone = thread();
  const e2 = env();
  parts.open(parts.dirOf(e2, 12), { comment_id: 999, number: 12, run_url: RUN });
  parts.addPart(parts.dirOf(e2, 12), 'issue-agent', 'Done.');
  await comment.end({ github: gone.github, context, core: fake.core(), env: e2 });
  assert.equal(gone.comments.length, 1);
});

test('without comment/end, start\'s post turns the comment into the failure note; a second end is refused', async () => {
  const t = thread();
  const e = env({ INPUT_PROMPT: 'Plan it' });
  const core = fake.core();
  core.saveState = (k, v) => { e[`STATE_${k}`] = v; };
  await comment.start({ github: t.github, context, core, env: e });
  const dir = parts.dirOf(e, 12);
  parts.addPart(dir, 'issue-agent', 'Planned.');
  parts.addSeen(dir, { key: 'plan', through: 't1', id: '1' });
  const out = fake.core();
  await comment.post({ github: t.github, context, core: out, env: e });
  const body = t.comments[0].body;
  assert.ok(body.startsWith(`${state.TAG}\n> Plan it\n\nPlanned.\n\n⚠️ I didn't finish this one.`));
  assert.deepEqual(state.readSeenFor(body, 'plan'), { key: 'plan', through: 't1', id: '1' });
  assert.equal(out.notices.length, 1);

  parts.finalize(dir, 1);
  await assert.rejects(comment.end({ github: t.github, context, core: fake.core(), env: e }), /already written/);
  await assert.rejects(comment.end({ github: t.github, context, core: fake.core(), env: env({ INPUT_NUMBER: '13' }) }), /no comment\/start/);
});

test('post with no state (start never posted) does nothing', async () => {
  const github = fake.github();
  await comment.post({ github, context, core: fake.core(), env: env() });
  assert.equal(github.calls.length, 0);
});
