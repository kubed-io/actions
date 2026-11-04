// issue-template/file: files what an agent filled against a form, as GitHub files the submitted
// form, then links it under its parent and labels it. Create, link, then label: an issue that
// fails to link never carries the opt-in label, so it can't become a work item of its own.

const fs = require('fs');
const form = require('./form');
const parts = require('../../comment/lib/parts');

const norm = (t) => String(t || '').trim().toLowerCase();

async function run({ github, context, core, env = process.env }) {
  const { owner, repo } = context.repo;
  const parent = Number(env.PARENT);
  const filled = JSON.parse(env.OUTPUT || '{}');
  const issue = form.toIssue(JSON.parse(fs.readFileSync(env.FORM, 'utf8')), filled);
  if (!issue.title.trim()) return core.setFailed('the filled form has no title');

  // the same title under the same parent is the same sub-issue: a tick again files nothing
  // octokit's sub-issue methods where this github-script bundles them, else the routes
  const list = github.rest.issues.listSubIssues || 'GET /repos/{owner}/{repo}/issues/{issue_number}/sub_issues';
  const kids = parent ? await github.paginate(list, { owner, repo, issue_number: parent, per_page: 100 }) : [];
  const same = kids.find((k) => norm(k.title) === norm(issue.title));
  if (same) {
    core.setOutput('number', String(same.number));
    core.setOutput('url', same.html_url);
    core.setOutput('created', 'false');
    if (env.NUMBER) parts.addPart(parts.dirOf(env, env.NUMBER), 'filed', `#${same.number} is already filed under #${parent}.`);
    return core.info(`#${parent} already has #${same.number} "${same.title}"`);
  }

  const params = { owner, repo, title: issue.title, body: issue.body, labels: issue.labels };
  let created;
  try {
    ({ data: created } = await github.rest.issues.create({ ...params, ...(issue.type ? { type: issue.type } : {}) }));
  } catch (e) {
    if (!issue.type || e.status !== 422) throw e;
    core.warning(`the ${issue.type} type was refused (${e.message}); filed without it`);
    ({ data: created } = await github.rest.issues.create(params));
  }
  const link = { owner, repo, issue_number: parent, sub_issue_id: created.id };
  if (parent) await (github.rest.issues.addSubIssue ? github.rest.issues.addSubIssue(link) : github.request('POST /repos/{owner}/{repo}/issues/{issue_number}/sub_issues', link));
  const extra = (env.LABELS || '').split(',').map((l) => l.trim()).filter(Boolean);
  if (extra.length) await github.rest.issues.addLabels({ owner, repo, issue_number: created.number, labels: extra });
  core.setOutput('number', String(created.number));
  core.setOutput('url', created.html_url);
  core.setOutput('created', 'true');
  if (env.NUMBER) parts.addPart(parts.dirOf(env, env.NUMBER), 'filed', `Filed #${created.number} under #${parent}.`);
  core.info(`filed #${created.number} under #${parent}`);
}

module.exports = { run };
