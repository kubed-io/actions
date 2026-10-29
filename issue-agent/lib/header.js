// The reply's header: a template the workflow writes, filled after the run.
//
//   {{ output.plan_path }}       a field of the role's output, any depth
//   {{ link:output.plan_path }}  a link to that file: its wiki page when it is in a wiki
//                                submodule (GitHub cannot show a submodule's file by blob)
//   {{ run_url }}                this run
//   {{ session_id }}             the Claude session
//   {{ number }}                 the issue or PR
//   {{ blob }}                   the PR head's blob URL
//
// A name with no value renders empty, so a missing field never shows its braces.

const path = require('path');

function lookup(values, name) {
  return name.split('.').reduce((v, k) => (v == null ? undefined : v[k]), values);
}

function fillHeader(template, values, { link } = {}) {
  if (!(template || '').trim()) return '';
  return template.replace(/\{\{\s*(link:)?([\w.]+)\s*\}\}/g, (_, linked, name) => {
    const v = lookup(values, name);
    if (v == null || typeof v === 'object') return '';
    return linked && link ? link(String(v)) : String(v);
  }).trim();
}

// the submodules that are a repository's wiki, from .gitmodules' text, with each wiki's
// page URL
function wikisOf(gitmodules) {
  const wikis = [];
  let at = null;
  for (const line of (gitmodules || '').split('\n')) {
    if (/^\s*\[submodule /.test(line)) at = {};
    const kv = /^\s*(path|url)\s*=\s*(.+?)\s*$/.exec(line);
    if (!at || !kv) continue;
    at[kv[1]] = kv[2];
    if (at.path && at.url) {
      const repo = /github\.com[:/](.+?)\.wiki\.git$/.exec(at.url)?.[1];
      if (repo) wikis.push({ path: at.path, base: `https://github.com/${repo}/wiki` });
      at = null;
    }
  }
  return wikis;
}

// a file's URL: a wiki shows a page by its file name, without folders or `.md`
function linkTo({ blob, wikis = [] }) {
  return (file) => {
    const wiki = wikis.find((w) => file.startsWith(`${w.path}/`));
    if (wiki) return `${wiki.base}/${path.basename(file).replace(/\.md$/, '')}`;
    return `${blob}/${file}`;
  };
}

module.exports = { fillHeader, wikisOf, linkTo };
