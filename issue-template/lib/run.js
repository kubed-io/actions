// issue-template's two github-script steps: fetch the forms, then (after yq has made each
// one JSON) build the schema the run asked for.

const fs = require('fs');
const path = require('path');
const form = require('./form');

const DIR = '.github/ISSUE_TEMPLATE';

// where the forms live: left out, the organisation's .github; given empty, this repository
function repoOf(env, context) {
  const r = env.FORMS_REPO === '' ? `${context.repo.owner}/${context.repo.repo}` : env.FORMS_REPO;
  const [owner, repo] = r.split('/');
  if (!owner || !repo) throw new Error(`repo "${r}" is not owner/name`);
  return { owner, repo };
}

async function fetch({ github, context, core, env = process.env }) {
  const { owner, repo } = repoOf(env, context);
  const out = env.FORMS_DIR;
  fs.mkdirSync(out, { recursive: true });
  let list;
  try {
    ({ data: list } = await github.rest.repos.getContent({ owner, repo, path: DIR }));
  } catch (e) {
    if (e.status === 404) return core.setFailed(`${owner}/${repo} has no ${DIR}`);
    throw e;
  }
  const files = (Array.isArray(list) ? list : []).filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.name) && !/^config\.ya?ml$/.test(f.name));
  if (!files.length) return core.setFailed(`${owner}/${repo} has no issue forms in ${DIR}`);
  for (const f of files) {
    const { data } = await github.rest.repos.getContent({ owner, repo, path: f.path });
    fs.writeFileSync(path.join(out, f.name), Buffer.from(data.content, 'base64'));
  }
  core.info(`${files.length} forms from ${owner}/${repo}: ${files.map((f) => f.name).join(', ')}`);
}

function build({ core, env = process.env }) {
  const dir = env.FORMS_DIR;
  const forms = fs.readdirSync(dir).filter((n) => n.endsWith('.json'))
    .map((n) => ({ file: n.replace(/\.json$/, ''), form: JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')) }));
  const types = (env.TYPES || '').split(',').map((s) => s.trim()).filter(Boolean);
  let schema;
  let chosen = null;
  if (env.TEMPLATE || env.TYPE) {
    chosen = form.pick(forms, { template: env.TEMPLATE, type: env.TYPE });
    if (!chosen) return core.setFailed(`no form ${env.TEMPLATE ? `named ${env.TEMPLATE}` : `of type ${env.TYPE}`} among ${forms.map((f) => f.file).join(', ')}`);
    schema = form.toSchema(chosen.form);
  } else {
    schema = form.catalog(forms, types);
    if (!schema) return core.setFailed(`no form of type ${types.join(' or ')} among ${forms.map((f) => f.file).join(', ')}`);
  }
  // named by what it holds, so two calls in one job keep both
  const file = path.join(path.dirname(dir), `${chosen ? chosen.file : 'catalog'}.schema.json`);
  fs.writeFileSync(file, JSON.stringify(schema, null, 2));
  core.setOutput('schema', file);
  core.setOutput('template', chosen ? chosen.file.replace(/\.ya?ml$/, '') : '');
  core.setOutput('type', chosen?.form.type || '');
  core.setOutput('title_prefix', chosen?.form.title || '');
  const labels = chosen ? form.toIssue(chosen.form, {}).labels : [];
  core.setOutput('labels', labels.join(','));
  core.info(chosen ? `${chosen.file}: ${Object.keys(schema.properties).length} properties` : `catalog: ${schema.properties.sub_issues.items.properties.type.enum.join(', ')}`);
}

module.exports = { repoOf, fetch, build };
