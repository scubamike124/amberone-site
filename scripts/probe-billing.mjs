const BASE = "https://amberoneai.com";
const cookies = [];
async function req(method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const line of res.headers.getSetCookie?.() || []) cookies.push(line.split(";")[0]);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
await req("POST", "/api/auth/signup", {
  name: "Bill Recheck",
  email: `ao.bill.${Date.now().toString(36)}@example.com`,
  password: "HandsOnPass9!",
});
const personal = await req("POST", "/api/checkout", { plan: "personal" });
const unknown = await req("POST", "/api/checkout", { plan: "enterprise" });
const url = personal.json?.url || "";
console.log(
  JSON.stringify(
    {
      personal: {
        status: personal.status,
        ok: personal.status === 200 && String(url).startsWith("https://checkout.stripe.com/"),
        host: url ? new URL(url).host : null,
        error: personal.json?.error || null,
      },
      unknownPlan: { status: unknown.status, ok: unknown.status === 400, error: unknown.json?.error || null },
    },
    null,
    2,
  ),
);
process.exit(personal.status === 200 && unknown.status === 400 ? 0 : 1);
