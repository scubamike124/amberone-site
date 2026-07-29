import { json, readJson } from "../_lib/core.js";

const FAQ = [
  {
    q: /family|chore|school|kids/i,
    a: "Amber Family keeps shared calendars, chores, school and sports schedules together. Plans start at $29.99/mo for 2 users. Open Pricing when you’re ready to Start Now.",
  },
  {
    q: /business|appointment|customer|marketing/i,
    a: "Amber Business handles appointments, customer reminders, CRM, and marketing assistance. Self-service plans start at $99/mo — no custom quotes.",
  },
  {
    q: /executive|email|meeting/i,
    a: "Amber Executive helps with calendar, email assistance, meeting prep, and follow-ups for $59.99/mo.",
  },
  {
    q: /price|pricing|cost|plan|subscribe/i,
    a: "Compare Personal, Family, Executive, and Business on Pricing. Start Now opens secure Stripe Checkout. Upgrade, downgrade, or cancel anytime in the Customer Portal.",
  },
  {
    q: /cancel|refund|portal/i,
    a: "Manage upgrade, downgrade, or cancel in your AmberOne dashboard → Billing → Customer Portal. Access continues through the paid period.",
  },
];

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  const message = String(body.message || "").trim();
  if (!message) return json({ error: "Message required" }, 400);

  const key = context.env.OPENAI_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            {
              role: "system",
              content:
                "You are Amber for AmberOne. Mission: One Assistant. One Place. One Life. Be warm, clear, and concise. Never invent Enterprise custom quotes. Guide users to Pricing / Start Now for self-service subscribe. Do not claim features are live if unsure — focus on Personal, Family, Executive, Business plans.",
            },
            { role: "user", content: message },
          ],
        }),
      });
      const data = await res.json();
      const reply = data?.choices?.[0]?.message?.content;
      if (res.ok && reply) return json({ reply, source: "openai" });
    } catch {
      // fall through to FAQ
    }
  }

  const hit = FAQ.find((f) => f.q.test(message));
  return json({
    reply:
      hit?.a ||
      "I’m Amber. I can help you pick Personal, Family, Executive, or Business — then Start Now on Pricing for secure Stripe checkout. What are you trying to manage first?",
    source: key ? "fallback" : "guided",
  });
}
