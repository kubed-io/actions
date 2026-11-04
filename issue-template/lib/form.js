// Issue forms (.github/ISSUE_TEMPLATE/*.yml, already parsed) as JSON schemas for an agent's
// output, and an item filled against one as the issue GitHub would file from the form.

// a field's key: its id, or its label as GitHub would slug it when it has none
const keyOf = (f) => f.id || String(f.attributes?.label || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// The fields an agent fills: no markdown, and no checkboxes that are only an attestation by
// the person filing (every option required, "I searched the open issues")
function fields(form) {
  return (form.body || []).filter((f) => {
    if (f.type === 'markdown') return false;
    if (f.type === 'checkboxes') {
      const opts = f.attributes?.options || [];
      return opts.length && !opts.every((o) => o.required);
    }
    return true;
  });
}

function fieldSchema(f) {
  const a = f.attributes || {};
  const base = { title: a.label, ...(a.description ? { description: a.description } : {}) };
  if (f.type === 'dropdown') {
    const opts = a.options || [];
    return a.multiple
      ? { ...base, type: 'array', items: { type: 'string', enum: opts }, uniqueItems: true }
      : { ...base, type: 'string', enum: opts };
  }
  if (f.type === 'checkboxes') {
    const props = Object.fromEntries((a.options || []).map((o) => [o.label, { type: 'boolean' }]));
    return { ...base, type: 'object', properties: props, required: (a.options || []).filter((o) => o.required).map((o) => o.label), additionalProperties: false };
  }
  // input and textarea; a placeholder is an example, never a value
  return { ...base, type: 'string', ...(a.placeholder ? { examples: [String(a.placeholder)] } : {}) };
}

// One form as the schema of one issue to file from it
function toSchema(form) {
  const fs = fields(form);
  const properties = {
    title: { type: 'string', description: `The issue's title${form.title ? `, without the form's "${form.title.trim()}" prefix` : ''}.` },
    ...Object.fromEntries(fs.map((f) => [keyOf(f), fieldSchema(f)])),
  };
  const required = ['title', ...fs.filter((f) => f.validations?.required).map(keyOf)];
  return { type: 'object', title: form.name, ...(form.description ? { description: form.description } : {}), properties, required, additionalProperties: false };
}

// The forms whose `type:` is one of `types`, one per type: the first by file name
function byType(forms, types) {
  const out = {};
  for (const f of [...forms].sort((x, y) => x.file.localeCompare(y.file))) {
    const t = f.form.type;
    if (t && types.includes(t) && !out[t]) out[t] = f;
  }
  return out;
}

// The form a run is for: by `template` (a file stem), else by `type`
function pick(forms, { template, type }) {
  if (template) return forms.find((f) => f.file.replace(/\.ya?ml$/, '') === template) || null;
  if (type) return byType(forms, [type])[type] || null;
  return null;
}

// The proposal: sub-issues to suggest, each a type that has a form, a title and why
function catalog(forms, types) {
  const have = byType(forms, types);
  const names = types.filter((t) => have[t]);
  if (!names.length) return null;
  const desc = names.map((t) => `${t}: ${have[t].form.description || have[t].form.name}`).join('; ');
  return {
    type: 'object',
    properties: {
      sub_issues: {
        type: 'array',
        description: 'The sub-issues to suggest, in the order they should be done.',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: names, description: `The issue type, which picks its form. ${desc}.` },
            title: { type: 'string', description: "The issue's title." },
            why: { type: 'string', description: 'One line: what this part is, and why it is its own issue.' },
          },
          required: ['type', 'title', 'why'],
          additionalProperties: false,
        },
      },
    },
    required: ['sub_issues'],
    additionalProperties: false,
  };
}

// An item filled against a form, as GitHub files the submitted form: the title prefix, then
// `### <label>` and the value for each field, in the form's order
function toIssue(form, item) {
  const prefix = form.title || '';
  const parts = [];
  for (const f of form.body || []) {
    if (f.type === 'markdown') continue;
    const a = f.attributes || {};
    const v = item[keyOf(f)];
    let text;
    if (f.type === 'checkboxes') {
      text = (a.options || []).map((o) => `- [${v && v[o.label] ? 'x' : ' '}] ${o.label}`).join('\n');
    } else if (Array.isArray(v)) {
      text = v.length ? v.join(', ') : '';
    } else {
      text = v == null ? '' : String(v).trim();
    }
    if (!text) text = '_No response_';
    else if (a.render && f.type !== 'checkboxes') text = `\`\`\`${a.render}\n${text}\n\`\`\``;
    parts.push(`### ${a.label}\n\n${text}`);
  }
  const labels = Array.isArray(form.labels) ? form.labels : String(form.labels || '').split(',').map((s) => s.trim()).filter(Boolean);
  return { title: `${prefix}${item.title || ''}`, body: parts.join('\n\n'), labels, type: form.type || '' };
}

module.exports = { keyOf, fields, toSchema, byType, pick, catalog, toIssue };
