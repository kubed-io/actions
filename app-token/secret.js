// Reads the GitHub App's credentials from GCP Secret Manager with a short-lived access
// token. Nothing is exported to the job (no credentials file, no ADC env), so a step
// that runs later in the same job, an agent included, cannot reach Secret Manager.
//
// Env: PROJECT, SECRET, ACCESS_TOKEN. Outputs: client_id, private_key (masked).

async function run({ core }) {
  const { PROJECT, SECRET, ACCESS_TOKEN } = process.env;
  const url = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${SECRET}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ACCESS_TOKEN}` } });
  if (!res.ok) throw new Error(`Secret Manager answered ${res.status} for ${SECRET}: ${await res.text()}`);
  const { payload } = await res.json();
  const app = JSON.parse(Buffer.from(payload.data, 'base64').toString('utf8'));
  const key = app.github_app_private_key;
  if (!app.github_app_client_id || !key) throw new Error(`${SECRET} has no github_app_client_id or github_app_private_key`);
  // a multi-line value is masked line by line
  core.setSecret(key);
  for (const line of key.split('\n')) if (line.trim()) core.setSecret(line.trim());
  core.setOutput('client_id', app.github_app_client_id);
  core.setOutput('private_key', key);
}

module.exports = { run };
