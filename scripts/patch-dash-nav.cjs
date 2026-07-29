const fs = require("fs");

const files = [
  "dashboard/index.html",
  "dashboard/calendar.html",
  "dashboard/reminders.html",
  "dashboard/memories.html",
  "dashboard/notes.html",
  "dashboard/connections.html",
  "dashboard/billing.html",
  "dashboard/settings.html",
  "dashboard/notifications.html",
  "dashboard/onboarding.html",
];

for (const f of files) {
  let html = fs.readFileSync(f, "utf8");
  html = html.replace(/<aside class="panel dash-nav"[^>]*>[\s\S]*?<\/aside>/i, '<aside data-dash-nav></aside>');
  if (!html.includes("dash-chrome.js")) {
    html = html.replace(
      '<script src="/assets/app.js"></script>',
      '<script src="/assets/app.js"></script>\n  <script src="/assets/dash-chrome.js"></script>',
    );
  }
  fs.writeFileSync(f, html);
  console.log(f, {
    nav: html.includes("data-dash-nav"),
    chrome: html.includes("dash-chrome.js"),
  });
}
