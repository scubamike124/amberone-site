/**
 * Every social network Amber can draft for.
 * Compose always requires the ≥95 quality gate. Publish is separate and may be unavailable.
 */

export const SOCIAL_PLATFORMS = {
  instagram: {
    id: "instagram",
    label: "Instagram",
    canCompose: true,
    canPrepare: true,
    canPublish: true,
    maxCaption: 2200,
    minCaption: 80,
    hashtagMin: 3,
    hashtagMax: 12,
    requireLocation: false,
    imageShape: "Instagram square photo",
    writer:
      "Write an Instagram post for one real business. Strong first-line hook, 3-6 sentences, named business, specific service, customer benefit, one clear CTA, 4-8 relevant hashtags at the end.",
  },
  nextdoor: {
    id: "nextdoor",
    label: "Nextdoor",
    canCompose: true,
    canPrepare: true,
    canPublish: true,
    maxCaption: 1500,
    minCaption: 80,
    hashtagMin: 0,
    hashtagMax: 2,
    requireLocation: true,
    imageShape: "neighborhood photo, square or slightly vertical",
    writer:
      "Write a Nextdoor neighborhood post for one real business. Sound like a local professional, not a national ad. Name the neighborhood or city. Strong first-line hook, 3-6 sentences, specific service, neighbor benefit, one clear CTA (book, call, stop by, or message). 0-2 hashtags maximum. Never use link in bio.",
  },
};

export const QUALITY_PASS = 95;

export function listPlatformIds() {
  return Object.keys(SOCIAL_PLATFORMS);
}

export function listComposablePlatformIds() {
  return listPlatformIds().filter((id) => getPlatform(id)?.canCompose);
}

export function resolveCampaignPlatforms(platform, platforms) {
  if (Array.isArray(platforms) && platforms.length) {
    return [...new Set(platforms.map((p) => requirePlatform(p).id))];
  }
  const raw = String(platform || "all").toLowerCase().trim();
  if (!raw || raw === "all" || raw === "both" || raw === "social") {
    return listComposablePlatformIds();
  }
  return [requirePlatform(raw).id];
}

export function getPlatform(id) {
  const key = String(id || "").toLowerCase().trim();
  return SOCIAL_PLATFORMS[key] || null;
}

export function requirePlatform(id) {
  const platform = getPlatform(id);
  if (!platform) {
    throw Object.assign(
      new Error(`Amber does not support that network yet. Choose ${listPlatformIds().join(" or ")}.`),
      { status: 400, code: "unsupported_platform" },
    );
  }
  return platform;
}

export function publicPlatforms(connectionByToolkit = {}) {
  return Object.values(SOCIAL_PLATFORMS).map((p) => ({
    id: p.id,
    label: p.label,
    canCompose: p.canCompose,
    canPrepare: p.canPrepare,
    canPublish: Boolean(p.canPublish),
    autoPublish: p.canPublish ? "cloud_cron_if_connected" : false,
    connected: Boolean(connectionByToolkit[p.id]),
    qualityPass: QUALITY_PASS,
    reason: p.canPublish
      ? null
      : p.publishUnavailable || `${p.label} drafts are quality-gated; live publishing is not connected yet.`,
  }));
}
