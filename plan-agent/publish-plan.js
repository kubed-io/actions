// Post-step: take the agent's structured { reply, plan } and do all the GitHub
// writes deterministically — the agent itself has no GitHub tools.
//
//   - plan  → synced INTO THE ISSUE BODY, below a hard divider, under a hidden
//             marker. Everything ABOVE the marker is the human's original request
//             and is never touched; everything below is the agent-maintained plan.
//             The issue body is what GitHub Copilot reads as its prompt when the
//             issue is assigned to it — so the plan living there is what makes the
//             builder follow it without being told to go find it.
//   - reply → posted as a short new comment (the conversational "what changed" note).
//
// Env (set by the action step):
//   MARKER     — hidden HTML-comment marker that bounds the plan section in the body
//   STRUCTURED — the claude step's structured_output (JSON string)

module.exports = async function publish({ github, context, core }) {
  let parsed;
  try {
    parsed = JSON.parse(process.env.STRUCTURED);
  } catch (e) {
    core.warning(`structured_output was not valid JSON; nothing to publish: ${e.message}`);
    return;
  }

  const { reply, plan } = parsed;
  const marker = process.env.MARKER;
  const { owner, repo } = context.repo;
  const issue_number = context.issue.number;

  // Sync the plan into the issue body. The marker is the split point: keep
  // everything before it (the human's text) verbatim, regenerate everything after.
  if (plan && plan.trim()) {
    const issue = await github.rest.issues.get({ owner, repo, issue_number });
    const current = issue.data.body || '';
    const idx = current.indexOf(marker);
    const human = (idx === -1 ? current : current.slice(0, idx)).trimEnd();

    // Hard, unmistakable boundary between the human's request and the plan:
    // hidden marker (the machine split point) + a full-width rule + a hidden
    // note for anyone reading the raw markdown + the plan heading.
    const planSection = [
      marker,
      '',
      '---',
      '',
      '<!-- ▼▼▼ EVERYTHING BELOW THIS LINE IS GENERATED AND MAINTAINED BY THE PLAN AGENT. ▼▼▼',
      '     Do not hand-edit it — edit the request ABOVE the line, or comment @claude to refine. -->',
      '',
      '# 📋 Implementation Plan',
      '',
      '> **This is the spec.** When this issue is assigned to GitHub Copilot, implement the plan below in full.',
      '',
      plan.trim(),
    ].join('\n');

    const body = human ? `${human}\n\n${planSection}` : planSection;
    await github.rest.issues.update({ owner, repo, issue_number, body });
    core.info('synced plan into issue body');
  } else {
    core.info('no plan in structured output; left issue body unchanged');
  }

  // Post the short conversational reply as its own comment.
  if (reply && reply.trim()) {
    await github.rest.issues.createComment({ owner, repo, issue_number, body: reply });
    core.info('posted reply');
  }
};
