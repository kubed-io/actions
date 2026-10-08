// Document rounds. When the structured output carries a whole document (`spec`, `plan`),
// each run that returns it makes a round: an artifact (the only copy until approval),
// the job summary (where it is read), a state block in the thread's body, and a header
// on the reply.

const fs = require('fs');
const path = require('path');
const { readState, writeSection } = require('./state');
const { fill } = require('./util');

// the step summary's limit is 1 MiB; leave room for the heading and the note
const SUMMARY_LIMIT = 1024 * 1024 - 4096;

function slugify(text) {
  return (text || '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').split('-').slice(0, 6).join('-') || 'untitled';
}

function label(document) {
  return document.charAt(0).toUpperCase() + document.slice(1);
}

function header(state, document, updated) {
  return `📄 **${label(document)}** · round ${state.round}${updated ? ' (updated in this reply)' : ''} · [read](${state.summary_url}) · [download](${state.artifact_url})`;
}

function links(state, document) {
  const approved = state.approved ? ` · approved: \`${state.path}\` on \`${state.branch}\`` : '';
  return `${label(document)}, round ${state.round}: [read](${state.summary_url}) · [download](${state.artifact_url})${approved}`;
}

function summary(document, title, n, text) {
  const head = `# ${label(document)} · ${title} · round ${n}\n\n`;
  const bytes = Buffer.byteLength(text);
  if (bytes <= SUMMARY_LIMIT) return head + text;
  const cut = Buffer.from(text).subarray(0, SUMMARY_LIMIT).toString('utf8');
  return `${head}${cut}\n\n---\n\n_Cut at 1 MiB: the artifact has all ${bytes} bytes._\n`;
}

function nextState(prev, { structured, document, template, title, number, date, run, artifact, artifactUrl, summaryUrl }) {
  const slug = prev?.slug || slugify(structured.slug || title);
  return {
    slug,
    path: prev?.path || fill(template, { document, date, slug, number }),
    round: (prev?.round || 0) + 1,
    run,
    artifact,
    artifact_url: artifactUrl,
    summary_url: summaryUrl,
    approved: false,
  };
}

async function run({ github, context, core }) {
  const env = process.env;
  const { owner, repo } = context.repo;
  const issue_number = Number(env.NUMBER);
  const document = env.DOCUMENT;
  const { data: issue } = await github.rest.issues.get({ owner, repo, issue_number });
  const prev = readState(issue.body, document);

  if (env.MODE === 'read') {
    if (!prev) return;
    core.setOutput('run', String(prev.run));
    core.setOutput('artifact', String(prev.artifact));
    core.setOutput('file', path.basename(prev.path));
    core.setOutput('header', header(prev, document, false));
    return;
  }
  if (env.MODE === 'place') {
    const dir = path.join(env.GITHUB_WORKSPACE, env.SCRATCH_DIR);
    const from = path.join(dir, env.FILE);
    if (fs.existsSync(from)) fs.renameSync(from, path.join(dir, `${document}.md`));
    return;
  }

  const structured = JSON.parse(env.STRUCTURED || '{}');
  const text = typeof structured[document] === 'string' ? structured[document].trim() : '';
  // one date per round: write names the artifact with it and publish reuses it (DATE)
  const date = env.DATE || new Date().toISOString().slice(0, 10);
  const values = { structured, document, template: env.DOCUMENT_PATH, title: issue.title, number: issue_number, date };

  if (env.MODE === 'write') {
    if (!text) {
      core.setOutput('has_round', 'false');
      return;
    }
    const dir = path.join(env.RUNNER_TEMP, 'issue-agent-round');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, path.basename(nextState(prev, values).path));
    fs.writeFileSync(file, `${text}\n`);
    core.setOutput('has_round', 'true');
    core.setOutput('file', file);
    core.setOutput('date', date);
    return;
  }

  // publish
  const runUrl = `${env.GITHUB_SERVER_URL}/${owner}/${repo}/actions/runs/${env.GITHUB_RUN_ID}`;
  const next = nextState(prev, { ...values, run: env.GITHUB_RUN_ID, artifact: env.ARTIFACT_ID, artifactUrl: env.ARTIFACT_URL, summaryUrl: `${runUrl}#summary-${env.CHECK_RUN_ID}` });
  await core.summary.addRaw(summary(document, issue.title, next.round, `${text}\n`)).write();
  await github.rest.issues.update({ owner, repo, issue_number, body: writeSection(issue.body, document, next, [links(next, document)]) });
  core.setOutput('header', header(next, document, true));
  core.setOutput('round', String(next.round));
}

module.exports = { slugify, label, header, links, summary, nextState, run };
