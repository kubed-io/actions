const fs = require('fs');
const path = require('path');
function list(value) {
  return (value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

// `{key}` placeholders; an unknown key is left as written
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (all, key) => (key in values ? String(values[key]) : all));
}

// GraphQL documents are files beside the code, lib/graphql/<name>.graphql
function gql(name) {
  return fs.readFileSync(path.join(__dirname, 'graphql', `${name}.graphql`), 'utf8');
}

module.exports = { list, fill, gql };
