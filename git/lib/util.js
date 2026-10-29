const fs = require('fs');
const path = require('path');

// comma-separated (labels)
function list(value) {
  return (value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

// one per line (files)
function lines(value) {
  return (value || '').split('\n').map((v) => v.trim()).filter(Boolean);
}

// GraphQL documents are files beside the code, lib/graphql/<name>.graphql
function gql(name) {
  return fs.readFileSync(path.join(__dirname, 'graphql', `${name}.graphql`), 'utf8');
}

// a branch's head on GitHub, null when there is no such branch
async function headOid(github, owner, repo, branch) {
  try {
    const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

// the files `base...head` changed (from their merge base), each rename as its old path and
// its new; every page, as GitHub sends at most 300 files a page and 3000 in all
async function compareFiles(github, owner, repo, basehead) {
  const files = [];
  for (let page = 1; page <= 10; page += 1) {
    const { data } = await github.rest.repos.compareCommitsWithBasehead({ owner, repo, basehead, per_page: 100, page });
    const got = data.files || [];
    files.push(...got);
    if (got.length < 300) break;
  }
  return files;
}

async function defaultBranch(github, owner, repo) {
  const { data } = await github.rest.repos.get({ owner, repo });
  return data.default_branch;
}

// `**` crosses directories, `*` and `?` do not; a trailing `/**` also matches the
// directory itself, so `docs/**` catches a `docs` gitlink
function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 2;
    } else if (glob.startsWith('/**', i) && i + 3 === glob.length) {
      out += '(?:/.*)?';
      i += 2;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 1;
    } else if (c === '*') {
      out += '[^/]*';
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${out}$`);
}

// a pattern names a path, a glob, or a directory (everything under it)
function matcher(patterns) {
  const regexes = patterns.map((p) => globToRegex(p.replace(/^\.\//, '').replace(/\/+$/, '')));
  return (file) => {
    const parts = file.split('/');
    const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join('/'));
    return regexes.some((r) => prefixes.some((p) => r.test(p)));
  };
}

module.exports = { list, lines, gql, headOid, compareFiles, defaultBranch, globToRegex, matcher };
