const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const io = require('../io');

test('the client pages through comments and carries GitHub\'s status on an error', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    seen.push(`${init.method} ${url}`);
    if (init.method === 'PATCH') return { ok: false, status: 404, text: async () => 'Not Found' };
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, json: async () => (page === 1 ? Array(100).fill({ id: 1 }) : [{ id: 2 }]) };
  });
  const github = io.client('tok', { GITHUB_API_URL: 'https://api' });
  const all = await github.paginate(github.rest.issues.listComments, { owner: 'o', repo: 'r', issue_number: 3, per_page: 100 });
  assert.equal(all.length, 101);
  assert.deepEqual(seen, ['GET https://api/repos/o/r/issues/3/comments?per_page=100&page=1', 'GET https://api/repos/o/r/issues/3/comments?per_page=100&page=2']);
  await assert.rejects(github.rest.issues.updateComment({ owner: 'o', repo: 'r', comment_id: 9, body: 'x' }), (e) => e.status === 404);
});

test('outputs and state are delimited blocks in the runner\'s files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'io-'));
  const env = { GITHUB_OUTPUT: path.join(dir, 'out'), GITHUB_STATE: path.join(dir, 'state') };
  const core = io.core(env);
  core.setOutput('comment_id', '55');
  core.saveState('dir', '/t/issue-comment/12');
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /^comment_id<<(ghadelimiter_[\w-]+)\n55\n\1\n$/);
  assert.match(fs.readFileSync(env.GITHUB_STATE, 'utf8'), /^dir<<(ghadelimiter_[\w-]+)\n\/t\/issue-comment\/12\n\1\n$/);
  assert.deepEqual(io.context({ GITHUB_REPOSITORY: 'kubed-io/redis', GITHUB_RUN_ID: '7' }), { repo: { owner: 'kubed-io', repo: 'redis' }, runId: 7 });
});
