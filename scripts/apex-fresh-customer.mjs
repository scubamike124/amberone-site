const BASE = process.env.AO_BASE || "https://amberoneai.com";
const pass = "HandsOnPass9!";
const stamp = Date.now().toString(36);
const cookies = [];
async function api(method, path, body) {
  const headers = { Accept: "application/json" };
  if (cookies.length) headers.Cookie = cookies.join("; ");
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual" });
  const set = res.headers.getSetCookie?.() || [];
  for (const line of set) cookies.push(line.split(";")[0]);
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}
const email = `ao.apex.${stamp}@example.com`;
const signup = await api("POST", "/api/auth/signup", { name: "Apex Fresh", email, password: pass });
const note = await api("POST", "/api/notes", { title: "Fresh note", body: "Brand new customer note." });
const cal = await api("POST", "/api/calendar", { title: "Fresh event", starts_at: new Date(Date.now()+3600000).toISOString(), people: "Apex", recurrence: "monthly" });
const proj = await api("POST", "/api/projects", { name: "Fresh project", description: "New customer project" });
const rem = await api("POST", "/api/reminders", { title: "Email path", due_at: new Date(Date.now()-1000).toISOString(), channel: "email" });
const notif = await api("GET", "/api/notifications");
const checkout = await api("POST", "/api/checkout", { plan: "personal" });
const outsiderCookies = [];
async function api2(method, path) {
  const headers = { Accept: "application/json", Cookie: outsiderCookies.join("; ") };
  const res = await fetch(BASE + path, { method, headers, redirect: "manual" });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const out = await fetch(BASE + "/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Out", email: `ao.apex.out.${stamp}@example.com`, password: pass }) });
const outJson = await out.json();
const leaked = await fetch(BASE + `/api/projects?id=${proj.json?.project?.id}`, { headers: { Cookie: (out.headers.getSetCookie?.() || []).map(s=>s.split(";")[0]).join("; ") } });
console.log(JSON.stringify({
  base: BASE,
  signup: signup.status,
  note: note.status,
  calendar: cal.status,
  recurrence: cal.json?.event?.recurrence,
  project: proj.status,
  projectId: Boolean(proj.json?.project?.id),
  reminder: rem.status,
  dispatched: rem.json?.dispatched,
  emailed: (rem.json?.dispatched || []).map(d => ({ id: d.id, emailed: d.emailed })),
  notifCount: (notif.json?.notifications || []).length,
  checkoutHost: checkout.json?.url ? new URL(checkout.json.url).host : checkout.json?.error,
  outsiderProject: leaked.status,
}, null, 2));
