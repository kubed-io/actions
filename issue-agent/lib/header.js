// The reply's header: a template the workflow writes, filled after the run.
//
//   {{ output.plan_path }}   a field of the role's output, any depth
//   {{ run_url }}            this run
//   {{ session_id }}         the Claude session
//   {{ number }}             the issue or PR
//   {{ blob }}               the PR head's blob URL, for linking a file the agent wrote
//
// A name with no value renders empty, so a missing field never shows its braces.

function lookup(values, name) {
  return name.split('.').reduce((v, k) => (v == null ? undefined : v[k]), values);
}

function fillHeader(template, values) {
  if (!(template || '').trim()) return '';
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, name) => {
    const v = lookup(values, name);
    return v == null || typeof v === 'object' ? '' : String(v);
  }).trim();
}

module.exports = { fillHeader };
