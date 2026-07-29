/**
 * Probe Cloudflare APIs for D1/KV creation using vault token (no secret printing).
 */
import { readFileSync, writeFileSync } from "node:fs";

const cf = JSON.parse(readFileSync(".tmp/cf-env.json", "utf8"));
const accountId = cf.CLOUDFLARE_ACCOUNT_ID;
const token = cf.CLOUDFLARE_API_TOKEN;

async function cfApi(method, path, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok && json.success !== false, json };
}

const report = { at: new Date().toISOString(), accountId, probes: [] };

const tokenVerify = await cfApi("GET", "/user/tokens/verify");
report.probes.push({
  name: "token verify",
  ok: tokenVerify.ok,
  status: tokenVerify.status,
  statusText: tokenVerify.json?.result?.status || null,
});

const d1List = await cfApi("GET", `/accounts/${accountId}/d1/database`);
report.probes.push({
  name: "d1 list",
  ok: d1List.ok,
  status: d1List.status,
  errors: d1List.json?.errors || null,
  count: Array.isArray(d1List.json?.result) ? d1List.json.result.length : null,
});

const d1Create = await cfApi("POST", `/accounts/${accountId}/d1/database`, { name: "amberone" });
report.probes.push({
  name: "d1 create",
  ok: d1Create.ok,
  status: d1Create.status,
  errors: d1Create.json?.errors || null,
  uuid: d1Create.json?.result?.uuid || null,
  nameResult: d1Create.json?.result?.name || null,
});

const kvList = await cfApi("GET", `/accounts/${accountId}/storage/kv/namespaces`);
report.probes.push({
  name: "kv list",
  ok: kvList.ok,
  status: kvList.status,
  errors: kvList.json?.errors || null,
  count: Array.isArray(kvList.json?.result) ? kvList.json.result.length : null,
});

const kvCreate = await cfApi("POST", `/accounts/${accountId}/storage/kv/namespaces`, {
  title: "amberone",
});
report.probes.push({
  name: "kv create",
  ok: kvCreate.ok,
  status: kvCreate.status,
  errors: kvCreate.json?.errors || null,
  id: kvCreate.json?.result?.id || null,
});

const pagesList = await cfApi("GET", `/accounts/${accountId}/pages/projects`);
const projects = Array.isArray(pagesList.json?.result)
  ? pagesList.json.result.map((p) => ({ name: p.name, subdomain: p.subdomain, domains: p.domains }))
  : [];
report.probes.push({
  name: "pages list",
  ok: pagesList.ok,
  status: pagesList.status,
  projects,
});

writeFileSync("docs/CF-API-PROBES.json", JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

if (d1Create.json?.result?.uuid) {
  writeFileSync(
    "docs/d1-created.json",
    JSON.stringify({ database_id: d1Create.json.result.uuid, name: d1Create.json.result.name }, null, 2),
  );
}
