const BASE = process.env.AO_BASE || "https://amberoneai.com";
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
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json, location: res.headers.get("location") };
}

await req("POST", "/api/auth/signup", {
  name: "Social API",
  email: `ao.socialapi.${Date.now().toString(36)}@example.com`,
  password: "HandsOnPass9!",
});
const get = await req("GET", "/api/social-posts");
const nd = await req("POST", "/api/social-posts", { action: "create", platform: "nextdoor", caption: "Hello neighbors, we are open this week." });
const create = await req("POST", "/api/social-posts", {
  action: "create",
  platform: "instagram",
  caption: "Open for the week — professional test post. Not published live.",
  image_url: "/assets/social/amberone-professional-post.png",
});
const prepare = await req("POST", "/api/social-posts", { action: "prepare", id: create.json?.post?.id });
const services = await req("GET", "/api/connected-services");
const igToolkit = (services.json?.availableToolkits || []).find((t) => t.toolkit === "instagram");
const connect = await req("POST", "/api/connected-services", { toolkit: "instagram" });
console.log(
  JSON.stringify(
    {
      platforms: get.json?.platforms,
      nextdoorCreate: { status: nd.status, error: nd.json?.error || null },
      instagramDraft: { status: create.status, id: create.json?.post?.id || null, statusField: create.json?.post?.status || null },
      prepare: { status: prepare.status, code: prepare.json?.code || null, error: prepare.json?.error || null, stage: prepare.json?.stage || null },
      instagramToolkit: igToolkit || null,
      connectStart: {
        status: connect.status,
        hasRedirect: Boolean(connect.json?.redirectUrl),
        host: connect.json?.redirectUrl ? new URL(connect.json.redirectUrl).host : null,
        error: connect.json?.error || null,
      },
    },
    null,
    2,
  ),
);
