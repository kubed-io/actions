// Stand-ins for what actions/github-script hands a script: `github` answers from canned
// routes and records every call, `core` records outputs, so a module runs here as in a job.

function github(routes = {}) {
  const calls = [];
  const answer = (name, params) => {
    calls.push({ name, params });
    const route = routes[name];
    const data = typeof route === 'function' ? route(params) : route;
    if (data instanceof Error) throw data;
    return data;
  };
  const rest = new Proxy({}, {
    get: (_, ns) => new Proxy({}, {
      get: (__, method) => async (params) => ({ data: answer(`${ns}.${method}`, params) }),
    }),
  });
  return {
    calls,
    rest,
    paginate: async (fn, params) => (await fn(params)).data,
    graphql: async (query, vars) => {
      const key = Object.keys(routes).find((k) => k.startsWith('graphql:') && query.includes(k.slice(8)));
      return answer(key || 'graphql', vars);
    },
  };
}

function core() {
  const outputs = {};
  const notices = [];
  const failures = [];
  const secrets = [];
  let summary = '';
  return {
    outputs,
    notices,
    failures,
    secrets,
    summaryText: () => summary,
    setOutput: (k, v) => { outputs[k] = v; },
    notice: (m) => notices.push(m),
    warning: (m) => notices.push(m),
    info: () => {},
    setFailed: (m) => failures.push(m),
    setSecret: (s) => secrets.push(s),
    summary: {
      addRaw(text) { summary += text; return this; },
      async write() { return this; },
    },
  };
}

function context(over = {}) {
  return { repo: { owner: 'kubed-io', repo: 'selenium-flow' }, payload: {}, eventName: 'issues', ...over };
}

function exec(ahead = '0') {
  const calls = [];
  return {
    calls,
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return 0; },
    getExecOutput: async (cmd, args) => { calls.push([cmd, ...args]); return { stdout: `${ahead}\n` }; },
  };
}

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

module.exports = { github, core, context, exec, notFound };
