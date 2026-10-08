function list(value) {
  return (value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

// `{key}` placeholders; an unknown key is left as written
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all));
}

module.exports = { list, fill };
