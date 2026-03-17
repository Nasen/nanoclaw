# Jenkins API Reference

Jenkins instance: `$JENKINS_URL` (from env)
Auth: HTTP Basic — `$JENKINS_USER:$JENKINS_TOKEN`

## Authentication

All requests use Basic auth. Export a helper for curl:

```bash
export JENKINS_AUTH="$JENKINS_USER:$JENKINS_TOKEN"
export JENKINS_URL="${JENKINS_URL%/}"  # strip trailing slash
```

**CSRF crumb** is required for all POST requests. Fetch it first:

```bash
CRUMB=$(curl -s -u "$JENKINS_AUTH" \
  "$JENKINS_URL/crumbIssuer/api/json" \
  | node -e "const d=require('fs').readFileSync('/dev/stdin','utf8'); const j=JSON.parse(d); process.stdout.write(j.crumbRequestField+':'+j.crumb)")
# CRUMB is now e.g. "Jenkins-Crumb:abc123"
```

Node.js helper:

```javascript
const JENKINS_URL = process.env.JENKINS_URL.replace(/\/$/, '');
const JENKINS_AUTH = Buffer.from(`${process.env.JENKINS_USER}:${process.env.JENKINS_TOKEN}`).toString('base64');

async function jenkinsFetch(path, method = 'GET', params = null) {
  const crumb = method !== 'GET' ? await getCrumb() : null;
  const url = new URL(path, JENKINS_URL + '/');
  if (params && method === 'GET') Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const body = params && method !== 'GET' ? new URLSearchParams(params) : undefined;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${JENKINS_AUTH}`,
      ...(crumb ? { [crumb.field]: crumb.value } : {}),
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  if (!res.ok) throw new Error(`Jenkins ${method} ${path}: ${res.status} ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function getCrumb() {
  const d = await (await fetch(`${JENKINS_URL}/crumbIssuer/api/json`, {
    headers: { Authorization: `Basic ${JENKINS_AUTH}` },
  })).json();
  return { field: d.crumbRequestField, value: d.crumb };
}
```

---

## List All Jobs

```bash
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/api/json?tree=jobs[name,url,color]" | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.jobs.forEach(j=>console.log(j.color.padEnd(12), j.name))"
```

```javascript
const data = await jenkinsFetch('/api/json?tree=jobs[name,url,color,lastBuild[number,result]]');
data.jobs.forEach(j => console.log(j.name, j.color, j.lastBuild?.result));
```

Colors: `blue` = success, `red` = failed, `yellow` = unstable, `grey` = never run, `_anime` suffix = building.

---

## Job Info

```bash
# Basic info
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/job/{JOB_NAME}/api/json"

# With build history
curl -s -u "$JENKINS_AUTH" \
  "$JENKINS_URL/job/{JOB_NAME}/api/json?tree=name,description,builds[number,result,timestamp,duration]"
```

```javascript
const job = await jenkinsFetch(`/job/${jobName}/api/json?tree=name,description,builds[number,result,timestamp,duration]`);
```

---

## Trigger a Build

```bash
# Simple (no parameters)
CRUMB=$(curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/crumbIssuer/api/json" | node -e "const j=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); process.stdout.write(j.crumbRequestField+':'+j.crumb)")
curl -s -X POST -u "$JENKINS_AUTH" -H "$CRUMB" "$JENKINS_URL/job/{JOB_NAME}/build"

# With parameters
curl -s -X POST -u "$JENKINS_AUTH" -H "$CRUMB" \
  "$JENKINS_URL/job/{JOB_NAME}/buildWithParameters" \
  --data-urlencode "BRANCH=main" \
  --data-urlencode "ENV=staging"
```

```javascript
// No parameters
await jenkinsFetch(`/job/${jobName}/build`, 'POST');

// With parameters
await jenkinsFetch(`/job/${jobName}/buildWithParameters`, 'POST', {
  BRANCH: 'main',
  ENV: 'staging',
});
```

Returns 201 on success. The `Location` header contains the queued item URL.

---

## Build Status

```bash
# Last build
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/job/{JOB_NAME}/lastBuild/api/json" | \
  node -e "const b=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log('#'+b.number, b.result||'BUILDING', b.duration+'ms')"

# Specific build number
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/job/{JOB_NAME}/{BUILD_NUMBER}/api/json"

# Check if currently building
curl -s -u "$JENKINS_AUTH" \
  "$JENKINS_URL/job/{JOB_NAME}/lastBuild/api/json?tree=building,result,number,timestamp,duration"
```

```javascript
const build = await jenkinsFetch(`/job/${jobName}/lastBuild/api/json?tree=number,result,building,timestamp,duration,url`);
const status = build.building ? 'BUILDING' : build.result;
console.log(`Build #${build.number}: ${status} (${Math.round(build.duration/1000)}s)`);
```

Result values: `SUCCESS`, `FAILURE`, `UNSTABLE`, `ABORTED`, `null` (still running)

---

## Console Output

```bash
# Full console log
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/job/{JOB_NAME}/lastBuild/consoleText"

# Progressive (stream tail)
curl -s -u "$JENKINS_AUTH" \
  "$JENKINS_URL/job/{JOB_NAME}/lastBuild/logText/progressiveText?start=0"
# Response header X-Text-Size gives next start offset
```

```javascript
const log = await (await fetch(`${JENKINS_URL}/job/${jobName}/lastBuild/consoleText`, {
  headers: { Authorization: `Basic ${JENKINS_AUTH}` },
})).text();
// Show last 50 lines:
console.log(log.split('\n').slice(-50).join('\n'));
```

---

## Stop / Abort a Build

```bash
# Abort running build
curl -s -X POST -u "$JENKINS_AUTH" -H "$CRUMB" \
  "$JENKINS_URL/job/{JOB_NAME}/lastBuild/stop"

# Abort by number
curl -s -X POST -u "$JENKINS_AUTH" -H "$CRUMB" \
  "$JENKINS_URL/job/{JOB_NAME}/{BUILD_NUMBER}/stop"
```

---

## Build Queue

```bash
# View queued items
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/queue/api/json?tree=items[id,task[name],why,inQueueSince]"

# Cancel queued item
curl -s -X POST -u "$JENKINS_AUTH" -H "$CRUMB" \
  "$JENKINS_URL/queue/cancelItem?id={QUEUE_ID}"
```

---

## Folder / Nested Jobs

Some Jenkins installations use Folders or Multibranch Pipelines:

```bash
# List jobs in a folder
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/job/{FOLDER}/api/json?tree=jobs[name,color]"

# Trigger job inside folder
curl -s -X POST -u "$JENKINS_AUTH" -H "$CRUMB" \
  "$JENKINS_URL/job/{FOLDER}/job/{JOB_NAME}/build"
```

```javascript
// Nested path: encode each segment separately
const jobPath = ['folder1', 'subfolder', 'job-name'].map(s => `job/${s}`).join('/');
await jenkinsFetch(`/${jobPath}/build`, 'POST');
```

---

## Search Jobs

```bash
# Find jobs by name pattern
curl -s -u "$JENKINS_AUTH" "$JENKINS_URL/api/json?tree=jobs[name,url]" | \
  node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); d.jobs.filter(j=>j.name.includes('RCV')).forEach(j=>console.log(j.name))"
