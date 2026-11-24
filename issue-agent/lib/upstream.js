// An upstream epic and its downstream issues (spec 2026-11-24 upstream releases, R-UR7).
//
// A downstream issue carries one hidden line naming the epic it adopts a release of,
// `<!-- upstream: <owner>/<repo>#<P> -->`, beside the visible link. It is the only record that
// the issue belongs to the epic, and it counts only on an issue the App or Dr K wrote: the
// downstream repos are public. Two different markers are no marker.
//
// n8n's own comments open with a marker of theirs on the first line: `upstream-release` (an rc
// or the final), `upstream-message` (the epic's words) and `downstream-report` (a downstream
// turn's report, posted on the epic). Anywhere else in a comment they are nothing.

const MARKER = /^<!-- upstream: ([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9]\d*) -->$/gm;
const NOTE = /^<!-- (upstream-release|upstream-message|downstream-report) (\{.*\}) -->/;
const REF = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)#([1-9]\d*)$/;
const KINDS = { 'upstream-release': 'release', 'upstream-message': 'message', 'downstream-report': 'report' };

// a ref's repo, lowercased, and number; null when it is no ref
function parts(ref) {
  const m = REF.exec(String(ref ?? ''));
  return m ? { repo: m[1].toLowerCase(), number: Number(m[2]) } : null;
}

// the same epic: the repo matches lowercased, the number is equal
function sameRef(a, b) {
  const x = parts(a);
  const y = parts(b);
  return !!x && !!y && x.repo === y.repo && x.number === y.number;
}

// the epic an issue's marker names, when the App or Dr K wrote the issue; else null
function markerOf(issue, { app, owner }) {
  const author = String(issue?.user?.id ?? '');
  if (!author || (author !== String(app) && author !== String(owner))) return null;
  const found = [...String(issue.body ?? '').matchAll(MARKER)].map((m) => ({ repo: m[1], number: Number(m[2]), ref: `${m[1]}#${m[2]}` }));
  if (!found.length || found.some((f) => !sameRef(f.ref, found[0].ref))) return null;
  return found[0];
}

// the note a comment opens with, or null
function noteOf(body) {
  const m = NOTE.exec(String(body ?? ''));
  if (!m) return null;
  let data;
  try {
    data = JSON.parse(m[2]);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const kind = KINDS[m[1]];
  if (kind === 'report') {
    const number = Number(data.number);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(data.repo ?? '')) || !Number.isInteger(number) || number < 1) return null;
    return { kind, repo: data.repo, number };
  }
  if (!parts(data.upstream)) return null;
  if (kind === 'message') return { kind, upstream: data.upstream };
  return { kind, upstream: data.upstream, version: String(data.version ?? ''), final: data.final === true };
}

module.exports = { markerOf, noteOf, sameRef };
