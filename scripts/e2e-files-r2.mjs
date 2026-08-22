const BASE = process.env.AO_BASE || "https://amberoneai.com";
const pass = "HandsOnPass9!";
const stamp = Date.now().toString(36);

function jar() {
  const cookies = [];
  return {
    async req(method, path, body, extra = {}) {
      const headers = { Accept: "application/json", ...extra };
      if (cookies.length) headers.Cookie = cookies.join("; ");
      if (body !== undefined && extra["Content-Type"] !== "application/octet-stream" && !(body instanceof Uint8Array)) {
        headers["Content-Type"] = extra["Content-Type"] || "application/json";
      }
      const res = await fetch(BASE + path, {
        method,
        headers,
        body: body === undefined ? undefined : body instanceof Uint8Array ? body : typeof body === "string" ? body : JSON.stringify(body),
        redirect: "manual",
      });
      for (const line of res.headers.getSetCookie?.() || []) cookies.push(line.split(";")[0]);
      const buf = new Uint8Array(await res.arrayBuffer());
      const text = new TextDecoder().decode(buf);
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: res.status, json, text, buf, ct: res.headers.get("content-type") };
    },
  };
}

function b64(s) {
  return Buffer.from(s, "utf8").toString("base64");
}

const owner = jar();
const other = jar();
const emailA = `ao.r2.${stamp}@example.com`;
const emailB = `ao.r2.out.${stamp}@example.com`;
const steps = [];
function rec(name, ok, detail) {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + String(detail).slice(0, 160) : ""}`);
}

await owner.req("POST", "/api/auth/signup", { name: "R2 Owner", email: emailA, password: pass });
await other.req("POST", "/api/auth/signup", { name: "R2 Other", email: emailB, password: pass });

let r = await owner.req("POST", "/api/files", {
  name: "notes.txt",
  content_type: "text/plain",
  content_base64: b64("hello from amber one"),
});
rec("upload txt", r.status === 201 && r.json?.file?.id, r.json?.file?.id || r.json?.error);
const fileId = r.json?.file?.id;

r = await owner.req("POST", "/api/files", {
  name: "shot.png",
  content_type: "image/png",
  content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
});
rec("upload png", r.status === 201, r.json?.file?.id || r.json?.error);

r = await owner.req("POST", "/api/files", {
  name: "virus.exe",
  content_type: "application/x-msdownload",
  content_base64: b64("MZ"),
});
rec("reject exe", r.status === 400, r.json?.error);

r = await owner.req("POST", "/api/files", "x".repeat(11 * 1024 * 1024), { "Content-Type": "application/octet-stream", "Content-Length": String(11 * 1024 * 1024) });
rec("reject oversized", r.status === 413 || r.status === 400, String(r.status));

r = await owner.req("GET", "/api/files");
rec("list includes notes.txt", (r.json?.files || []).some((f) => f.id === fileId), String((r.json?.files || []).length));

r = await owner.req("GET", `/api/files?id=${fileId}&download=1`);
rec("download matches stored text", r.status === 200 && r.text.includes("hello from amber one"), r.text.slice(0, 80));

r = await owner.req("PUT", `/api/files?id=${fileId}`, {
  name: "notes.txt",
  content_type: "text/plain",
  content_base64: b64("replaced content"),
});
rec("replace file", r.status === 200, r.json?.error);
r = await owner.req("GET", `/api/files?id=${fileId}&download=1`);
rec("download after replace", r.status === 200 && r.text.includes("replaced content"), r.text.slice(0, 80));

r = await other.req("GET", `/api/files?id=${fileId}&download=1`);
rec("outsider cannot download private file", r.status === 404, String(r.status));
r = await other.req("GET", "/api/files");
rec("outsider list does not include owner file", !(r.json?.files || []).some((f) => f.id === fileId), String((r.json?.files || []).length));

const proj = await owner.req("POST", "/api/projects", { name: "R2 project", description: "files" });
const projectId = proj.json?.project?.id;
r = await owner.req("POST", "/api/files", {
  name: "spec.pdf",
  content_type: "application/pdf",
  project_id: projectId,
  content_base64: b64("%PDF-1.4 test"),
});
rec("attach file to project", r.status === 201, r.json?.file?.id || r.json?.error);
const projFile = r.json?.file?.id;

await owner.req("PATCH", "/api/projects", { action: "invite", project_id: projectId, email: emailB, role: "member" });
const invites = await other.req("GET", "/api/projects?action=invites");
const inv = (invites.json?.invites || []).find((i) => i.project_id === projectId);
await other.req("PATCH", "/api/projects", { action: "accept", member_id: inv?.id });
r = await other.req("GET", `/api/files?id=${projFile}&download=1`);
rec("project member can download shared file", r.status === 200 && r.text.includes("%PDF"), String(r.status));
r = await other.req("GET", `/api/files?id=${fileId}&download=1`);
rec("project member cannot download owner's private file", r.status === 404, String(r.status));

r = await owner.req("DELETE", `/api/files?id=${fileId}`);
rec("delete private file", r.status === 200, r.json?.error);
r = await owner.req("GET", `/api/files?id=${fileId}`);
rec("deleted file gone", r.status === 404, String(r.status));

const failed = steps.filter((s) => !s.ok);
console.log(JSON.stringify({ pass: steps.filter((s) => s.ok).length, fail: failed.length, total: steps.length, failed: failed.map((s) => s.name) }, null, 2));
process.exit(failed.length ? 1 : 0);