```

---

## Common Error Codes

| Code | Meaning |
|------|---------|
| 201 | Build triggered successfully |
| 302 | Redirect (follow with `-L` in curl) |
| 400 | Bad request (check CSRF crumb or parameters) |
| 403 | Auth failed or insufficient permissions |
| 404 | Job not found |
| 409 | Job already building |
| 500 | Jenkins internal error |

---

## Quick Pattern: Trigger + Poll for Result

```javascript
// Trigger build, get queue URL, wait for build to start, poll until done
async function triggerAndWait(jobName, params = {}) {
  const method = Object.keys(params).length ? 'buildWithParameters' : 'build';
  const res = await fetch(`${JENKINS_URL}/job/${encodeURIComponent(jobName)}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${JENKINS_AUTH}`,
      ...(await getCrumb().then(c => ({ [c.field]: c.value }))),
      ...(Object.keys(params).length ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: Object.keys(params).length ? new URLSearchParams(params) : undefined,
  });
  if (res.status !== 201) throw new Error(`Trigger failed: ${res.status}`);

  // Get queue item URL from Location header
  const queueUrl = res.headers.get('Location') + 'api/json';

  // Wait for build number to appear
  let buildUrl;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const q = await (await fetch(queueUrl, { headers: { Authorization: `Basic ${JENKINS_AUTH}` } })).json();
    if (q.executable) { buildUrl = q.executable.url + 'api/json'; break; }
  }
  if (!buildUrl) throw new Error('Build did not start within 60s');

  // Poll until done
  let build;
  do {
    await new Promise(r => setTimeout(r, 5000));
    build = await (await fetch(buildUrl, { headers: { Authorization: `Basic ${JENKINS_AUTH}` } })).json();
  } while (build.building);

  return { number: build.number, result: build.result, duration: Math.round(build.duration / 1000) };
}

const result = await triggerAndWait('my-pipeline', { BRANCH: 'main' });
console.log(`Build #${result.number}: ${result.result} in ${result.duration}s`);
```
