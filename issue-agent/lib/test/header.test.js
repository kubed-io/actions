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
