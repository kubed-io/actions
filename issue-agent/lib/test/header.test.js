const test = require('node:test');
const assert = require('node:assert/strict');
const { fillHeader } = require('../header');

test('names fill from the values, any depth; a missing one renders empty', () => {
  const values = { output: { plan: { path: 'docs/p.md' } }, run_url: 'https://run', number: '81' };
  assert.equal(fillHeader('📄 {{ output.plan.path }} · [run]({{run_url}}) · #{{ number }}', values), '📄 docs/p.md · [run](https://run) · #81');
  assert.equal(fillHeader('a {{ output.nope }} b', values), 'a  b');
  assert.equal(fillHeader('{{ output.plan }}', values), '');
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
  assert.equal(fillHeader('[n]({{ link:output.nope }})', values, { link }), '[n]()');
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
