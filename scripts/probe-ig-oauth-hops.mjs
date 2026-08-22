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
  return { status: res.status, json: await res.json().catch(() => ({})), location: res.headers.get("location") };
}
await req("POST", "/api/auth/signup", {
  name: "OAuth Hop",
  email: `ao.igoauth.${Date.now().toString(36)}@example.com`,
  password: "HandsOnPass9!",
});
const start = await req("POST", "/api/connected-services", { toolkit: "instagram" });
let url = start.json?.redirectUrl;
const hops = [];
for (let i = 0; i < 6 && url; i += 1) {
  const res = await fetch(url, { redirect: "manual", headers: { "User-Agent": "Mozilla/5.0" } });
  const loc = res.headers.get("location");
  const html = await res.text();
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return "invalid";
    }
  })();
  hops.push({
    status: res.status,
    host,
    path: (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })(),
    title: (html.match(/<title>([^<]+)<\/title>/i) || [])[1] || null,
    instagram: /instagram/i.test(html + url),
    facebook: /facebook/i.test(html + url),
    mismatch: /error/i.test((html.match(/<title>([^<]+)<\/title>/i) || [])[1] || ""),
    nextHost: loc
      ? (() => {
          try {
            return new URL(loc, url).host;
          } catch {
            return null;
          }
        })()
      : null,
  });
  if (!loc || res.status < 300 || res.status >= 400) break;
  url = new URL(loc, url).toString();
}
console.log(
  JSON.stringify(
    {
      connectHost: start.json?.redirectUrl ? new URL(start.json.redirectUrl).host : null,
      hops,
    },
    null,
    2,
  ),
);
