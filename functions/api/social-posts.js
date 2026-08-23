import { ensureSchema, getUserFromRequest, json, nowIso, originFrom, readJson, uid, writeAudit } from "../_lib/core.js";
import { executeTool, isComposioConfigured } from "../_lib/composio.js";
import { attachGeneratedImage, composeCaptionDraft, slimAttempts } from "../_lib/social-compose.js";
import { createSocialCampaign } from "../_lib/social-schedule.js";
import { publicPlatforms, requirePlatform, getPlatform } from "../_lib/social-platforms.js";
import { QUALITY_PASS, scoreSocialPost } from "../_lib/social-quality.js";
import { activeNextdoor, isNextdoorOAuthConfigured } from "../_lib/nextdoor.js";
import { activeTikTok, isTikTokOAuthConfigured } from "../_lib/tiktok.js";

const INSTAGRAM = "instagram";
const DEFAULT_IMAGE = "/assets/social/amberone-professional-post.png";

function publicImageUrl(request, imageUrl) {
  const raw = String(imageUrl || DEFAULT_IMAGE).trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  const origin = originFrom(request);
  return `${origin}${raw.startsWith("/") ? raw : `/${raw}`}`;
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

async function activeInstagram(db, userId) {
  return db
    .prepare(
      `SELECT id, composio_connected_account_id, status, metadata_json
       FROM connected_accounts
       WHERE user_id = ? AND toolkit = ?
       ORDER BY CASE WHEN lower(status) = 'active' THEN 0 ELSE 1 END, updated_at DESC
       LIMIT 1`,
    )
    .bind(userId, INSTAGRAM)
    .first();
}

async function igUserFromConnection(env, connection, userId) {
  const meta = (() => {
    try {
      return JSON.parse(connection?.metadata_json || "{}");
    } catch {
      return {};
    }
  })();
  if (meta.ig_user_id) return { igUserId: meta.ig_user_id, username: meta.ig_username || null, profile: meta };

  if (!connection?.composio_connected_account_id || !isComposioConfigured(env)) return null;
  const info = await executeTool(env, {
    slug: "INSTAGRAM_GET_USER_INFO",
    userId,
    connectedAccountId: connection.composio_connected_account_id,
    arguments: {},
  });
  const igUserId = pickDeep(info, ["ig_user_id", "user_id", "id"]);
  const username = pickDeep(info, ["username", "name"]);
  return { igUserId: igUserId ? String(igUserId) : null, username: username ? String(username) : null, profile: info };
}

export async function onRequestGet(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const connection = await activeInstagram(db, user.id);
  const igConnected = Boolean(connection && String(connection.status).toUpperCase() === "ACTIVE");
  const ndConnection = await activeNextdoor(db, user.id);
  const ndConnected = Boolean(ndConnection && String(ndConnection.status).toUpperCase() === "ACTIVE");
  const ttConnection = await activeTikTok(db, user.id);
  const ttConnected = Boolean(ttConnection && String(ttConnection.status).toUpperCase() === "ACTIVE");
  const posts = await db
    .prepare("SELECT * FROM social_posts WHERE user_id = ? ORDER BY created_at DESC LIMIT 50")
    .bind(user.id)
    .all();

  return json({
    platforms: publicPlatforms({ instagram: igConnected, nextdoor: ndConnected, tiktok: ttConnected }),
    defaultImageUrl: null,
    qualityPass: QUALITY_PASS,
    posts: posts.results || [],
    composioConfigured: isComposioConfigured(context.env),
    nextdoorConfigured: isNextdoorOAuthConfigured(context.env),
    tiktokConfigured: isTikTokOAuthConfigured(context.env),
  });
}

export async function onRequestPost(context) {
  const db = context.env.DB;
  if (!db) return json({ error: "Database not configured" }, 503);
  await ensureSchema(db);
  const user = await getUserFromRequest(db, context.request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await readJson(context.request);
  const action = String(body.action || "create").toLowerCase();
  const ts = nowIso();

  if (action === "schedule-campaign") {
    try {
      const campaign = await createSocialCampaign(db, user, {
        platform: body.platform || "all",
        platforms: body.platforms || null,
        days: body.days || 14,
        hour: body.hour || 10,
        minute: body.minute || 0,
        slots: body.slots || null,
        label: body.label || "",
      });
      return json(
        {
          ok: true,
          campaign,
          qualityPass: QUALITY_PASS,
          next: "Amber writes, scores, calendars, and publishes Instagram and Nextdoor from a cloud job. You can close the browser.",
        },
        201,
      );
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Could not schedule campaign" }, err?.status || 502);
    }
  }

  if (action === "compose") {
    let spec;
    try {
      spec = requirePlatform(body.platform || INSTAGRAM);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Unsupported platform" }, err?.status || 400);
    }
    if (!spec.canCompose) {
      return json({ error: `${spec.label} drafts are not available yet.` }, 503);
    }
    let composed;
    try {
      composed = await composeCaptionDraft({
        env: context.env,
        db,
        user,
        extraBrief: body.brief || {},
        platform: spec.id,
      });
    } catch (err) {
      const payload = {
        error: err instanceof Error ? err.message : "Compose failed",
        code: err?.code || null,
        score: err?.score || null,
        attempts: err?.attempts ? slimAttempts(err.attempts) : null,
        missing: err?.missing || null,
      };
      return json(payload, err?.status || 502);
    }
    const postId = uid("spost");
    const token = uid("img").replace(/^img_/, "");
    await db
      .prepare(
        `INSERT INTO social_posts (id, user_id, platform, caption, image_url, status, connected_account_id, ig_user_id, ig_username, creation_id, error, created_at, updated_at, quality_json, brief_json, attempts_json, image_token, image_prompt)
         VALUES (?, ?, ?, ?, ?, 'composing', NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        postId,
        user.id,
        spec.id,
        composed.caption,
        null,
        ts,
        ts,
        JSON.stringify({
          total: composed.estimatedWithImage,
          passed: false,
          stage: "caption_only",
          categories: composed.captionScore.categories,
          reasons: composed.captionScore.reasons,
        }),
        JSON.stringify(composed.brief),
        JSON.stringify(composed.attempts),
        token,
        composed.imagePrompt,
      )
      .run();
    const post = await db.prepare("SELECT * FROM social_posts WHERE id = ?").bind(postId).first();
    await writeAudit(db, {
      userId: user.id,
      action: "social.compose",
      resourceType: "social_post",
      resourceId: postId,
      meta: { estimated: composed.estimatedWithImage, attempts: composed.attempts.length, stage: "caption_only", platform: spec.id },
    });
    return json({
      ok: true,
      post,
      brief: composed.brief,
      attempts: slimAttempts(composed.attempts),
      estimatedWithImage: composed.estimatedWithImage,
      score: {
        ...composed.captionScore,
        estimatedWithImage: composed.estimatedWithImage,
        passed: false,
        stage: "caption_only",
      },
      qualityPass: QUALITY_PASS,
      platform: spec.id,
      stage: "caption_ready",
      next: "Amber still needs a matching generated image before this draft can pass. Call render-image next.",
    });
  }

  if (action === "render-image") {
    const id = String(body.id || "");
    const pending = id ? await db.prepare("SELECT * FROM social_posts WHERE id = ? AND user_id = ?").bind(id, user.id).first() : null;
    if (!pending) return json({ error: "Post not found." }, 404);
    if (!pending.caption || !pending.image_prompt) {
      return json({ error: "This post has no caption or image brief yet. Create it with Amber first." }, 400);
    }
    let rendered;
    try {
      rendered = await attachGeneratedImage({
        env: context.env,
        db,
        user,
        requestOrigin: originFrom(context.request),
        post: pending,
      });
    } catch (err) {
      if (err?.code === "quality_gate") {
        await db
          .prepare("UPDATE social_posts SET status = 'rejected_quality', error = ?, quality_json = ?, attempts_json = ?, updated_at = ? WHERE id = ?")
          .bind(err.message, JSON.stringify(err.score || {}), JSON.stringify(err.attempts || []), ts, pending.id)
          .run();
      }
      return json(
        {
          error: err instanceof Error ? err.message : "Image render failed",
          code: err?.code || null,
          score: err?.score || null,
          attempts: err?.attempts ? slimAttempts(err.attempts) : null,
        },
        err?.status || 502,
      );
    }
    await db
      .prepare(
        `UPDATE social_posts
         SET caption = ?, image_url = ?, status = 'draft', error = NULL, quality_json = ?, attempts_json = ?, image_token = ?, image_prompt = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(
        rendered.caption,
        rendered.imageUrl,
        JSON.stringify(rendered.score),
        JSON.stringify(rendered.attempts),
        rendered.token,
        rendered.imagePrompt,
        ts,
        pending.id,
      )
      .run();
    const post = await db.prepare("SELECT * FROM social_posts WHERE id = ?").bind(pending.id).first();
    await writeAudit(db, {
      userId: user.id,
      action: "social.render_image",
      resourceType: "social_post",
      resourceId: pending.id,
      meta: { total: rendered.score.total, passed: true },
    });
    return json(
      {
        ok: true,
        post,
        score: rendered.score,
        brief: rendered.brief,
        attempts: slimAttempts(rendered.attempts),
        qualityPass: QUALITY_PASS,
        stage: "draft_ready",
        next: getPlatform(pending.platform)?.canPrepare
          ? "Review. Prepare sends an unpublished draft container. Publish is not run automatically."
          : getPlatform(pending.platform)?.publishUnavailable || "Draft saved. Live publishing is not connected for this network yet.",
      },
      201,
    );
  }

  if (action === "create") {
    let spec;
    try {
      spec = requirePlatform(body.platform || INSTAGRAM);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Unsupported platform" }, err?.status || 400);
    }
    if (!spec.canCompose) {
      return json({ error: `${spec.label} drafts are not available yet.` }, 503);
    }
    const caption = String(body.caption || "").trim();
    if (caption.length < 8) return json({ error: "Write a caption of at least a few words." }, 400);
    if (caption.length > spec.maxCaption) {
      return json({ error: `${spec.label} captions must be ${spec.maxCaption.toLocaleString()} characters or less.` }, 400);
    }
    const imageUrl = publicImageUrl(context.request, body.image_url || DEFAULT_IMAGE);
    const briefRow = await db.prepare("SELECT * FROM business_profiles WHERE user_id = ?").bind(user.id).first();
    const score = scoreSocialPost({
      caption,
      brief: briefRow || { name: user.name, sells: "", audience: "", offer: "", location: "" },
      imageUrl,
      imagePrompt: body.image_prompt || "",
      platform: spec.id,
    });
    if (!score.passed) {
      return json(
        {
          error: `Quality gate failed at ${score.total}/100. Amber will not save a ${spec.label} draft below ${QUALITY_PASS}.`,
          code: "quality_gate",
          score,
          platform: spec.id,
        },
        422,
      );
    }
    const id = uid("spost");
    await db
      .prepare(
        `INSERT INTO social_posts (id, user_id, platform, caption, image_url, status, connected_account_id, ig_user_id, ig_username, creation_id, error, created_at, updated_at, quality_json)
         VALUES (?, ?, ?, ?, ?, 'draft', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .bind(id, user.id, spec.id, caption, imageUrl, ts, ts, JSON.stringify(score))
      .run();
    const post = await db.prepare("SELECT * FROM social_posts WHERE id = ?").bind(id).first();
    await writeAudit(db, { userId: user.id, action: "social.draft", resourceType: "social_post", resourceId: id, meta: { platform: spec.id, total: score.total } });
    return json({
      ok: true,
      post,
      score,
      qualityPass: QUALITY_PASS,
      platform: spec.id,
      next: spec.canPrepare
        ? "Review the preview, then Prepare. Amber will not publish until you click Publish."
        : spec.publishUnavailable || "Draft saved. Live publishing is not connected for this network yet.",
    }, 201);
  }

  const id = String(body.id || "");
  const post = id ? await db.prepare("SELECT * FROM social_posts WHERE id = ? AND user_id = ?").bind(id, user.id).first() : null;
  if (!post) return json({ error: "Post not found." }, 404);

  if (action === "prepare") {
    const spec = getPlatform(post.platform);
    if (!spec?.canPrepare) {
      return json(
        {
          error: spec?.publishUnavailable || "Live publishing is not connected for this network yet. The scored draft is saved.",
          code: "publish_unavailable",
          platform: post.platform,
        },
        503,
      );
    }
    try {
      const quality = post.quality_json ? JSON.parse(post.quality_json) : null;
      if (!quality?.passed || Number(quality.total) < QUALITY_PASS) {
        return json(
          {
            error: `This ${spec.label} draft is below ${QUALITY_PASS}/100. Amber will not prepare it.`,
            code: "quality_gate",
            score: quality,
          },
          422,
        );
      }
    } catch {
      return json({ error: "This draft has no quality score. Create it with Amber first." }, 422);
    }
    if (post.platform === "nextdoor") {
      const nd = await activeNextdoor(db, user.id);
      if (!nd || String(nd.status).toUpperCase() !== "ACTIVE") {
        return json(
          {
            error: "Nextdoor is not connected yet. Open Connections, connect Nextdoor, then the cloud scheduler can publish.",
            code: "nextdoor_not_connected",
            connectPath: "/dashboard/connections",
          },
          400,
        );
      }
      await db
        .prepare("UPDATE social_posts SET status = 'prepared', connected_account_id = ?, error = NULL, updated_at = ? WHERE id = ?")
        .bind(nd.id, ts, post.id)
        .run();
      return json({
        ok: true,
        stage: "scheduled_cloud",
        message: "Nextdoor is connected. The cloud job will publish this post at the scheduled time.",
      });
    }
    const connection = await activeInstagram(db, user.id);
    if (!connection || String(connection.status).toUpperCase() !== "ACTIVE" || !connection.composio_connected_account_id) {
      return json(
        {
          error: "Instagram is not connected yet. Open Connections, connect Instagram, then Prepare this post.",
          code: "instagram_not_connected",
          connectPath: "/dashboard/connections",
        },
        400,
      );
    }
    if (!isComposioConfigured(context.env)) {
      return json({ error: "Instagram publishing is not configured on this site yet." }, 503);
    }

    let ig;
    try {
      ig = await igUserFromConnection(context.env, connection, user.id);
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : "Could not read the Instagram account." }, 502);
    }
    if (!ig?.igUserId) {
      return json({ error: "Connected Instagram did not return a business account id. Reconnect Instagram and try again." }, 400);
    }

    let toolResult;
    try {
      toolResult = await executeTool(context.env, {
        slug: "INSTAGRAM_CREATE_MEDIA_CONTAINER",
        userId: user.id,
        connectedAccountId: connection.composio_connected_account_id,
        arguments: {
          ig_user_id: String(ig.igUserId),
          image_url: post.image_url,
          caption: post.caption,
          content_type: "photo",
        },
      });
    } catch (err) {
      await db
        .prepare("UPDATE social_posts SET status = 'failed', error = ?, updated_at = ? WHERE id = ?")
        .bind(err instanceof Error ? err.message : String(err), ts, post.id)
        .run();
      return json({ error: err instanceof Error ? err.message : "Instagram rejected the draft container." }, err?.status || 502);
    }

    const creationId = pickDeep(toolResult, ["creation_id", "id", "container_id"]);
    if (!creationId) {
      return json({ error: "Instagram did not return a draft container id.", detail: Object.keys(toolResult || {}) }, 502);
    }

    await db
      .prepare(
        `UPDATE social_posts
         SET status = 'prepared', connected_account_id = ?, ig_user_id = ?, ig_username = ?, creation_id = ?, error = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .bind(connection.id, String(ig.igUserId), ig.username || null, String(creationId), ts, post.id)
      .run();
    await writeAudit(db, {
      userId: user.id,
      action: "social.prepare",
      resourceType: "social_post",
      resourceId: post.id,
      meta: { platform: "instagram", creationId: String(creationId), via: "composio_container" },
    });
    const updated = await db.prepare("SELECT * FROM social_posts WHERE id = ?").bind(post.id).first();
    return json({
      ok: true,
      post: updated,
      stage: "pre_publish",
      stoppedBefore: "INSTAGRAM_CREATE_POST / media_publish",
      message: "Instagram accepted an unpublished draft container. Do not click Publish unless you intend to post it live.",
    });
  }

  if (action === "publish") {
    return json(
      {
        error: "Live publish is blocked for beta testing. Drafts stay unpublished.",
        code: "publish_blocked",
        stage: "pre_publish",
        platform: post.platform,
      },
      403,
    );
  }

  return json({ error: "Unknown action. Use compose, render-image, create, prepare, or publish." }, 400);
}
