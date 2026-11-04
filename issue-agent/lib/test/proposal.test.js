const test = require('node:test');
const assert = require('node:assert/strict');
const { render, parse, HEADING } = require('../proposal');

const ITEMS = [
  { type: 'Feature', title: 'Read plugin.json as Claude Code does', why: 'the parity the extension builds on' },
  { type: 'Bug', title: 'Agents --> clash on a name', why: '' },
];

test('a proposal is a heading, a box per item, and the items in a marker', () => {
  const block = render(ITEMS);
  assert.ok(block.startsWith(`${HEADING}\n\n- [ ] ✨ Feature: Read plugin.json as Claude Code does — the parity the extension builds on\n- [ ] 🐛 Bug: Agents --> clash on a name\n`));
  assert.ok(!/-->[^\n]*-->/.test(block.split('<!--')[1].replace(/ -->$/, '')), 'a title cannot close the marker early');
  assert.deepEqual(parse(block), { items: ITEMS, ticked: [false, false] });
});

test('nothing suggested, nothing rendered', () => {
  assert.equal(render([]), '');
  assert.equal(render(undefined), '');
  assert.equal(render([{ type: 'Feature' }]), '');
});

test('a tick reads back by position, inside the reply around it', () => {
  const body = `Here is the split.\n\n- [x] a task list of my own\n\n${render(ITEMS).replace('- [ ] 🐛', '- [x] 🐛')}`;
  assert.deepEqual(parse(body).ticked, [false, true]);
});

test('a body without a proposal, or with a broken marker, is none', () => {
  assert.equal(parse('just a reply'), null);
  assert.equal(parse('<!-- sub-issue-proposal {nope} -->'), null);
});
