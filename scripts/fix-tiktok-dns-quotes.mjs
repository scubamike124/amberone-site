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

function norm(content) {
  // Cloudflare API often returns TXT content wrapped in quotes
  let c = content;
  if (c.startsWith('"') && c.endsWith('"')) c = c.slice(1, -1);
  // also handle escaped inner quotes representation
  c = c.replace(/\\"/g, '"');
  return c;
}

async function main() {
  const zones = await api("/zones?name=amberoneai.com");
  const zoneId = zones.j.result[0].id;
  const list = await api(`/zones/${zoneId}/dns_records?type=TXT&per_page=100`);
  const records = list.j.result || [];

  const detailed = records.map((r) => ({
    id: r.id,
    name: r.name,
    raw: r.content,
    rawLen: r.content.length,
    norm: norm(r.content),
    normLen: norm(r.content).length,
    hasLiteralQuotesInWire: r.content.includes('\\"') || (r.content.match(/"/g) || []).length > 2,
    equalsFull: norm(r.content) === FULL,
    equalsCode: norm(r.content) === CODE,
  }));
  console.log(JSON.stringify({ detailed }, null, 2));

  // Desired unique set:
  // 1) apex FULL (exactly one)
  // 2) host FULL (exactly one)
  // 3) host CODE (exactly one)
  // Delete extras / wrong ones

  const keep = new Set();
  const toDelete = [];

  function pickOne(name, predicate, label) {
    const matches = detailed.filter((r) => r.name === name && predicate(r));
    if (!matches.length) {
      console.log(JSON.stringify({ missing: label, name }));
      return;
    }
    // prefer record whose raw does NOT start with quote-quote weirdness; prefer shortest raw that norms correctly
    matches.sort((a, b) => a.rawLen - b.rawLen);
    const winner = matches[0];
    keep.add(winner.id);
    for (const m of matches.slice(1)) toDelete.push({ id: m.id, reason: `dup_${label}`, raw: m.raw });
  }

  pickOne("amberoneai.com", (r) => r.equalsFull, "apex_full");
  pickOne("tiktok-developers-site-verification.amberoneai.com", (r) => r.equalsFull, "host_full");
  pickOne("tiktok-developers-site-verification.amberoneai.com", (r) => r.equalsCode, "host_code");

  // delete other tiktok-related leftovers
  for (const r of detailed) {
    if (!/tiktok|Ubagp0/i.test(r.name + r.raw)) continue;
    if (keep.has(r.id)) continue;
    if (!toDelete.some((d) => d.id === r.id)) {
      toDelete.push({ id: r.id, reason: "leftover", raw: r.raw, name: r.name });
    }
  }

  console.log(JSON.stringify({ keep: [...keep], toDelete }, null, 2));

  for (const d of toDelete) {
    const del = await api(`/zones/${zoneId}/dns_records/${d.id}`, { method: "DELETE" });
    console.log(JSON.stringify({ deleted: d, success: del.j.success, errors: del.j.errors }));
  }

  // Ensure wanted exist
  const list2 = await api(`/zones/${zoneId}/dns_records?type=TXT&per_page=100`);
  const after = list2.j.result || [];
  const wanted = [
    { name: "amberoneai.com", content: FULL },
    { name: "tiktok-developers-site-verification.amberoneai.com", content: FULL },
    { name: "tiktok-developers-site-verification.amberoneai.com", content: CODE },
  ];
  for (const w of wanted) {
    const exists = after.some((r) => r.name === w.name && norm(r.content) === w.content);
    if (exists) {
      console.log(JSON.stringify({ ensured: w, status: "present" }));
      continue;
    }
    const created = await api(`/zones/${zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify({ type: "TXT", name: w.name, content: w.content, ttl: 3600 }),
    });
    console.log(JSON.stringify({ ensured: w, created: created.j.success, errors: created.j.errors, id: created.j.result?.id }));
  }

  const final = await api(`/zones/${zoneId}/dns_records?type=TXT&per_page=100`);
  console.log(JSON.stringify({
    final: (final.j.result || [])
      .filter((r) => /tiktok|Ubagp0|railway/i.test(r.name + r.content))
      .map((r) => ({ name: r.name, content: r.content, norm: norm(r.content) })),
  }, null, 2));
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
