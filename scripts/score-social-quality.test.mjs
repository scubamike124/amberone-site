import { scoreSocialPost } from "../functions/_lib/social-quality.js";
import { listPlatformIds, SOCIAL_PLATFORMS } from "../functions/_lib/social-platforms.js";

const brief = {
  name: "Harborline Orthodontics",
  sells: "discreet adult clear-aligner treatment and evening adjustment visits in Ballard",
  audience: "working professionals 28-45 who delayed braces",
  offer: "complimentary 20-minute evening scan Thursday 5–7pm, plans from $129 a month",
  location: "Ballard, Seattle",
  tone: "calm, precise, reassuring",
};

const filler = {
  caption: "Harborline Orthodontics is open for the week! Come see us. This is an Amber One professional test post and will not be published live. #business #local",
  imageUrl: "/assets/social/amberone-professional-post.png",
  imagePrompt: "generic still",
};
const igGood = {
  caption:
    "Thursday after work used to mean another year of hiding your smile in meetings.\n\nHarborline Orthodontics in Ballard built evening clear-aligner visits for professionals who delayed braces — 20-minute complimentary scans Thursday 5–7pm, then plans from $129 a month.\n\nBook this week’s remaining evening scan and walk out with a start date, not a sales pitch.\n\n#HarborlineOrthodontics #BallardSeattle #ClearAligners #AdultBraces #SeattleDentists",
  imageUrl: "https://amberoneai.com/api/social-image?id=x&t=y",
  imagePrompt:
    "photorealistic Ballard Seattle dental studio evening, adult professional in discreet clear aligners, warm oak reception, no text Harborline Orthodontics clear aligner",
};
const ndGood = {
  caption:
    "Thursday after work used to mean another year of hiding your smile in meetings.\n\nHarborline Orthodontics in Ballard built evening clear-aligner visits for professionals who delayed braces — 20-minute complimentary scans Thursday 5–7pm, then plans from $129 a month.\n\nNeighbors: book this week’s remaining evening scan and walk out with a start date, not a sales pitch.",
  imageUrl: "https://amberoneai.com/api/social-image?id=x&t=y",
  imagePrompt:
    "photorealistic Ballard Seattle dental studio evening, adult professional in discreet clear aligners, warm oak reception, no text Harborline Orthodontics clear aligner",
};

const results = {};
for (const platform of listPlatformIds()) {
  const a = scoreSocialPost({ ...filler, brief, platform });
  results[`${platform}_filler`] = { total: a.total, passed: a.passed };
  if (!(a.total < 95 && a.passed === false)) {
    console.error(platform, "filler was not rejected");
    process.exit(2);
  }
}

const ig = scoreSocialPost({ ...igGood, brief, platform: "instagram" });
const nd = scoreSocialPost({ ...ndGood, brief, platform: "nextdoor" });
const ndDump = scoreSocialPost({ ...igGood, brief, platform: "nextdoor" });
results.instagram_good = { total: ig.total, passed: ig.passed, categories: ig.categories, reasons: ig.reasons };
results.nextdoor_good = { total: nd.total, passed: nd.passed, categories: nd.categories, reasons: nd.reasons };
results.nextdoor_hashtag_dump = { total: ndDump.total, passed: ndDump.passed, reasons: ndDump.reasons };

console.log(JSON.stringify({ platforms: listPlatformIds(), compose: Object.values(SOCIAL_PLATFORMS).every((p) => p.canCompose), results }, null, 2));

if (ig.total < 95) {
  console.error("instagram good example scored below 95");
  process.exit(3);
}
if (nd.total < 95) {
  console.error("nextdoor good example scored below 95", nd);
  process.exit(4);
}
if (ndDump.passed) {
  console.error("nextdoor accepted an Instagram hashtag dump — gate is too loose");
  process.exit(5);
}
