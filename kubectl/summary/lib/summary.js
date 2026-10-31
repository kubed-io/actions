// The step summary of a kubectl command: build as an accordion of kinds and resources,
// plan as a diff per resource, up as what changed. Anything else is its output as is.

const fs = require('fs');

const BUDGET = 900000; // GitHub caps a step summary at 1 MiB
const MAX_DOC = 60000; // one resource's YAML; CRDs run past it
const MAX_CONTEXT = 160; // diff context; the last-applied annotation is one enormous line
const OPEN_DIFFS = 3; // a plan this small shows its diffs open
const ERR_TAIL = 60;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unquote = (s) => (s || '').trim().replace(/^(['"])(.*)\1$/, '$2');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// a fence longer than any run of backticks inside, so the content cannot close it
function fenced(text, lang = '') {
  const runs = text.match(/`{3,}/g) || [];
  const fence = '`'.repeat(Math.max(3, ...runs.map((r) => r.length + 1)));
  return `${fence}${lang}\n${text.replace(/\n+$/, '')}\n${fence}`;
}

const details = (summary, body, open = false) => `<details${open ? ' open' : ''}><summary>${summary}</summary>\n\n${body}\n\n</details>`;

const read = (file) => {
  try { return file ? fs.readFileSync(file, 'utf8') : ''; } catch { return ''; }
};

// --- build ---------------------------------------------------------------------------

// The documents of a multi-document YAML, with kind, name and namespace read off their
// top-level lines: kustomize writes them plainly, so no YAML parser is needed.
function resources(yaml) {
  return yaml.split(/^---[ \t]*$/m)
    .map((d) => d.replace(/^\s*\n/, '').replace(/\s+$/, ''))
    .filter((d) => /^kind:/m.test(d))
    .map((doc) => {
      const meta = (doc.match(/^metadata:[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m) || [])[1] || '';
      const field = (text, re) => unquote((text.match(re) || [])[1]);
      return {
        kind: field(doc, /^kind:(.*)$/m),
        name: field(meta, /^ {2}name:(.*)$/m),
        namespace: field(meta, /^ {2}namespace:(.*)$/m),
        doc,
      };
    });
}

const where = (r) => (r.namespace ? `${r.namespace}/${r.name}` : r.name);

function build(text, budget) {
  const all = resources(text);
  if (!all.length) return text.trim() ? fenced(text, 'yaml') : 'Nothing built.';
  const kinds = new Map();
  for (const r of all) kinds.set(r.kind, [...(kinds.get(r.kind) || []), r]);

  const out = [`${plural(all.length, 'resource')} of ${plural(kinds.size, 'kind')}`];
  let left = 0;
  for (const [kind, list] of kinds) {
    const items = list.map((r) => {
      const label = `<code>${esc(where(r))}</code>`;
      if (r.doc.length > MAX_DOC) return details(label, `${plural(r.doc.split('\n').length, 'line')}, too long for the summary.`);
      const body = fenced(r.doc, 'yaml');
      if (!budget.take(body.length)) { left += 1; return `- ${label}`; }
      return details(label, body);
    });
    out.push(details(`<b>${esc(kind)}</b> · ${list.length}`, items.join('\n')));
  }
  if (left) out.push(`The summary is full: ${plural(left, 'resource')} listed without YAML.`);
  return out.join('\n\n');
}

// --- plan ----------------------------------------------------------------------------

// kubectl diff names each file <group>.<version>.<Kind>.<namespace>.<name>; the kind is
// the first segment that starts upper case, and a cluster-scoped namespace is empty.
function ident(path) {
  const base = path.split('/').pop();
  const m = base.match(/^(.*?)\.([A-Z][A-Za-z0-9]*)\.([^.]*)\.(.+)$/);
  return m ? { kind: m[2], namespace: m[3], name: m[4] } : { kind: '', namespace: '', name: base };
}

// kubectl plan's output: unified diffs, one per resource, then the prune list
function parsePlan(text) {
  const changes = [];
  const prunes = [];
  let cur = null;
  let pruning = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff ')) {
      cur = { ...ident(line.split(' ').pop()), lines: [] };
      changes.push(cur);
      pruning = false;
    } else if (line.startsWith('# Prune')) {
      cur = null;
      pruning = true;
    } else if (pruning) {
      const m = line.match(/^\s+- (.+)$/);
      if (m) prunes.push(m[1].trim());
    } else if (cur && (cur.lines.length || line.startsWith('@@'))) {
      cur.lines.push(line);
    }
  }
  for (const c of changes) {
    while (c.lines.length && !c.lines[c.lines.length - 1].trim()) c.lines.pop();
    c.created = /^@@ -0,0 /.test(c.lines[0] || '');
  }
  return { changes, prunes };
}

// Drops what every update carries: the generation bump, and context too long to read
// (the last-applied annotation). A hunk left with no change goes too.
function tidy(lines) {
  const hunks = [];
  for (const line of lines) {
    if (line.startsWith('@@') || !hunks.length) hunks.push([]);
    hunks[hunks.length - 1].push(line);
  }
  const kept = hunks
    .map((h) => h.filter((l) => !/^[-+] {2}generation: \d+$/.test(l))
      .map((l) => (l.startsWith(' ') && l.length > MAX_CONTEXT ? `${l.slice(0, MAX_CONTEXT)} …` : l)))
    .filter((h) => h.some((l) => /^[-+]/.test(l)));
  return kept.length ? kept.flat() : lines;
}

function plan(text) {
  const { changes, prunes } = parsePlan(text);
  const created = changes.filter((c) => c.created);
  const counts = `**${created.length}** to create · **${changes.length - created.length}** to update · **${prunes.length}** to prune`;
  if (!changes.length && !prunes.length) return text.trim() ? `No changes.\n\n${fenced(text)}` : 'No changes.';

  const out = [counts];
  const open = changes.length <= OPEN_DIFFS;
  for (const c of changes) {
    const mark = c.created ? '+' : '~';
    const label = `<code>${mark}</code> ${esc(c.kind)} <code>${esc(where(c))}</code>`;
    out.push(details(label, fenced(tidy(c.lines).join('\n'), 'diff'), open));
  }
  if (prunes.length) out.push(['Pruned by `up`:', '', ...prunes.map((p) => `- <code>-</code> <code>${esc(p)}</code>`)].join('\n'));
  return out.join('\n\n');
}

// --- up ------------------------------------------------------------------------------

const VERBS = ['created', 'configured', 'serverside-applied', 'pruned', 'deleted', 'unchanged'];

function up(text) {
  const done = {};
  const rest = [];
  for (const line of text.split('\n').filter((l) => l.trim())) {
    const m = line.match(/^(\S+) (\S+)(?: \(server dry run\))?$/);
    if (m && VERBS.includes(m[2])) (done[m[2]] = done[m[2]] || []).push(m[1]);
    else rest.push(line);
  }
  const verbs = VERBS.filter((v) => done[v]);
  if (!verbs.length) return text.trim() ? fenced(text) : 'No output.';

  const out = [verbs.map((v) => `**${done[v].length}** ${v}`).join(' · ')];
  const changed = verbs.filter((v) => v !== 'unchanged').flatMap((v) => done[v].map((r) => `- ${v} <code>${esc(r)}</code>`));
  if (changed.length) out.push(changed.join('\n'));
  if (done.unchanged) out.push(details(`${done.unchanged.length} unchanged`, done.unchanged.map((r) => `- <code>${esc(r)}</code>`).join('\n')));
  if (rest.length) out.push(details('The rest of the output', fenced(rest.join('\n'))));
  return out.join('\n\n');
}

// --- the summary ---------------------------------------------------------------------

function render({ cmd, args = '.', output = '', errors = '', outcome = 'success' }) {
  const title = `## \`kubectl ${[cmd, args && args !== '.' ? args : ''].filter(Boolean).join(' ')}\``;
  let left = BUDGET - title.length - 2000;
  const budget = { take: (n) => (n <= left ? ((left -= n), true) : false) };
  const failed = outcome && outcome !== 'success';

  const parts = [title];
  if (failed) {
    const tail = errors.trim().split('\n').slice(-ERR_TAIL).join('\n');
    parts.push(`**Failed** (${esc(outcome)})`);
    if (tail) parts.push(fenced(tail));
  }
  if (!failed || output.trim()) {
    const body = { build: () => build(output, budget), plan: () => plan(output), up: () => up(output) }[cmd];
    parts.push(body ? body() : (output.trim() ? fenced(output) : 'No output.'));
  }
  let md = parts.join('\n\n') + '\n';
  if (md.length > BUDGET) md = `${md.slice(0, BUDGET)}\n\n…cut short: the summary is full.\n`;
  return md;
}

async function run({ core, env = process.env }) {
  const md = render({ cmd: env.CMD, args: env.ARGS, output: read(env.OUTPUT_FILE), errors: read(env.ERROR_FILE), outcome: env.OUTCOME });
  await core.summary.addRaw(md).write();
}

module.exports = { run, render, resources, parsePlan, tidy, ident, fenced };
