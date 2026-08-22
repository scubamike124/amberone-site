import { uid } from "./core.js";
import { getPlatform } from "./social-platforms.js";
import { QUALITY_PASS, scoreSocialPost } from "./social-quality.js";

function parseJsonSafe(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return {};
  }
}

export function slimAttempts(attempts) {
  return (attempts || []).map((a) => ({
    n: a.n,
    kind: a.kind,
    accepted: a.accepted,
    total: a.score?.total,
    passed: a.score?.passed,
    reasons: a.score?.reasons || [],
    captionPreview: String(a.caption || "").slice(0, 160),
  }));
}

export async function loadBusinessBrief(db, user, extra = {}) {
  const profile = await db.prepare("SELECT * FROM business_profiles WHERE user_id = ?").bind(user.id).first();
  const onboard = await db.prepare("SELECT prefs_json FROM onboarding_state WHERE user_id = ?").bind(user.id).first();
  const prefs = parseJsonSafe(onboard?.prefs_json);
  const memories = await db
    .prepare("SELECT title, content, kind FROM memories WHERE user_id = ? ORDER BY importance DESC, updated_at DESC LIMIT 8")
    .bind(user.id)
    .all();
  const mems = memories.results || [];
  const name = extra.name || profile?.name || prefs.businessName || prefs.company || user.name || "";
  const sells = extra.sells || profile?.sells || prefs.sells || prefs.whatYouDo || mems.map((m) => m.content).join(" ");
  const audience = extra.audience || profile?.audience || prefs.audience || "";
  const offer = extra.offer || profile?.offer || prefs.offer || "";
  const tone = extra.tone || profile?.tone || prefs.tone || "calm, specific, professional";
  const location = extra.location || profile?.location || prefs.location || "";
  const objective = extra.objective || profile?.objective || extra.goal || "a useful post that a real customer would act on";
  const brief = {
    name: String(name || "").trim(),
    sells: String(sells || "").trim(),
    audience: String(audience || "").trim(),
    offer: String(offer || "").trim(),
    tone: String(tone || "").trim(),
    location: String(location || "").trim(),
    objective: String(objective || "").trim(),
  };
  const missing = ["name", "sells", "audience", "offer"].filter((k) => !brief[k] || brief[k].length < 8);
  return { brief, missing, memories: mems.map((m) => ({ title: m.title, content: m.content })) };
}

function naiveFillerDraft(brief) {
  return `${brief.name || "We"} is open for the week! Come see us. This is an Amber One professional test post and will not be published live. #business #local`;
}

async function chatJson(apiKey, messages) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI chat failed (${res.status})`);
  const raw = data?.choices?.[0]?.message?.content || "{}";
  return parseJsonSafe(raw);
}

function extractCaption(obj) {
  return String(obj.caption || obj.post || obj.text || "").trim();
}

export async function generateCaption(apiKey, brief, prior, platform = "instagram") {
  const spec = getPlatform(platform) || getPlatform("instagram");
  const critique = prior?.score
    ? `Previous draft scored ${prior.score.total}/100 and failed. Reasons: ${(prior.score.reasons || []).join("; ")}. Draft was:\n${prior.caption}`
    : "No previous draft.";
  const obj = await chatJson(apiKey, [
    {
      role: "system",
      content:
        `${spec.writer} Never generic filler. Never mention Amber One. Never say this is a test. Return JSON keys: caption, imagePrompt, hook. Match the brief's tone exactly. If the tone is calm, precise, professional, or reassuring, write with no emoji. imagePrompt: photorealistic photograph matching the business and caption, no text, no watermark, no logo, ${spec.imageShape}.`,
    },
    {
      role: "user",
      content: JSON.stringify({ platform: spec.id, brief, critique }),
    },
  ]);
  return {
    caption: extractCaption(obj),
    imagePrompt: String(obj.imagePrompt || obj.image_prompt || "").trim(),
    hook: String(obj.hook || "").trim(),
  };
}

function estimateWithImage(score) {
  return (
    score.total -
    score.categories.imageQuality -
    score.categories.imageCaptionConsistency +
    22
  );
}

function decodeB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function requestImage(apiKey, prompt, model, shape = "square photo") {
  return fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: `${prompt}. Photorealistic, natural light, no text overlay, no watermark, no logo, ${shape}.`,
      size: "1024x1024",
      quality: "medium",
    }),
  });
}

