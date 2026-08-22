/** Honest Social Post Quality Score. Never inflates to pass. Total 100. Pass >= 95. */

import { QUALITY_PASS as GATE, getPlatform } from "./social-platforms.js";

export const QUALITY_PASS = GATE;

const BANNED = [
  /open for the week/i,
  /test post/i,
  /will not be published/i,
  /professional test/i,
  /lorem ipsum/i,
  /your business here/i,
  /insert company/i,
  /coming soon to a feed/i,
  /we're excited to announce/i,
  /we are excited to announce/i,
];

const CTA = /\b(book|schedule|reserve|order|shop|call|dm|message|comment|save this|tap|link in bio|get on the list|claim|join|visit us|stop by|reply)\b/i;

export function bannedHits(caption) {
  return BANNED.filter((re) => re.test(caption || "")).map((re) => re.source);
}

function words(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[#@]/g, " ")
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 4);
}

function includesAny(hay, needles) {
  const h = String(hay || "").toLowerCase();
  return (needles || []).some((n) => n && h.includes(String(n).toLowerCase()));
}

function keywords(text) {
  return words(text).filter((w) => !/^(this|that|with|from|your|have|been|will|they|them|just|very|into|about|were|also|than)$/.test(w));
}

export function scoreSocialPost({ caption, brief, imageUrl, imagePrompt, platform = "instagram" }) {
  const spec = getPlatform(platform) || getPlatform("instagram");
  const text = String(caption || "").trim();
  const name = String(brief?.name || "").trim();
  const sells = String(brief?.sells || "").trim();
  const audience = String(brief?.audience || "").trim();
  const offer = String(brief?.offer || "").trim();
  const location = String(brief?.location || "").trim();
  const banned = bannedHits(text);
  const categories = {
    writing: 0,
    relevance: 0,
    imageQuality: 0,
    imageCaptionConsistency: 0,
    branding: 0,
    professionalism: 0,
    cta: 0,
    platformSuitability: 0,
    spellingGrammar: 0,
    engagementLikelihood: 0,
  };
  const reasons = [];

  if (banned.length) {
    reasons.push(`Banned filler language: ${banned.join(", ")}`);
    const failed = {
      total: 41,
      passed: false,
      categories: Object.fromEntries(Object.keys(categories).map((k) => [k, 4])),
      reasons,
      banned,
    };
    failed.categories.writing = 3;
    failed.categories.branding = 2;
    return failed;
  }

  const first = (text.split(/[.!?\n]/)[0] || "").trim();
  if (first.length >= 12 && first.length <= 110 && !/^(we are|we're|our |introducing|announcing)/i.test(first)) {
    categories.writing += 6;
  } else {
    reasons.push("Opening hook is weak or generic.");
    categories.writing += 2;
  }
  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 8);
  if (sentences.length >= 3 && sentences.length <= 8) categories.writing += 4;
  else {
    reasons.push("Copy should be 3–8 natural sentences, not a slogan dump.");
    categories.writing += 1;
  }
  if (text.length >= 140 && text.length <= 1800) categories.writing += 2;
  else categories.writing += 1;

  const sellBits = keywords(sells).slice(0, 8);
  const offerBits = keywords(offer).slice(0, 6);
  if (name && new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) categories.relevance += 5;
  else {
    reasons.push("Caption does not name the actual business.");
    categories.relevance += 1;
  }
  if (sellBits.filter((w) => new RegExp(`\\b${w}\\b`, "i").test(text)).length >= 2) categories.relevance += 4;
  else {
    reasons.push("Caption is not specific about what the business sells.");
    categories.relevance += 1;
  }
  if (includesAny(text, offerBits) || includesAny(text, keywords(audience))) categories.relevance += 3;
  else {
    reasons.push("Missing audience or offer detail from the business brief.");
    categories.relevance += 1;
  }

  const customImage =
    /\/api\/social-image\?/i.test(imageUrl || "") ||
    /\/cdn\/social\//i.test(imageUrl || "") ||
    /amberone\/social\//i.test(imageUrl || "");
  if (customImage) categories.imageQuality = 10;
  else if (/amberone-professional-post/i.test(imageUrl || "") || !imageUrl) {
    categories.imageQuality = 2;
    reasons.push("Image is a generic placeholder, not generated for this business.");
  } else categories.imageQuality = 6;

  const capKeys = new Set(keywords(text).slice(0, 24));
  const promptKeys = keywords(imagePrompt || `${name} ${sells}`);
  const overlap = promptKeys.filter((w) => capKeys.has(w) || sellBits.includes(w) || String(name).toLowerCase().split(/\s+/).includes(w));
  if (overlap.length >= 4 && customImage) categories.imageCaptionConsistency = 12;
  else if (overlap.length >= 2 && customImage) categories.imageCaptionConsistency = 9;
  else if (customImage) {
    categories.imageCaptionConsistency = 6;
    reasons.push("Image prompt only loosely matches the caption.");
  } else {
    categories.imageCaptionConsistency = 2;
    reasons.push("No matching generated image for this caption.");
  }

  if (name && new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(text)) categories.branding += 6;
  else categories.branding += 1;
  if (!/\bamber\s*one\b/i.test(text) || /^amber\s*one$/i.test(name)) categories.branding += 4;
  else {
    reasons.push("Customer-facing copy should brand the client business, not Amber One.");
    categories.branding += 1;
  }

  if (!/[A-Z]{5,}/.test(text.replace(/#/g, ""))) categories.professionalism += 5;
  else {
    reasons.push("Too much shouting/all-caps.");
    categories.professionalism += 2;
  }
  const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
  const calmTone = /calm|precise|reassuring|professional/i.test(String(brief?.tone || ""));
  const gimmick = /!!!|\u{1F525}|\u{1F389}/u.test(text) || (text.match(/!/g) || []).length > 2 || (calmTone && emojiCount > 0);
  if (!gimmick) categories.professionalism += 5;
  else {
    reasons.push(calmTone && emojiCount ? "Tone asked for calm/precise copy; emoji makes it feel salesy." : "Tone is gimmicky rather than professional.");
    categories.professionalism += 2;
  }

  if (CTA.test(text)) categories.cta = 8;
  else {
    reasons.push("No clear call to action.");
    categories.cta = 2;
  }

  const tags = text.match(/#[A-Za-z0-9_]+/g) || [];
  const tagMin = spec.hashtagMin ?? 0;
  const tagMax = spec.hashtagMax ?? 12;
  if (tags.length > tagMax) {
    reasons.push(`${spec.label} reads as spam with ${tags.length} hashtags. Keep ${tagMax} or fewer.`);
    categories.platformSuitability = 2;
  } else {
    if (tags.length >= tagMin) categories.platformSuitability += 4;
    else {
      reasons.push(`${spec.label} needs ${tagMin}–${tagMax} useful hashtags, not none and not a dump.`);
      categories.platformSuitability += 1;
    }
    if (spec.requireLocation) {
      const locBits = keywords(location).concat(location.split(/[\s,]+/).filter((w) => w.length >= 4));
      if (location && includesAny(text, locBits)) categories.platformSuitability += 1;
      else {
        reasons.push(`${spec.label} posts should name the neighborhood or city.`);
      }
    } else {
      categories.platformSuitability += 1;
    }
    const maxLen = spec.maxCaption || 2200;
    const minLen = spec.minCaption || 80;
    if (text.length >= minLen && text.length <= maxLen) categories.platformSuitability += 3;
    else categories.platformSuitability += 1;
  }
  if (/link in bio/i.test(text) && spec.id === "nextdoor") {
    reasons.push("Nextdoor neighbors cannot tap a link in bio.");
    categories.platformSuitability = Math.max(0, categories.platformSuitability - 3);
  }

  let grammar = 8;
  if (/ {2,}/.test(text) || / ,/.test(text)) {
    grammar -= 2;
    reasons.push("Spacing/punctuation issues.");
  }
  if (/\byour the\b|\bits a great\b|\bdefinately\b|\bseperate\b/i.test(text)) {
    grammar -= 4;
    reasons.push("Spelling/grammar error.");
  }
  if (!/[.!?)]\s*$/.test(text.split("\n")[0]) && sentences.length === 1) grammar -= 1;
  categories.spellingGrammar = Math.max(0, grammar);

  let eng = 0;
  if (/\d/.test(text)) eng += 3;
  if (offerBits.some((w) => new RegExp(`\\b${w}\\b`, "i").test(text))) eng += 3;
  if (first.length <= 90) eng += 2;
  if (tagMin > 0 && tags.length >= tagMin) eng += 2;
  else if (tagMin === 0 && spec.requireLocation && includesAny(text, keywords(location))) eng += 2;
  if (eng < 6) reasons.push("Not specific enough to earn a save or comment.");
  categories.engagementLikelihood = Math.min(10, eng);

  const total = Object.values(categories).reduce((a, b) => a + b, 0);
  return {
    total,
    passed: total >= QUALITY_PASS,
    categories,
    reasons,
    banned: [],
    platform: spec.id,
  };
}
