import { readFileSync } from "node:fs";

const cf = JSON.parse(readFileSync(".tmp/cf-env.json", "utf8"));
const TOKEN = cf.CLOUDFLARE_API_TOKEN;
const FULL = "tiktok-developers-site-verification=Ubagp0QuK2XFo1HBmxfRdfRgB8cbzYHS";
const CODE = "Ubagp0QuK2XFo1HBmxfRdfRgB8cbzYHS";

async function api(path, init) {
  const r = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });
  return { status: r.status, j: await r.json() };
}

async function main() {
  const zones = await api("/zones?name=amberoneai.com");
  const zoneId = zones.j.result?.[0]?.id;
  if (!zoneId) throw new Error(JSON.stringify(zones.j));

  const list = await api(`/zones/${zoneId}/dns_records?type=TXT&per_page=100`);
  if (!list.j.success) throw new Error(JSON.stringify(list.j.errors));
  const records = list.j.result || [];
  console.log(JSON.stringify({
    zoneId,
    tiktok: records
      .filter((r) => /tiktok|Ubagp0/i.test(r.name + r.content))
      .map((r) => ({ id: r.id, name: r.name, content: r.content })),
    allTxt: records.map((r) => ({ name: r.name, content: r.content })),
  }, null, 2));

  const wanted = [
    { name: "amberoneai.com", content: FULL },
    { name: "tiktok-developers-site-verification.amberoneai.com", content: FULL },
    { name: "tiktok-developers-site-verification.amberoneai.com", content: CODE },
  ];
  for (const w of wanted) {
    const exists = records.some((r) => r.name === w.name && r.content === w.content);
    if (exists) {
      console.log(JSON.stringify({ skip: w }));
      continue;
    }
    const created = await api(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "TXT", name: w.name, content: w.content, ttl: 3600 }),
    });
    console.log(JSON.stringify({ create: w, success: created.j.success, errors: created.j.errors, id: created.j.result?.id }, null, 2));
  }
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
