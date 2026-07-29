import { json, nowIso, uid, getUserFromRequest, ensureSchema } from "../_lib/core.js";

export async function onRequest(context) {
  const { request, env } = context;
  await ensureSchema(env.DB);

  const user = await getUserFromRequest(env.DB, request);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const db = env.DB;
  const method = request.method;
  const url = new URL(request.url);

  if (method === "GET") {
    const eventId = url.searchParams.get("event_id");
    if (eventId) {
      const row = await db.prepare("SELECT * FROM meeting_prep WHERE calendar_event_id = ? AND user_id = ?").bind(eventId, user.id).first();
      return json(row || null);
    }
    const rows = await db.prepare("SELECT * FROM meeting_prep WHERE user_id = ? ORDER BY created_at DESC LIMIT 20").bind(user.id).all();
    return json(rows.results || []);
  }

  if (method === "POST") {
    const body = await request.json();
    const eventId = body.event_id;

    // Gather context: event details, CRM contacts, recent memories
    const event = await db.prepare("SELECT * FROM calendar_events WHERE id = ? AND user_id = ?").bind(eventId, user.id).first();
    if (!event) return json({ error: "Event not found" }, 404);

    const contacts = await db.prepare("SELECT * FROM crm_contacts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10").bind(user.id).all();
    const memories = await db.prepare("SELECT * FROM memories WHERE user_id = ? ORDER BY importance DESC, updated_at DESC LIMIT 10").bind(user.id).all();

    const contextData = {
      event,
      contacts: (contacts.results || []).slice(0, 5),
      memories: (memories.results || []).slice(0, 5),
    };

    let summary = `Meeting: ${event.title}\nTime: ${event.starts_at}`;
    if (event.location) summary += `\nLocation: ${event.location}`;
    if (event.description) summary += `\nNotes: ${event.description}`;

    // Use OpenAI to polish if available
    if (env.OPENAI_API_KEY) {
      try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "Generate a brief meeting prep summary. Include key talking points, relevant contacts, and context from the user's memories. Keep it concise." },
              { role: "user", content: JSON.stringify(contextData) },
            ],
            max_tokens: 300,
          }),
        });
        const data = await res.json();
        if (data.choices?.[0]?.message?.content) summary = data.choices[0].message.content;
      } catch (_) {}
    }

    const id = uid("prep");
    await db
      .prepare("INSERT INTO meeting_prep (id, user_id, calendar_event_id, context_json, summary, created_at) VALUES (?,?,?,?,?,?)")
      .bind(id, user.id, eventId, JSON.stringify(contextData), summary, nowIso())
      .run();
    return json({ id, summary }, 201);
  }

  return json({ error: "Method not allowed" }, 405);
}
