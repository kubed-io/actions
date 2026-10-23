// Stand-ins for what actions/github-script hands a script: `github` answers from canned
// routes and records every call, `core` records outputs, `exec` answers git from canned
// output, so a module runs here as in a job.

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
    graphql: async (query, vars) => {
      const key = Object.keys(routes).find((k) => k.startsWith('graphql:') && query.includes(k.slice(8)));
      return answer(key || 'graphql', vars);
    },
  };
}

function core() {
  const outputs = {};
  const notices = [];
  const secrets = [];
  return {
    outputs,
    notices,
    secrets,
    setSecret: (v) => secrets.push(v),
    setOutput: (k, v) => { outputs[k] = v; },
    notice: (m) => notices.push(m),
    warning: (m) => notices.push(m),
    info: () => {},
  };
}

function context(over = {}) {
  return { repo: { owner: 'kubed-io', repo: 'actions' }, payload: {}, ...over };
}

// routes: the start of a git command line (`status`, `rev-parse --abbrev-ref`) → stdout
function exec(routes = {}) {
  const calls = [];
  const out = (args) => {
    const line = args.join(' ');
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => line.startsWith(k));
    const route = key === undefined ? '' : routes[key];
    return typeof route === 'function' ? route(args) : route;
  };
  return {
    calls,
    exec: async (cmd, args) => { calls.push([cmd, ...args]); return 0; },
    getExecOutput: async (cmd, args) => { calls.push([cmd, ...args]); return { exitCode: 0, stdout: out(args), stderr: '' }; },
  };
}

function notFound() {
  return Object.assign(new Error('Not Found'), { status: 404 });
}

module.exports = { github, core, context, exec, notFound };
