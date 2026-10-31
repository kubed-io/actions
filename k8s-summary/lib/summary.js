// Kubernetes resources and their diffs as markdown, for a step summary or a comment. A
// summary is a list of sections, each a file shown as one of:
//   yaml       manifests: multi-document YAML, or a kubectl List (YAML or JSON), as an
//              accordion per kind and another per resource
//   names      resource names, one a line: apply or up output as the count of each verb with
//              the unchanged folded away, `get -o name` output grouped by kind
//   diff       kubectl diff or kubectl plan output: the counts, a diff per resource, the prunes
//   text       the output in a block, highlighted as `lang` when given
//   auto       whichever of those the content looks like

const fs = require('fs');
const path = require('path');
const os = require('os');

const BUDGET = 900000; // GitHub caps a step summary at 1 MiB
const MAX_DOC = 60000; // one resource; CRDs run past it
const MAX_CONTEXT = 160; // diff context; the last-applied annotation is one enormous line
const OPEN_DIFFS = 3; // a diff this small shows open
const ERR_TAIL = 60;
const TYPES = ['yaml', 'names', 'diff', 'text', 'auto'];

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

// --- yaml -----------------------------------------------------------------------

// kubectl get -o yaml wraps what it found in a List: each item starts `- ` at column 0
// under `items:`, the rest of it two spaces in
function listItems(doc) {
  const m = doc.match(/^items:[ \t]*\n((?:(?:- |  ).*(?:\n|$))*)/m);
  if (!m || !/^kind: List\s*$/m.test(doc)) return null;
  const items = [];
  for (const line of m[1].replace(/\n$/, '').split('\n')) {
    if (line.startsWith('- ')) items.push([]);
    if (items.length) items[items.length - 1].push(line.slice(2));
  }
  return items.map((l) => l.join('\n'));
}

function yamlResource(doc) {
  const meta = (doc.match(/^metadata:[ \t]*\n((?:[ \t]+.*(?:\n|$))*)/m) || [])[1] || '';
  const field = (text, re) => unquote((text.match(re) || [])[1]);
  return {
    kind: field(doc, /^kind:(.*)$/m),
    name: field(meta, /^ {2}name:(.*)$/m),
    namespace: field(meta, /^ {2}namespace:(.*)$/m),
    doc,
    lang: 'yaml',
  };
}

const jsonResource = (o) => ({
  kind: o.kind || '',
  name: (o.metadata && o.metadata.name) || '',
  namespace: (o.metadata && o.metadata.namespace) || '',
  doc: JSON.stringify(o, null, 2),
  lang: 'json',
});

// The resources in YAML documents or JSON, kind, name and namespace read off their
// top-level lines: kubectl and kustomize write them plainly, so no YAML parser is needed.
function resources(text) {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      const o = JSON.parse(t);
      const list = Array.isArray(o) ? o : Array.isArray(o.items) ? o.items : [o];
      return list.filter((x) => x && x.kind).map(jsonResource);
    } catch { /* not JSON after all */ }
  }
  return t.split(/^---[ \t]*$/m)
    .map((d) => d.replace(/^\s*\n/, '').replace(/\s+$/, ''))
    .filter((d) => /^kind:/m.test(d))
    .flatMap((d) => listItems(d) || [d])
    .map(yamlResource);
}

const where = (r) => (r.namespace ? `${r.namespace}/${r.name}` : r.name);

function showResources(text, budget) {
  const all = resources(text);
  if (!all.length) return text.trim() ? fenced(text) : 'Nothing found.';
  const kinds = new Map();
  for (const r of all) kinds.set(r.kind, [...(kinds.get(r.kind) || []), r]);

  const out = [`${plural(all.length, 'resource')} of ${plural(kinds.size, 'kind')}`];
  let left = 0;
  for (const [kind, list] of kinds) {
    const items = list.map((r) => {
      const label = `<code>${esc(where(r))}</code>`;
      if (r.doc.length > MAX_DOC) return details(label, `${plural(r.doc.split('\n').length, 'line')}, too long for the summary.`);
      const body = fenced(r.doc, r.lang);
      if (!budget.take(body.length)) { left += 1; return `- ${label}`; }
      return details(label, body);
    });
    out.push(details(`<b>${esc(kind)}</b> · ${list.length}`, items.join('\n')));
  }
  if (left) out.push(`The summary is full: ${plural(left, 'resource')} listed without the manifest.`);
  return out.join('\n\n');
}

