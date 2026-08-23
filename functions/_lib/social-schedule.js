import { nowIso, uid, writeAudit } from "./core.js";
import { executeTool, isComposioConfigured } from "./composio.js";
import { attachGeneratedImage, composeCaptionDraft } from "./social-compose.js";
import { getPlatform, resolveCampaignPlatforms } from "./social-platforms.js";
import { QUALITY_PASS } from "./social-quality.js";
import { isBetaAccount } from "./beta.js";
import {
  activeNextdoor,
  createNextdoorPost,
  fetchNextdoorProfiles,
  getNextdoorAccessToken,
  isNextdoorOAuthConfigured,
  pickNextdoorProfile,
} from "./nextdoor.js";
import { activeTikTok, getTikTokAccessToken, isTikTokOAuthConfigured, publishTikTokPhoto } from "./tiktok.js";

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

function pickDeep(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    if (obj[key]) return obj[key];
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") {
      const found = pickDeep(value, keys);
      if (found) return found;
    }
  }
  return null;
}

export async function activeInstagram(db, userId) {
  return db
    .prepare(
      `SELECT id, composio_connected_account_id, status, metadata_json
       FROM connected_accounts
       WHERE user_id = ? AND toolkit = 'instagram'
       ORDER BY CASE WHEN lower(status) = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(userId)
    .first();
}

async function igUserFromConnection(env, connection, userId) {
  const meta = parseJsonSafe(connection?.metadata_json);
  if (meta.ig_user_id) return { igUserId: String(meta.ig_user_id), username: meta.ig_username || null };
  if (!connection?.composio_connected_account_id || !isComposioConfigured(env)) return null;
  const info = await executeTool(env, {
    slug: "INSTAGRAM_GET_USER_INFO",
    userId,
    connectedAccountId: connection.composio_connected_account_id,
    arguments: {},
  });
  const igUserId = pickDeep(info, ["ig_user_id", "user_id", "id"]);
  const username = pickDeep(info, ["username", "name"]);
  return { igUserId: igUserId ? String(igUserId) : null, username: username ? String(username) : null };
}

function pacificSlotIso(dayOffset, hour = 10, minute = 0) {
  const now = new Date();
  const tzNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const start = new Date(tzNow);
  start.setDate(start.getDate() + dayOffset);
  start.setHours(hour, minute, 0, 0);
  const offsetMs = start.getTime() - tzNow.getTime();
  return new Date(now.getTime() + offsetMs).toISOString();
}

async function addCalendarEvent(db, user, { title, description, startsAt }) {
  const id = uid("evt");
  const ts = nowIso();
  const endsAt = new Date(new Date(startsAt).getTime() + 30 * 60 * 1000).toISOString();
  await db
    .prepare(
      `INSERT INTO calendar_events (id, user_id, title, description, location, starts_at, ends_at, all_day, recurrence, attendees, visibility, team_id, external_id, external_source, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, NULL, NULL, 'private', NULL, NULL, 'amberone-social', ?, ?)`,
    )
    .bind(id, user.id, title.slice(0, 200), description || null, startsAt, endsAt, ts, ts)
    .run();
  return id;
}

function platformClause(platform) {
  if (!platform) return { sql: "", bind: [] };
  return { sql: " AND platform = ?", bind: [String(platform).toLowerCase()] };
}

function bindAll(stmt, values) {
  return values.length ? stmt.bind(...values) : stmt;
}

export async function createSocialCampaign(db, user, { platform, platforms, days = 14, hour = 10, minute = 0, slots = null, label = "" }) {
  const specs = resolveCampaignPlatforms(platform, platforms)
    .map((id) => getPlatform(id))
    .filter((s) => s?.canCompose);
  if (!specs.length) {
    throw Object.assign(new Error("That network cannot be drafted yet."), { status: 400 });
  }
  const count = Array.isArray(slots) ? slots.length : Math.min(14, Math.max(1, Number(days) || 14));
  const campaignId = uid("scamp");
  const ts = nowIso();
  const times = Array.isArray(slots) && slots.length
    ? slots.map((s) => String(s))
    : Array.from({ length: count }, (_, i) => pacificSlotIso(i + 1, hour, minute));

  const posts = [];
  for (const spec of specs) {
    const extraMin = spec.id === "nextdoor" && !(Array.isArray(slots) && slots.length) ? 120 : 0;
    for (const raw of times) {
      const scheduledAt = extraMin
        ? new Date(new Date(raw).getTime() + extraMin * 60 * 1000).toISOString()
        : String(raw);
      const postId = uid("spost");
      await db
        .prepare(
          `INSERT INTO social_posts (id, user_id, platform, caption, image_url, status, connected_account_id, ig_user_id, ig_username, creation_id, error, created_at, updated_at, campaign_id, scheduled_at)
           VALUES (?, ?, ?, '', NULL, 'pending_compose', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)`,
        )
        .bind(postId, user.id, spec.id, ts, ts, campaignId, scheduledAt)
        .run();
      posts.push({ id: postId, platform: spec.id, scheduledAt, status: "pending_compose" });
    }
  }

  await writeAudit(db, {
    userId: user.id,
    action: "social.campaign",
    resourceType: "social_campaign",
    resourceId: campaignId,
    meta: { platforms: specs.map((s) => s.id), count: posts.length, label: label || null },
  });

  const both = specs.length > 1;
  return {
    campaignId,
    platforms: specs.map((s) => s.id),
    platform: both ? "all" : specs[0].id,
    canPublish: specs.every((s) => s.canPublish),
    publishNote: both
      ? "Instagram and Nextdoor both run from the same cloud job. Each network publishes when that account is connected. You can close the browser."
      : specs[0].canPublish
        ? `${specs[0].label} auto-publish runs in the cloud when the account is connected. The scheduler does not need the browser open.`
        : specs[0].publishUnavailable,
    posts,
  };
}

export async function composeNextCampaignPost({ env, db, origin, platform = null }) {
  const filter = platformClause(platform);
  const row = await bindAll(
    db.prepare(
      `SELECT * FROM social_posts
       WHERE status = 'pending_compose' AND campaign_id IS NOT NULL${filter.sql}
       ORDER BY scheduled_at ASC
       LIMIT 1`,
    ),
    filter.bind,
  ).first();
  if (!row) return { did: "none" };
  const user = { id: row.user_id, name: "", email: "" };
  const extra = parseJsonSafe(row.brief_json);
  try {
    const composed = await composeCaptionDraft({
      env,
      db,
      user,
      extraBrief: extra,
      platform: row.platform,
    });
    const priorAttempts = Array.isArray(parseJsonSafe(row.attempts_json)) ? parseJsonSafe(row.attempts_json) : [];
    const requeues = priorAttempts.filter((a) => a.kind === "campaign_requeue");
    await db
      .prepare(
        `UPDATE social_posts
         SET caption = ?, image_prompt = ?, brief_json = ?, attempts_json = ?, quality_json = ?, status = 'composing', updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        composed.caption,
        composed.imagePrompt,
        JSON.stringify(composed.brief),
        JSON.stringify([...requeues, ...(composed.attempts || [])]),
        JSON.stringify({
          total: composed.estimatedWithImage,
          passed: false,
          stage: "caption_only",
          categories: composed.captionScore.categories,
          reasons: composed.captionScore.reasons,
        }),
        nowIso(),
        row.id,
      )
      .run();
    return { did: "compose", id: row.id, platform: row.platform, estimated: composed.estimatedWithImage };
  } catch (err) {
    await db
      .prepare("UPDATE social_posts SET status = 'rejected_quality', error = ?, updated_at = ? WHERE id = ?")
      .bind(err instanceof Error ? err.message : String(err), nowIso(), row.id)
      .run();
    return { did: "compose_failed", id: row.id, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function renderNextCampaignImage({ env, db, origin, platform = null }) {
  const filter = platformClause(platform);
  const row = await bindAll(
    db.prepare(
      `SELECT * FROM social_posts
       WHERE status = 'composing' AND campaign_id IS NOT NULL AND caption != '' AND image_prompt IS NOT NULL${filter.sql}
       ORDER BY scheduled_at ASC
       LIMIT 1`,
    ),
    filter.bind,
  ).first();
  if (!row) return { did: "none" };
  const user = { id: row.user_id, name: "", email: "" };
  try {
    const rendered = await attachGeneratedImage({
      env,
      db,
      user,
      requestOrigin: origin,
      post: row,
    });
    if (!rendered.score?.passed || Number(rendered.score.total) < QUALITY_PASS) {
      throw Object.assign(new Error(`Quality gate failed at ${rendered.score?.total}/100.`), { code: "quality_gate" });
    }
    const eventId = await addCalendarEvent(db, user, {
      title: `${getPlatform(row.platform)?.label || row.platform} post`,
      description: rendered.caption.slice(0, 500),
      startsAt: row.scheduled_at,
    });
    await db
      .prepare(
        `UPDATE social_posts
         SET caption = ?, image_url = ?, status = 'scheduled', error = NULL, quality_json = ?, attempts_json = ?,
             image_token = ?, image_prompt = ?, calendar_event_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        rendered.caption,
        rendered.imageUrl,
        JSON.stringify(rendered.score),
        JSON.stringify(rendered.attempts),
        rendered.token,
        rendered.imagePrompt,
        eventId,
        nowIso(),
        row.id,
      )
      .run();
    return {
      did: "schedule",
      id: row.id,
      platform: row.platform,
      score: rendered.score.total,
      passed: rendered.score.passed,
      calendarEventId: eventId,
      scheduledAt: row.scheduled_at,
    };
  } catch (err) {
    const attempts = Array.isArray(parseJsonSafe(row.attempts_json)) ? parseJsonSafe(row.attempts_json) : [];
    const requeues = attempts.filter((a) => a.kind === "campaign_requeue").length;
    if ((err?.code === "quality_gate" || /Quality gate failed/i.test(String(err?.message || ""))) && requeues < 2) {
      attempts.push({
        n: attempts.length,
        kind: "campaign_requeue",
        accepted: false,
        reasons: [err instanceof Error ? err.message : String(err)],
      });
      await db
        .prepare(
          `UPDATE social_posts
           SET status = 'pending_compose', caption = '', image_prompt = NULL, image_url = NULL, quality_json = NULL,
               error = ?, attempts_json = ?, updated_at = ?
           WHERE id = ?`,
        )
        .bind(err instanceof Error ? err.message : String(err), JSON.stringify(attempts), nowIso(), row.id)
        .run();
      return { did: "requeue_compose", id: row.id, platform: row.platform, attempt: requeues + 1 };
    }
    await db
      .prepare("UPDATE social_posts SET status = 'rejected_quality', error = ?, updated_at = ? WHERE id = ?")
      .bind(err instanceof Error ? err.message : String(err), nowIso(), row.id)
      .run();
    return { did: "render_failed", id: row.id, error: err instanceof Error ? err.message : String(err), code: err?.code || null };
  }
}

export async function publishDueSocialPost({ env, db, platform = null }) {
  const filter = platformClause(platform);
  const row = await db
    .prepare(
      `SELECT * FROM social_posts
       WHERE status = 'scheduled' AND campaign_id IS NOT NULL AND scheduled_at IS NOT NULL AND scheduled_at <= ?${filter.sql}
       ORDER BY scheduled_at ASC
       LIMIT 1`,
    )
    .bind(nowIso(), ...filter.bind)
    .first();
  if (!row) return { did: "none" };

  const spec = getPlatform(row.platform);
  const userRow = await db.prepare("SELECT id, email, name, account_kind, plan_slug FROM users WHERE id = ?").bind(row.user_id).first();
  const quality = parseJsonSafe(row.quality_json);
  if (!quality?.passed || Number(quality.total) < QUALITY_PASS) {
    await db
      .prepare("UPDATE social_posts SET status = 'rejected_quality', error = ?, updated_at = ? WHERE id = ?")
      .bind("Quality score dropped below 95 before publish.", nowIso(), row.id)
      .run();
    return { did: "quality_block", id: row.id };
  }

  if (!spec?.canPublish) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_unavailable', error = ?, updated_at = ? WHERE id = ?")
      .bind(spec?.publishUnavailable || "No live publishing API for this network.", nowIso(), row.id)
      .run();
    return {
      did: "publish_unavailable",
      id: row.id,
      platform: row.platform,
      reason: spec?.publishUnavailable || "No partner posting API.",
    };
  }

  if (userRow && isBetaAccount(userRow)) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_blocked_beta', error = ?, updated_at = ? WHERE id = ?")
      .bind("Beta workspaces cannot publish live to customer social accounts.", nowIso(), row.id)
      .run();
    return { did: "beta_block", id: row.id, platform: row.platform };
  }

  if (row.platform === "nextdoor") {
    if (!isNextdoorOAuthConfigured(env)) {
      await db
        .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
        .bind("Nextdoor publishing is not configured on Amber One yet.", nowIso(), row.id)
        .run();
      return { did: "not_configured", id: row.id, platform: "nextdoor", code: "nextdoor_not_configured" };
    }
    const connection = await activeNextdoor(db, row.user_id);
    if (!connection || String(connection.status).toUpperCase() !== "ACTIVE") {
      await db
        .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
        .bind("Nextdoor is not connected. Connect a Business Page, then Amber can auto-publish from the cloud.", nowIso(), row.id)
        .run();
      return { did: "not_connected", id: row.id, platform: "nextdoor", code: "nextdoor_not_connected" };
    }
    try {
      const auth = await getNextdoorAccessToken(env, db, connection);
      if (!auth?.accessToken) {
        throw Object.assign(new Error("Nextdoor is not connected. Connect a Business Page, then Amber can auto-publish from the cloud."), {
          code: "nextdoor_not_connected",
        });
      }
      let profileId = auth.meta?.profile_id;
      if (!profileId) {
        const profiles = await fetchNextdoorProfiles(auth.accessToken);
        profileId = pickNextdoorProfile(profiles)?.profileId || null;
      }
      const published = await createNextdoorPost(auth.accessToken, {
        caption: row.caption,
        imageUrl: row.image_url,
        profileId,
      });
      await db
        .prepare("UPDATE social_posts SET status = 'published', error = NULL, published_at = ?, connected_account_id = ?, updated_at = ? WHERE id = ?")
        .bind(nowIso(), connection.id, nowIso(), row.id)
        .run();
      await writeAudit(db, {
        userId: row.user_id,
        action: "social.auto_publish",
        resourceType: "social_post",
        resourceId: row.id,
        meta: { platform: "nextdoor", shareLink: published?.share_link || null, via: "cloud_cron" },
      });
      return { did: "published", id: row.id, platform: "nextdoor", shareLink: published?.share_link || null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notConnected = err?.code === "nextdoor_not_connected" || /not connected/i.test(message);
      await db
        .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(message, nowIso(), row.id)
        .run();
      return { did: notConnected ? "not_connected" : "publish_failed", id: row.id, platform: "nextdoor", error: message };
    }
  }

  if (row.platform === "tiktok") {
    if (!isTikTokOAuthConfigured(env)) {
      await db
        .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
        .bind("TikTok publishing is not configured on Amber One yet.", nowIso(), row.id)
        .run();
      return { did: "not_configured", id: row.id, platform: "tiktok", code: "tiktok_not_configured" };
    }
    const connection = await activeTikTok(db, row.user_id);
    if (!connection || String(connection.status).toUpperCase() !== "ACTIVE") {
      await db
        .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
        .bind("TikTok is not connected. Connect the account, then Amber can auto-publish from the cloud.", nowIso(), row.id)
        .run();
      return { did: "not_connected", id: row.id, platform: "tiktok", code: "tiktok_not_connected" };
    }
    try {
      const auth = await getTikTokAccessToken(env, db, connection);
      if (!auth?.accessToken) {
        throw Object.assign(new Error("TikTok is not connected. Connect the account, then Amber can auto-publish from the cloud."), {
          code: "tiktok_not_connected",
        });
      }
      const published = await publishTikTokPhoto(auth.accessToken, {
        caption: row.caption,
        imageUrl: row.image_url,
      });
      await db
        .prepare("UPDATE social_posts SET status = 'published', error = NULL, published_at = ?, connected_account_id = ?, updated_at = ? WHERE id = ?")
        .bind(nowIso(), connection.id, nowIso(), row.id)
        .run();
      await writeAudit(db, {
        userId: row.user_id,
        action: "social.auto_publish",
        resourceType: "social_post",
        resourceId: row.id,
        meta: {
          platform: "tiktok",
          publishId: published?.publish_id || null,
          privacyLevel: published?.privacyLevel || null,
          via: "cloud_cron",
        },
      });
      return {
        did: "published",
        id: row.id,
        platform: "tiktok",
        publishId: published?.publish_id || null,
        privacyLevel: published?.privacyLevel || null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const notConnected = err?.code === "tiktok_not_connected" || /not connected/i.test(message);
      await db
        .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(message, nowIso(), row.id)
        .run();
      return { did: notConnected ? "not_connected" : "publish_failed", id: row.id, platform: "tiktok", error: message };
    }
  }

  if (row.platform !== "instagram") {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_unavailable', error = ?, updated_at = ? WHERE id = ?")
      .bind("Amber One has no live publisher for this network.", nowIso(), row.id)
      .run();
    return { did: "publish_unavailable", id: row.id, platform: row.platform };
  }

  const connection = await activeInstagram(db, row.user_id);
  if (!connection || String(connection.status).toUpperCase() !== "ACTIVE" || !connection.composio_connected_account_id) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind("Instagram is not connected. Connect a Business account, then Amber can auto-publish from the cloud.", nowIso(), row.id)
      .run();
    return { did: "not_connected", id: row.id, platform: "instagram", code: "instagram_not_connected" };
  }
  if (!isComposioConfigured(env)) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind("Instagram publishing is not configured on Amber One.", nowIso(), row.id)
      .run();
    return { did: "not_configured", id: row.id };
  }

  let ig;
  try {
    ig = await igUserFromConnection(env, connection, row.user_id);
  } catch (err) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(err instanceof Error ? err.message : String(err), nowIso(), row.id)
      .run();
    return { did: "ig_profile_failed", id: row.id };
  }
  if (!ig?.igUserId) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind("Connected Instagram did not return a business account id.", nowIso(), row.id)
      .run();
    return { did: "no_ig_user", id: row.id };
  }

  let creationId = row.creation_id;
  try {
    if (!creationId) {
      const container = await executeTool(env, {
        slug: "INSTAGRAM_CREATE_MEDIA_CONTAINER",
        userId: row.user_id,
        connectedAccountId: connection.composio_connected_account_id,
        arguments: {
          ig_user_id: String(ig.igUserId),
          image_url: row.image_url,
          caption: row.caption,
          content_type: "photo",
        },
      });
      creationId = pickDeep(container, ["creation_id", "id", "container_id"]);
      if (!creationId) {
        throw Object.assign(new Error("Instagram did not return a media container id."), { status: 502 });
      }
      await db
        .prepare("UPDATE social_posts SET creation_id = ?, ig_user_id = ?, ig_username = ?, connected_account_id = ?, updated_at = ? WHERE id = ?")
        .bind(String(creationId), String(ig.igUserId), ig.username || null, connection.id, nowIso(), row.id)
        .run();
    }
    const published = await executeTool(env, {
      slug: "INSTAGRAM_CREATE_POST",
      userId: row.user_id,
      connectedAccountId: connection.composio_connected_account_id,
      arguments: {
        ig_user_id: String(ig.igUserId),
        creation_id: String(creationId),
      },
    });
    const mediaId = pickDeep(published, ["id", "media_id", "post_id"]);
    await db
      .prepare("UPDATE social_posts SET status = 'published', error = NULL, published_at = ?, updated_at = ? WHERE id = ?")
      .bind(nowIso(), nowIso(), row.id)
      .run();
    await writeAudit(db, {
      userId: row.user_id,
      action: "social.auto_publish",
      resourceType: "social_post",
      resourceId: row.id,
      meta: { platform: "instagram", mediaId: mediaId || null, via: "cloud_cron" },
    });
    return { did: "published", id: row.id, platform: "instagram", mediaId: mediaId || null };
  } catch (err) {
    await db
      .prepare("UPDATE social_posts SET status = 'publish_failed', error = ?, updated_at = ? WHERE id = ?")
      .bind(err instanceof Error ? err.message : String(err), nowIso(), row.id)
      .run();
    return { did: "publish_failed", id: row.id, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function runSocialCronTick({ env, db, origin, platform = null }) {
  const filter = platformClause(platform);
  const stuck = await bindAll(
    db.prepare(
      `SELECT id, attempts_json FROM social_posts
       WHERE status IN ('pending_compose', 'composing') AND campaign_id IS NOT NULL${filter.sql}
       LIMIT 25`,
    ),
    filter.bind,
  ).all();
  for (const row of stuck.results || []) {
    const attempts = parseJsonSafe(row.attempts_json);
    const requeues = (Array.isArray(attempts) ? attempts : []).filter((a) => a.kind === "campaign_requeue").length;
    if (requeues >= 2) {
      await db
        .prepare("UPDATE social_posts SET status = 'rejected_quality', error = ?, updated_at = ? WHERE id = ?")
        .bind("Quality gate failed after 2 regenerations.", nowIso(), row.id)
        .run();
    }
  }
  const published = await publishDueSocialPost({ env, db, platform });
  if (published.did !== "none") return { ...published, tick: "publish", lane: platform || "all" };
  const image = await renderNextCampaignImage({ env, db, origin, platform });
  if (image.did !== "none") return { ...image, tick: "render", lane: platform || "all" };
  const composed = await composeNextCampaignPost({ env, db, origin, platform });
  if (composed.did !== "none") return { ...composed, tick: "compose", lane: platform || "all" };
  return { did: "none", tick: "idle", lane: platform || "all" };
}
