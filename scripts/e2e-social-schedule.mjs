/**
 * Live autonomous social-scheduling verification. Does not connect a real Instagram.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const BASE = process.env.AO_BASE || "https://amberoneai.com";
const stamp = Date.now().toString(36);
const email = `ao.sched.${stamp}@example.com`;
const pass = "HandsOnPass9!";
const cookies = [];
const steps = [];
const ticks = [];

const brief = {
  name: "Harborline Orthodontics",
  sells:
    "discreet adult clear-aligner treatment and Thursday evening adjustment visits for people who delayed braces",
  audience: "working professionals ages 28-45 in Seattle who want straighter teeth without daytime appointments",
  offer: "complimentary 20-minute evening scan Thursday 5–7pm in Ballard; start plans from $129/month",
  tone: "calm, precise, reassuring, never salesy",
  location: "Ballard, Seattle",
  objective: "fill remaining Thursday evening scan appointments this month",
};

function rec(name, ok, detail) {
  steps.push({ name, ok, detail: detail == null ? null : String(detail).slice(0, 400) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 220) : ""}`);
}

function loadCronSecret() {
  const file = path.join(ROOT, ".tmp", "cron-secret.json");
  if (!existsSync(file)) return { present: false };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const secret = String(raw.secret || raw.token || raw.CRON_SECRET || "").trim();
  const hash = secret ? createHash("sha256").update(secret).digest("hex") : "";
  return { present: Boolean(secret), hash, secret, keys: Object.keys(raw) };
}

async function api(method, pathName, body, extraHeaders = {}) {
  const headers = { Accept: "application/json", ...extraHeaders };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 55000);
  try {
    const res = await fetch(BASE + pathName, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    for (const line of res.headers.getSetCookie?.() || []) cookies.push(line.split(";")[0]);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function tickCron(secret) {
  const started = Date.now();
  const headers = { "Content-Type": "application/json", "X-Cron-Secret": secret };
  const lanes = await Promise.all(
    ["instagram", "nextdoor"].map(async (platform) => {
      const res = await fetch(`${BASE}/api/cron/social`, {
        method: "POST",
        headers,
        body: JSON.stringify({ platform }),
        signal: AbortSignal.timeout(55000),
      });
      const json = await res.json().catch(() => ({}));
      return { platform, status: res.status, result: json.result || json };
    }),
  );
  const row = {
    status: lanes.every((l) => l.status === 200) ? 200 : lanes[0].status,
    ms: Date.now() - started,
    result: {
      tick: lanes.map((l) => `${l.platform}:${l.result?.tick}/${l.result?.did}`).join(" "),
      did: lanes.map((l) => l.result?.did).join("+"),
      lanes,
    },
  };
  ticks.push(row);
  return row;
}

function parseQuality(post) {
  try {
    return typeof post.quality_json === "string" ? JSON.parse(post.quality_json) : post.quality_json || {};
  } catch {
    return {};
  }
}

async function listMine() {
  const listed = await api("GET", "/api/social-posts");
  return listed.json?.posts || [];
}

async function waitUnattended(ids, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const posts = await listMine();
    const mine = posts.filter((p) => ids.includes(p.id));
    if (mine.some((p) => p.status !== "pending_compose" || p.error || p.caption)) return { moved: true, posts: mine };
    await new Promise((r) => setTimeout(r, 15000));
  }
  const posts = await listMine();
  return { moved: false, posts: posts.filter((p) => ids.includes(p.id)) };
}

async function drainUntil(secret, predicate, maxTicks) {
  for (let i = 0; i < maxTicks; i += 1) {
    const posts = await listMine();
    if (predicate(posts)) return { ok: true, ticks: i, posts };
    const t = await tickCron(secret);
    console.log(`tick ${i + 1}/${maxTicks}  ${t.status}  ${t.result?.tick || t.result?.error || ""}`);
    if (t.status !== 200) return { ok: false, ticks: i + 1, posts, error: t.result };
  }
  return { ok: predicate(await listMine()), ticks: maxTicks, posts: await listMine() };
}

async function main() {
  mkdirSync(path.join(ROOT, "docs", "social-schedule"), { recursive: true });
  const cron = loadCronSecret();
  rec("cron secret present locally", cron.present, cron.present ? `keys=${cron.keys.join(",")}` : "missing .tmp/cron-secret.json");
  rec(
    "cron secret hash matches Pages CRON_SECRET_HASH",
    cron.hash === "0cd4804e6f11b14d729193f6c6014d43ecf5537823ca3505fccb799a1816a539",
    cron.hash ? `sha256=${cron.hash.slice(0, 8)}…` : "no hash",
  );

  const signup = await api("POST", "/api/auth/signup", { name: "Mina Chen", email, password: pass });
  rec("signup throwaway customer", signup.status === 201 || signup.status === 200, String(signup.status));
  const saved = await api("POST", "/api/business-profile", brief);
  rec("save Harborline brief", saved.status === 200 && saved.json?.profile?.name === brief.name, saved.json?.error);

  const listed0 = await api("GET", "/api/social-posts");
  const platforms = listed0.json?.platforms || [];
  const igMeta = platforms.find((p) => p.id === "instagram") || {};
  const ndMeta = platforms.find((p) => p.id === "nextdoor") || {};
  rec("Instagram compose supported", igMeta.canCompose === true, JSON.stringify(igMeta));
  rec("Instagram not connected on throwaway customer (expected)", igMeta.connected === false, String(igMeta.connected));
  rec("Nextdoor compose supported", ndMeta.canCompose === true, JSON.stringify(ndMeta));
  rec("Nextdoor auto-publish pipeline claimed on", ndMeta.canPublish === true, JSON.stringify(ndMeta));

  const unauthorized = await fetch(`${BASE}/api/cron/social`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  rec("cron rejects missing secret", unauthorized.status === 401, String(unauthorized.status));

  const now = Date.now();
  const due1 = new Date(now + 90 * 1000).toISOString();
  const future1 = new Date(now + 24 * 3600 * 1000).toISOString();
  const future2 = new Date(now + 48 * 3600 * 1000).toISOString();

  const dual = await api("POST", "/api/social-posts", {
    action: "schedule-campaign",
    platform: "all",
    slots: [due1, future1, future2],
    label: "e2e-both",
  });
  const dualPosts = dual.json?.campaign?.posts || [];
  rec(
    "one campaign queues Instagram and Nextdoor together",
    dual.status === 201 &&
      Array.isArray(dual.json?.campaign?.platforms) &&
      dual.json.campaign.platforms.includes("instagram") &&
      dual.json.campaign.platforms.includes("nextdoor") &&
      dualPosts.length === 6,
    `${dual.status} platforms=${(dual.json?.campaign?.platforms || []).join(",")} count=${dualPosts.length}`,
  );
  rec("dual campaign reports both can auto-publish", dual.json?.campaign?.canPublish === true, dual.json?.campaign?.publishNote);

  const watchIds = dualPosts.map((p) => p.id);

  const unattended = cron.present
    ? await waitUnattended(watchIds, 70000)
    : { moved: false, posts: [] };
  rec(
    "cloud cron moved a queued post with this computer idle",
    unattended.moved,
    (unattended.posts || []).map((p) => `${p.id}:${p.status}`).join(",") || "no movement",
  );

  if (!cron.present) {
    rec("drive remaining ticks", false, "no cron secret");
  } else {
    const drained = await drainUntil(
      cron.secret,
      (posts) => {
        const mine = posts.filter((p) => watchIds.includes(p.id));
        const ig = mine.filter((p) => p.platform === "instagram");
        const nd = mine.filter((p) => p.platform === "nextdoor");
        const done = (p) => !["pending_compose", "composing"].includes(p.status);
        return ig.some(done) && nd.length > 0 && nd.every(done);
      },
      30,
    );
    rec("cron drained compose+image for tracked posts", drained.ok, `ticks=${drained.ticks}`);
  }

  const after = await listMine();
  const mine = after.filter((p) => watchIds.includes(p.id));
  const scored = mine.filter((p) => ["scheduled", "published", "publish_failed", "publish_unavailable", "publish_blocked_beta"].includes(p.status));
  rec(
    "finished posts scored >= 95",
    scored.length > 0 && scored.every((p) => Number(parseQuality(p).total) >= 95 && parseQuality(p).passed !== false),
    scored.map((p) => `${p.platform}:${p.status}:${parseQuality(p).total}`).join(" | "),
  );
  rec(
    "Harborline brand in at least one caption",
    mine.some((p) => /Harborline/i.test(p.caption || "")),
    mine.map((p) => (p.caption || "").slice(0, 80)).join(" || "),
  );
  rec(
    "calendar events attached",
    scored.filter((p) => p.calendar_event_id).length >= 2,
    scored.map((p) => p.calendar_event_id || "none").join(","),
  );

  const cal = await api("GET", `/api/calendar?from=${encodeURIComponent(new Date(now - 3600 * 1000).toISOString())}&to=${encodeURIComponent(new Date(now + 3 * 86400 * 1000).toISOString())}`);
  const calHits = (cal.json?.events || []).filter((e) => e.external_source === "amberone-social");
  rec("calendar lists social slots on multiple dates", calHits.length >= 2, `events=${calHits.length} status=${cal.status}`);

  if (cron.present) {
    const publishDrain = await drainUntil(
      cron.secret,
      (posts) => {
        const due = posts.filter((p) => watchIds.includes(p.id) && p.scheduled_at && p.scheduled_at <= new Date().toISOString());
        return due.length > 0 && due.every((p) => p.status !== "scheduled" && p.status !== "pending_compose" && p.status !== "composing");
      },
      8,
    );
    rec("cron picked up due posts", publishDrain.ok, `ticks=${publishDrain.ticks}`);
  }

  if (cron.present) {
    const publishProbe = await api("POST", "/api/social-posts", {
      action: "schedule-campaign",
      platform: "all",
      slots: [new Date(Date.now() - 15 * 1000).toISOString()],
      label: "e2e-publish-both",
    });
    const probeIds = (publishProbe.json?.campaign?.posts || []).map((p) => p.id);
    rec("publish probe queued both networks", probeIds.length === 2, String(probeIds.length));
    for (let i = 0; i < 10; i += 1) {
      const t = await tickCron(cron.secret);
      console.log(`publish-probe tick ${i + 1}  ${t.status}  ${t.result?.tick}`);
      const posts = await listMine();
      const probes = posts.filter((p) => probeIds.includes(p.id));
      if (probes.length === probeIds.length && probes.every((p) => !["pending_compose", "composing", "scheduled"].includes(p.status))) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    const probes = (await listMine()).filter((p) => probeIds.includes(p.id));
    const igProbe = probes.find((p) => p.platform === "instagram");
    const ndProbe = probes.find((p) => p.platform === "nextdoor");
    rec(
      "Instagram publish probe reached a non-live terminal or due-publish state",
      igProbe && ["publish_failed", "rejected_quality", "scheduled", "published"].includes(igProbe.status),
      igProbe ? `${igProbe.status}:${igProbe.error || ""}` : "missing",
    );
    rec(
      "Instagram probe did not fake a live publish",
      igProbe?.status !== "published",
      igProbe?.status || "missing",
    );
    rec(
      "Nextdoor publish probe ran (not_connected or not_configured — not skipped)",
      ndProbe && ndProbe.status === "publish_failed" && /not connected|not configured/i.test(ndProbe.error || ""),
      ndProbe ? `${ndProbe.status}:${ndProbe.error || ""}` : "missing",
    );
  }

  const finalPosts = await listMine();
  const dualFinal = finalPosts.filter((p) => watchIds.includes(p.id));
  const igFuture = dualFinal.filter((p) => p.platform === "instagram" && [future1, future2].includes(p.scheduled_at));
  const ndFuture = dualFinal.filter((p) => p.platform === "nextdoor" && [future1, future2].includes(p.scheduled_at));
  rec(
    "Instagram and Nextdoor both have scored campaign posts",
    dualFinal.some((p) => p.platform === "instagram") &&
      dualFinal.some((p) => p.platform === "nextdoor" && Number(parseQuality(p).total) >= 95),
    dualFinal.map((p) => `${p.platform}:${p.status}:${parseQuality(p).total || ""}`).join(" | "),
  );
  rec(
    "future Instagram posts remain on the calendar",
    igFuture.some((p) => ["scheduled", "rejected_quality"].includes(p.status)),
    igFuture.map((p) => `${p.status}:${p.scheduled_at}`).join(" | "),
  );
  rec(
    "future Nextdoor posts remain on the calendar",
    ndFuture.some((p) => p.status === "scheduled" && p.calendar_event_id),
    ndFuture.map((p) => `${p.status}:${p.scheduled_at}`).join(" | "),
  );

  const talk = await api("POST", "/api/talk", {
    message: "Create and schedule my social-media content for the next 2 days.",
  });
  const talkUsed = (talk.json?.toolsUsed || []).map((t) => t.name);
  rec(
    "Talk calls schedule_social_campaign",
    talk.status === 200 && talkUsed.includes("schedule_social_campaign"),
    `${talk.status} tools=${talkUsed.join(",") || "none"} ${(talk.json?.reply || "").slice(0, 160)}`,
  );

  const workerUrl = process.env.AO_CRON_WORKER_URL || "";
  if (workerUrl) {
    const health = await fetch(workerUrl, { signal: AbortSignal.timeout(15000) }).then((r) => r.json().catch(() => ({})));
    rec("cron worker health", health.ok === true && health.service === "amberone-social-cron", JSON.stringify(health));
  } else {
    rec("cron worker health URL provided", false, "set AO_CRON_WORKER_URL after wrangler deploy");
  }

  const report = {
    at: new Date().toISOString(),
    base: BASE,
    email,
    steps,
    ticks: ticks.map((t) => ({ status: t.status, ms: t.ms, tick: t.result?.tick, did: t.result?.did })),
    posts: (await listMine()).map((p) => ({
      id: p.id,
      platform: p.platform,
      status: p.status,
      scheduled_at: p.scheduled_at,
      score: parseQuality(p).total,
      calendar_event_id: p.calendar_event_id,
      error: p.error,
    })),
  };
  writeFileSync(path.join(ROOT, "docs", "social-schedule", "RESULT.json"), JSON.stringify(report, null, 2));
  const failed = steps.filter((s) => !s.ok).map((s) => s.name);
  console.log(failed.length ? `FAILED ${failed.length}: ${failed.join("; ")}` : "ALL CHECKS PASSED");
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
