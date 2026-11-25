const test = require('node:test');
const assert = require('node:assert/strict');
const { fillHeader } = require('../header');

test('names fill from the values, any depth; a missing one renders empty', () => {
  const values = { output: { plan: { path: 'docs/p.md' } }, run_url: 'https://run', number: '81' };
  assert.equal(fillHeader('📄 {{ output.plan.path }} · [run]({{run_url}}) · #{{ number }}', values), '📄 docs/p.md · [run](https://run) · #81');
  assert.equal(fillHeader('a {{ output.nope }} b {{ output.plan.path }}', values), 'a  b docs/p.md');
  assert.equal(fillHeader('{{ output.plan }}', values), '');
  assert.equal(fillHeader('a {{ number }} b', values), 'a 81 b');
});

test('a header drawn from the output is left off when the output gave none of its fields', () => {
  // a review without a verdict posts no "**Verdict: **" (spec 2026-11-24 R-SM37)
  assert.equal(fillHeader('**Verdict: {{ output.verdict }}**', { output: undefined }), '');
  assert.equal(fillHeader('**Verdict: {{ output.verdict }}**', { output: {} }), '');
  assert.equal(fillHeader('**Verdict: {{ output.verdict }}**', { output: { verdict: '' } }), '');
  const family = '**Verdict: {{ output.verdict }}**\n\n<!-- review-summary -->\n{{ output.summary }}\n<!-- /review-summary -->';
  assert.equal(fillHeader(family, { output: null }), '');
  assert.equal(fillHeader('📄 Plan · [{{ output.plan_path }}]({{ link:output.plan_path }}) · {{ number }}', { output: {}, number: '7' }), '');
  // one field is enough to keep it
  assert.equal(fillHeader('**Verdict: {{ output.verdict }}**', { output: { verdict: 'looks good' } }), '**Verdict: looks good**');
  assert.match(fillHeader(family, { output: { summary: 'x' } }), /^\*\*Verdict: \*\*/);
});

test('no template, no header', () => {
  assert.equal(fillHeader('', {}), '');
  assert.equal(fillHeader('   ', {}), '');
});

const { linkTo, wikisOf } = require('../header');

test('{{ link:<field> }} links a file: the wiki page for one in a wiki submodule, else the blob', () => {
  const link = linkTo({ blob: 'https://github.com/o/r/blob/abc', wikis: wikisOf('[submodule "docs"]\n\tpath = docs\n\turl = https://github.com/o/r.wiki.git\n') });
  const values = { output: { plan_path: 'docs/superpowers/plans/2026-10-29-x.md', other: 'src/a.py' } };
  assert.equal(fillHeader('[p]({{ link:output.plan_path }})', values, { link }), '[p](https://github.com/o/r/wiki/2026-10-29-x)');
  assert.equal(fillHeader('[a]({{link:output.other}})', values, { link }), '[a](https://github.com/o/r/blob/abc/src/a.py)');
  assert.equal(fillHeader('[n]({{ link:output.nope }}) [p]({{ link:output.plan_path }})', values, { link }), '[n]() [p](https://github.com/o/r/wiki/2026-10-29-x)');
  // with no field of the output at all, no header
  assert.equal(fillHeader('[n]({{ link:output.nope }})', values, { link }), '');
});

test('wikisOf: only submodules whose url is a wiki; none without .gitmodules', () => {
  const text = '[submodule "docs"]\n\tpath = docs\n\turl = https://github.com/o/r.wiki.git\n[submodule "lib"]\n\tpath = vendor/lib\n\turl = https://github.com/o/lib.git\n';
  assert.deepEqual(wikisOf(text), [{ path: 'docs', base: 'https://github.com/o/r/wiki' }]);
  assert.deepEqual(wikisOf(''), []);
  assert.deepEqual(wikisOf('[submodule "w"]\n\tpath = w\n\turl = git@github.com:o/r.wiki.git\n'), [{ path: 'w', base: 'https://github.com/o/r/wiki' }]);
});

test('without a link function, {{ link:x }} renders the plain value', () => {
  assert.equal(fillHeader('{{ link:number }}', { number: '7' }), '7');
});