export async function generateImagePng(apiKey, prompt, shape = "square photo") {
  let res = await requestImage(apiKey, prompt, "gpt-image-1-mini", shape);
  let data = await res.json().catch(() => ({}));
  if (!res.ok && /model/i.test(data?.error?.message || "")) {
    res = await requestImage(apiKey, prompt, "gpt-image-1", shape);
    data = await res.json().catch(() => ({}));
  }
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Image generation failed (${res.status})`), { status: 502 });
  const b64 = data?.data?.[0]?.b64_json;
  if (b64) return decodeB64(b64);
  const url = data?.data?.[0]?.url;
  if (!url) throw new Error("Image model returned no image data.");
  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error(`Could not download the generated image (${imgRes.status}).`);
  return new Uint8Array(await imgRes.arrayBuffer());
}

function failGate(message, extra) {
  throw Object.assign(new Error(message), { status: 422, code: "quality_gate", ...extra });
}

export async function composeCaptionDraft({ env, db, user, extraBrief = {}, platform = "instagram" }) {
  if (!env.OPENAI_API_KEY) {
    throw Object.assign(new Error("Amber cannot write a scored post until OpenAI is configured."), { status: 503 });
  }
  const spec = getPlatform(platform) || getPlatform("instagram");
  const { brief, missing } = await loadBusinessBrief(db, user, extraBrief);
  if (missing.length) {
    throw Object.assign(
      new Error(
        `Amber needs a real business brief before posting (${missing.join(", ")}). Save the business profile first — name, what you sell, who it is for, and the offer.`,
      ),
      { status: 400, code: "incomplete_brief", missing, brief },
    );
  }

  const attempts = [];
  const filler = naiveFillerDraft(brief);
  const fillerScore = scoreSocialPost({
    caption: filler,
    brief,
    imageUrl: "/assets/social/amberone-professional-post.png",
    imagePrompt: "generic lifestyle still",
    platform: spec.id,
  });
  attempts.push({
    n: 0,
    kind: "rejected_generic_template",
    caption: filler,
    score: fillerScore,
    accepted: false,
  });

  let best = null;
  for (let n = 1; n <= 2; n += 1) {
    const prior = best && estimateWithImage(best.score) < QUALITY_PASS ? { caption: best.caption, score: best.score } : null;
    const gen = await generateCaption(env.OPENAI_API_KEY, brief, prior, spec.id);
    const trialScore = scoreSocialPost({
      caption: gen.caption,
      brief,
      imageUrl: null,
      imagePrompt: gen.imagePrompt,
      platform: spec.id,
    });
    const estimated = estimateWithImage(trialScore);
    attempts.push({
      n,
      kind: estimated >= QUALITY_PASS ? "caption_candidate" : "caption_rejected",
      caption: gen.caption,
      imagePrompt: gen.imagePrompt,
      hook: gen.hook,
      score: trialScore,
      estimatedWithImage: estimated,
      accepted: false,
    });
    if (!best || estimated > (best.estimatedWithImage || 0)) {
      best = { ...gen, score: trialScore, estimatedWithImage: estimated };
    }
    if (estimated >= QUALITY_PASS) break;
  }
  if (!best?.caption) {
    throw Object.assign(new Error("Amber could not draft a usable caption."), { status: 502 });
  }
  if ((best.estimatedWithImage || 0) < QUALITY_PASS) {
    failGate(
      `Quality gate failed at estimated ${best.estimatedWithImage}/100 after regeneration. Amber will not keep a caption that cannot reach ${QUALITY_PASS} with a matching image.`,
      { score: best.score, attempts, brief },
    );
  }

  return {
    brief,
    caption: best.caption,
    imagePrompt: best.imagePrompt,
    hook: best.hook,
    captionScore: best.score,
    estimatedWithImage: best.estimatedWithImage,
    attempts,
    qualityPass: QUALITY_PASS,
    platform: spec.id,
  };
}

export async function attachGeneratedImage({ env, db, user, requestOrigin, post }) {
  if (!env.OPENAI_API_KEY) {
    throw Object.assign(new Error("Amber cannot generate a matching image until OpenAI is configured."), { status: 503 });
  }
  const r2 = env.MEDIA_BUCKET || env.R2;
  if (!r2) {
    throw Object.assign(new Error("File storage is not bound, so Amber cannot store a matching image."), { status: 503, code: "r2_unbound" });
  }
  const spec = getPlatform(post.platform) || getPlatform("instagram");
  const brief = parseJsonSafe(post.brief_json);
  const attempts = Array.isArray(parseJsonSafe(post.attempts_json)) ? parseJsonSafe(post.attempts_json) : [];
  const imagePrompt = String(post.image_prompt || `${brief.name} ${brief.sells} ${brief.location}`).trim();
  const bytes = await generateImagePng(env.OPENAI_API_KEY, imagePrompt, spec.imageShape);
  const token = post.image_token || uid("img").replace(/^img_/, "");
  const key = `amberone/social/${user.id}/${post.id}.png`;
  await r2.put(key, bytes, { httpMetadata: { contentType: "image/png" } });
  const imageUrl = `${requestOrigin}/cdn/social/${encodeURIComponent(post.id)}--${encodeURIComponent(token)}.png`;

  let caption = post.caption;
  let prompt = imagePrompt;
  let finalScore = scoreSocialPost({
    caption,
    brief,
    imageUrl,
    imagePrompt: prompt,
    platform: spec.id,
  });
  attempts.push({
    n: attempts.length,
    kind: "with_generated_image",
    caption,
    imagePrompt: prompt,
    score: finalScore,
    accepted: finalScore.passed,
  });

  if (!finalScore.passed) {
    const retry = await generateCaption(env.OPENAI_API_KEY, brief, { caption, score: finalScore }, spec.id);
    const retryScore = scoreSocialPost({
      caption: retry.caption,
      brief,
      imageUrl,
      imagePrompt: retry.imagePrompt || prompt,
      platform: spec.id,
    });
    attempts.push({
      n: attempts.length,
      kind: retryScore.passed ? "caption_retry_after_image" : "caption_retry_rejected",
      caption: retry.caption,
      imagePrompt: retry.imagePrompt,
      score: retryScore,
      accepted: retryScore.passed,
    });
    if (retryScore.total > finalScore.total) {
      caption = retry.caption;
      prompt = retry.imagePrompt || prompt;
      finalScore = retryScore;
    }
  }

  if (!finalScore.passed) {
    failGate(
      `Quality gate failed at ${finalScore.total}/100 after regeneration. Amber will not save a post below ${QUALITY_PASS}.`,
      { score: finalScore, attempts, brief, imageUrl },
    );
  }

  attempts[attempts.length - 1].accepted = true;
  return {
    token,
    key,
    brief,
    caption,
    imagePrompt: prompt,
    imageUrl,
    score: finalScore,
    attempts,
    qualityPass: QUALITY_PASS,
  };
}
