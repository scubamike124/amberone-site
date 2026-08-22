const bases = ["https://amberoneai.com", "https://77bd8dca.amberone.pages.dev"];
const pass = "HandsOnPass9!";
const rows = [];

for (const base of bases) {
  const cookies = [];
  async function req(method, path, body) {
    const headers = { Accept: "application/json" };
    if (cookies.length) headers.Cookie = cookies.join("; ");
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    for (const line of res.headers.getSetCookie?.() || []) cookies.push(line.split(";")[0]);
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json, location: res.headers.get("location") };
  }
  const health = await req("GET", "/api/health");
  await req("POST", "/api/auth/signup", {
    name: "Stripe Recheck",
    email: `ao.stripe3.${Date.now().toString(36)}@example.com`,
    password: pass,
  });
  const checkout = await req("POST", "/api/checkout", { plan: "personal" });
  const url = checkout.json?.url || "";
  const files = await req("POST", "/api/files", {
    name: "a.txt",
    content_type: "text/plain",
    content_base64: Buffer.from("ok").toString("base64"),
  });
  const oauth = await req("GET", "/api/google-calendar-oauth");
  rows.push({
    base,
    health: { ok: health.json?.ok, r2: health.json?.r2, googleCalendarOAuth: health.json?.googleCalendarOAuth },
    checkout: {
      status: checkout.status,
      ok: checkout.status === 200 && String(url).startsWith("https://checkout.stripe.com/"),
      host: url ? new URL(url).host : null,
      error: checkout.json?.error || null,
    },
    files: { status: files.status, ok: files.status === 201 },
    oauth: { status: oauth.status, toGoogle: String(oauth.location || "").includes("accounts.google.com") },
  });
}

console.log(JSON.stringify(rows, null, 2));
process.exit(rows.every((r) => r.checkout.ok && r.files.ok && r.health.r2 && r.health.googleCalendarOAuth) ? 0 : 1);
