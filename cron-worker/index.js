async function tick(env) {
  const url = env.AMBERONE_CRON_URL || "https://amberoneai.com/api/cron/social";
  const secret = env.CRON_SECRET;
  if (!secret) return { skipped: "missing_secret" };
  const headers = { "Content-Type": "application/json", "X-Cron-Secret": secret };
  const [instagram, nextdoor] = await Promise.all(
    ["instagram", "nextdoor"].map((platform) =>
      fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({ platform }),
      }).then(async (res) => ({ platform, status: res.status, ok: res.ok })),
    ),
  );
  return { instagram, nextdoor };
}

export default {
  async scheduled(event, env) {
    await tick(env);
  },
  async fetch() {
    return Response.json({ ok: true, service: "amberone-social-cron", cadence: "* * * * *" });
  },
};
