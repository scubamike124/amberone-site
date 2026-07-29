const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "assets", "video");
const tmp = path.join(root, ".tmp");
fs.mkdirSync(outDir, { recursive: true });
fs.mkdirSync(tmp, { recursive: true });

const out = path.join(outDir, "amberone-hero.mp4");
const wav = path.join(tmp, "amberone-hero-voice.wav");
const font = "C\\\\:/Windows/Fonts/georgia.ttf";

// Spoken script — AmberOne only (no Relo / Reload).
const speakPs = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = -1
$s.SetOutputToWaveFile(${JSON.stringify(wav)})
$s.Speak("Welcome to Amber One. This is the Amber One website. Amber One is your A I operating system for personal life, family, work, and business. Talk to Amber to schedule your day, save memories, take notes, and get a daily briefing. Use Amber One Personal, Amber One Family, Amber One Executive, or Amber One Business. Amber stays with you until the job is finished.")
$s.Dispose()
`;
const voice = spawnSync("powershell", ["-NoProfile", "-Command", speakPs], { encoding: "utf8" });
if (voice.status !== 0 || !fs.existsSync(wav)) {
  console.error(voice.stderr || voice.stdout || "TTS failed");
  process.exit(voice.status || 1);
}

// On-screen captions — every beat names AmberOne. Avoid the word "Remind" (misread as Reload).
const vf = [
  "drawbox=x=24:y=24:w=672:h=912:color=0xfaf8f4@0.97:t=fill",
  "drawbox=x=24:y=24:w=672:h=8:color=0xc48912:t=fill",
  `drawtext=fontfile=${font}:text='AmberOne':fontcolor=0x2c2a26:fontsize=68:x=(w-text_w)/2:y=100`,
  `drawtext=fontfile=${font}:text='amberone.pages.dev':fontcolor=0x8a847a:fontsize=20:x=(w-text_w)/2:y=180`,

  `drawtext=fontfile=${font}:text='Welcome to AmberOne':fontcolor=0xc48912:fontsize=34:x=(w-text_w)/2:y=320:enable='between(t\\,0\\,5)'`,
  `drawtext=fontfile=${font}:text='Your AI operating system for':fontcolor=0x2c2a26:fontsize=24:x=(w-text_w)/2:y=390:enable='between(t\\,0\\,5)'`,
  `drawtext=fontfile=${font}:text='personal life\\, family\\, work \\& business':fontcolor=0x2c2a26:fontsize=22:x=(w-text_w)/2:y=435:enable='between(t\\,0\\,5)'`,

  `drawtext=fontfile=${font}:text='Talk to Amber on AmberOne':fontcolor=0xc48912:fontsize=30:x=(w-text_w)/2:y=300:enable='between(t\\,5\\,10)'`,
  `drawtext=fontfile=${font}:text='Calendar · Memories · Notes':fontcolor=0x2c2a26:fontsize=24:x=(w-text_w)/2:y=370:enable='between(t\\,5\\,10)'`,
  `drawtext=fontfile=${font}:text='Daily briefing · Evening recap':fontcolor=0x2c2a26:fontsize=24:x=(w-text_w)/2:y=415:enable='between(t\\,5\\,10)'`,

  `drawtext=fontfile=${font}:text='AmberOne plan options':fontcolor=0xc48912:fontsize=32:x=(w-text_w)/2:y=290:enable='between(t\\,10\\,15)'`,
  `drawtext=fontfile=${font}:text='Personal · Family':fontcolor=0x2c2a26:fontsize=26:x=(w-text_w)/2:y=360:enable='between(t\\,10\\,15)'`,
  `drawtext=fontfile=${font}:text='Executive · Business':fontcolor=0x2c2a26:fontsize=26:x=(w-text_w)/2:y=410:enable='between(t\\,10\\,15)'`,

  `drawtext=fontfile=${font}:text='AmberOne stays until finished':fontcolor=0xc48912:fontsize=28:x=(w-text_w)/2:y=300:enable='gte(t\\,15)'`,
  `drawtext=fontfile=${font}:text='Guide · Verify · Recover · Learn':fontcolor=0x2c2a26:fontsize=22:x=(w-text_w)/2:y=370:enable='gte(t\\,15)'`,
  `drawtext=fontfile=${font}:text='One Assistant. One Place. One Life.':fontcolor=0x5e5950:fontsize=20:x=(w-text_w)/2:y=430:enable='gte(t\\,15)'`,

  `drawtext=fontfile=${font}:text='What AmberOne does':fontcolor=0x8a847a:fontsize=20:x=(w-text_w)/2:y=820`,
].join(",");

const args = [
  "-y",
  "-f", "lavfi",
  "-i", "color=c=0xe8e3da:s=720x960:d=20",
  "-i", wav,
  "-vf", vf,
  "-c:v", "libx264",
  "-pix_fmt", "yuv420p",
  "-c:a", "aac",
  "-b:a", "128k",
  "-shortest",
  "-movflags", "+faststart",
  out,
];

const res = spawnSync("ffmpeg", args, { encoding: "utf8" });
if (res.status !== 0) {
  console.error(res.stderr || res.stdout);
  process.exit(res.status || 1);
}
console.log(JSON.stringify({ ok: true, out, bytes: fs.statSync(out).size }));