// --- diff ----------------------------------------------------------------------------

// kubectl diff names each file <group>.<version>.<Kind>.<namespace>.<name>; the kind is
// the first segment that starts upper case, and a cluster-scoped namespace is empty.
function ident(file) {
  const base = file.split('/').pop();
  const m = base.match(/^(.*?)\.([A-Z][A-Za-z0-9]*)\.([^.]*)\.(.+)$/);
  return m ? { kind: m[2], namespace: m[3], name: m[4] } : { kind: '', namespace: '', name: base };
}

// unified diffs, one per resource, then kubectl plan's prune list
function parseDiff(text) {
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

function showDiff(text, budget) {
  const { changes, prunes } = parseDiff(text);
  if (!changes.length && !prunes.length) return text.trim() ? `No changes.\n\n${fenced(text)}` : 'No changes.';
  const created = changes.filter((c) => c.created).length;
  const out = [`**${created}** to create · **${changes.length - created}** to update · **${prunes.length}** to prune`];
  const open = changes.length <= OPEN_DIFFS;
  for (const c of changes) {
    const label = `<code>${c.created ? '+' : '~'}</code> ${esc(c.kind)} <code>${esc(where(c))}</code>`;
    const body = fenced(tidy(c.lines).join('\n'), 'diff');
    out.push(budget.take(body.length) ? details(label, body, open) : `- ${label}`);
  }
  if (prunes.length) out.push(['Pruned by `up`:', '', ...prunes.map((p) => `- <code>-</code> <code>${esc(p)}</code>`)].join('\n'));
  return out.join('\n\n');
}

// --- names -------------------------------------------------------------------------

// kubectl's one-line-per-resource output: `kind/name`, as from `get -o name`, or
// `kind/name verb` as from apply and up
const VERBS = ['created', 'configured', 'serverside-applied', 'pruned', 'deleted', 'unchanged'];
const NAME_LINE = new RegExp(`^([^\\s/]+)/(\\S+)(?: (${VERBS.join('|')}))?(?: \\(server dry run\\))?$`);

function showNames(text) {
  const named = [];
  const rest = [];
  for (const line of text.split('\n').filter((l) => l.trim())) {
    const m = line.trim().match(NAME_LINE);
    if (m) named.push({ kind: m[1], name: m[2], verb: m[3], id: `${m[1]}/${m[2]}` });
    else rest.push(line);
  }
  if (!named.length) return text.trim() ? fenced(text) : 'No output.';
  const out = [];

  const done = {};
  for (const n of named.filter((x) => x.verb)) (done[n.verb] = done[n.verb] || []).push(n.id);
  const verbs = VERBS.filter((v) => done[v]);
  if (verbs.length) {
    out.push(verbs.map((v) => `**${done[v].length}** ${v}`).join(' · '));
    const changed = verbs.filter((v) => v !== 'unchanged').flatMap((v) => done[v].map((r) => `- ${v} <code>${esc(r)}</code>`));
    if (changed.length) out.push(changed.join('\n'));
    if (done.unchanged) out.push(details(`${done.unchanged.length} unchanged`, done.unchanged.map((r) => `- <code>${esc(r)}</code>`).join('\n')));
  }

  const bare = named.filter((x) => !x.verb);
  if (bare.length) {
    const kinds = new Map();
    for (const n of bare) kinds.set(n.kind, [...(kinds.get(n.kind) || []), n.name]);
    out.push(`${plural(bare.length, 'resource')} of ${plural(kinds.size, 'kind')}`);
    for (const [kind, list] of kinds) out.push(details(`<b>${esc(kind)}</b> · ${list.length}`, list.map((x) => `- <code>${esc(x)}</code>`).join('\n')));
  }
  if (rest.length) out.push(details('The rest of the output', fenced(rest.join('\n'))));
  return out.join('\n\n');
}

// --- sections ------------------------------------------------------------------------

function detect(text) {
  if (/^diff /m.test(text) || /^# Prune/m.test(text)) return 'diff';
  if (resources(text).length) return 'yaml';
  const lines = text.split('\n').filter((l) => l.trim());
  if (lines.length && lines.filter((l) => NAME_LINE.test(l.trim())).length * 2 > lines.length) return 'names';
  return 'text';
}

const SHOW = {
  yaml: showResources,
  names: showNames,
  diff: showDiff,
  text: (t, _, lang = '') => (t.trim() ? fenced(t, lang) : 'No output.'),
};

// The sections input: a YAML list of flat mappings, or JSON. The YAML takes one
// `key: value` per line, a `- ` starting each section.
function parseSections(text) {
  const t = (text || '').trim();
  if (!t) return [];
  if (t.startsWith('[')) return JSON.parse(t);
  const list = [];
  for (const raw of t.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const m = raw.match(/^\s*(- )?([\w-]+):(.*)$/);
    if (!m) throw new Error(`sections: cannot read "${raw.trim()}"`);
    if (m[1] || !list.length) list.push({});
    list[list.length - 1][m[2]] = unquote(m[3]);
  }
  return list;
}

function section(s, budget) {
  const type = s.type || 'auto';
  if (!TYPES.includes(type)) throw new Error(`k8s-summary: type "${type}" is not one of ${TYPES.join(', ')}`);
  const output = s.content !== undefined ? s.content : read(s.file);
  const parts = s.title ? [`### ${esc(s.title)}`] : [];
  if (s.outcome === 'skipped') return [...parts, 'Skipped.'].join('\n\n');
  const failed = s.outcome && s.outcome !== 'success';
  if (failed) {
    const tail = read(s.error_file).trim().split('\n').slice(-ERR_TAIL).join('\n');
    parts.push(`**Failed** (${esc(s.outcome)})`);
    if (tail) parts.push(fenced(tail));
    if (!output.trim()) return parts.join('\n\n');
  }
  parts.push(SHOW[type === 'auto' ? detect(output) : type](output, budget, s.lang));
  return parts.join('\n\n');
}

function render({ title = '', sections = [] }) {
  let left = BUDGET - 2000;
  const budget = { take: (n) => (n <= left ? ((left -= n), true) : false) };
  const parts = title ? [`## ${esc(title)}`] : [];
  for (const s of sections) parts.push(section(s, budget));
  let md = parts.join('\n\n') + '\n';
  if (md.length > BUDGET) md = `${md.slice(0, BUDGET)}\n\n…cut short: the summary is full.\n`;
  return md;
}

// the single-section inputs, then the sections list after them
function fromEnv(env) {
  const sections = [];
  if (env.FILE || env.CONTENT) {
    sections.push({ title: env.SECTION_TITLE, type: env.TYPE, lang: env.LANG_HINT, file: env.FILE, content: env.CONTENT || undefined, error_file: env.ERROR_FILE, outcome: env.OUTCOME });
  }
  return { title: env.TITLE, sections: [...sections, ...parseSections(env.SECTIONS)] };
}

async function run({ core, env = process.env }) {
  const md = render(fromEnv(env));
  const out = path.join(env.RUNNER_TEMP || os.tmpdir(), `k8s-summary-${Date.now()}.md`);
  fs.writeFileSync(out, md);
  core.setOutput('markdown_file', out);
  if (env.WRITE !== 'false') await core.summary.addRaw(md).write();
}

module.exports = { run, render, fromEnv, parseSections, resources, parseDiff, tidy, ident, detect, fenced };
