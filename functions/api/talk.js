import { ensureSchema, getUserFromRequest, json, nowIso, readJson, uid, writeAudit } from "../_lib/core.js";
import { buildBriefing } from "../_lib/briefing.js";
import { createEmailDraft, fetchEmails, resolveActiveGmailAccount } from "../_lib/gmail.js";

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

const MARKETING_SYSTEM_PROMPT =
  "You are Amber for AmberOne. Mission: One Assistant. One Place. One Life. Be warm, clear, and concise. Never invent Enterprise custom quotes. Guide users to Pricing / Start Now for self-service subscribe. Do not claim features are live if unsure — focus on Personal, Family, Executive, Business plans.";

const TOOLS = [
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a durable fact, preference, or note about the user for future conversations (e.g. a birthday, an address, a preference).",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Category, e.g. person, preference, date, place, note.", default: "note" },
          title: { type: "string", description: "Short label for the memory." },
          content: { type: "string", description: "The full detail to remember." },
          importance: { type: "integer", description: "1 (minor) to 5 (critical).", minimum: 1, maximum: 5 },
        },
        required: ["title", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_memories",
      description: "Look up things AmberOne already remembers about the user.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", description: "Optional category filter." },
          limit: { type: "integer", description: "Max results, default 10.", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_calendar_event",
      description: "Create a calendar event for the user.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          location: { type: "string" },
          starts_at: { type: "string", description: "ISO 8601 start date-time." },
          ends_at: { type: "string", description: "ISO 8601 end date-time." },
          all_day: { type: "boolean" },
        },
        required: ["title", "starts_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_calendar_events",
      description: "List the user's upcoming (or a specific range of) calendar events.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "ISO 8601 range start. Defaults to now." },
          to: { type: "string", description: "ISO 8601 range end. Defaults to 14 days from now." },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_reminder",
      description: "Create a reminder that will notify the user when due.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          due_at: { type: "string", description: "ISO 8601 date-time when the reminder is due." },
          channel: { type: "string", description: "app or email.", enum: ["app", "email"] },
        },
        required: ["title", "due_at"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_reminders",
      description: "List the user's reminders, optionally filtered by status.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "sent", "completed", "cancelled"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_account_status",
      description: "Get the current user's plan, subscription status, and account email.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Save a free-form note for the user (ideas, jotting, reference text).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string", description: "Note content." },
        },
        required: ["body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_notes",
      description: "List the user's recent notes.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_list",
      description: "Create a shopping list, todo list, or custom checklist. Optionally include starting items.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          kind: { type: "string", enum: ["shopping", "todo", "custom"] },
          items: {
            type: "array",
            items: { type: "string" },
            description: "Optional starting checklist items.",
          },
        },
        required: ["title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_list_item",
      description: "Add an item to an existing list. Prefer list_id when known; otherwise match by list title.",
      parameters: {
        type: "object",
        properties: {
          list_id: { type: "string" },
          list_title: { type: "string", description: "Title of the list if id is unknown." },
          text: { type: "string" },
        },
        required: ["text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_lists",
      description: "List the user's shopping/todo lists, optionally including items for one list.",
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["shopping", "todo", "custom"] },
          list_id: { type: "string", description: "If set, return that list with items." },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "complete_list_item",
      description: "Mark a list item checked/unchecked.",
      parameters: {
        type: "object",
        properties: {
          item_id: { type: "string" },
          checked: { type: "boolean", description: "Defaults to true (complete)." },
        },
        required: ["item_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_briefing",
      description: "Get the user's daily morning briefing or evening recap (schedule, reminders, lists, weather when available).",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["auto", "morning", "evening"], description: "Defaults to auto based on time of day." },
          timeZone: { type: "string", description: "IANA timezone, e.g. America/Los_Angeles." },
          city: { type: "string", description: "Optional city for weather." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_emails",
      description: "List recent emails from the user's connected Gmail inbox (requires Gmail Connected Services).",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Gmail search query, e.g. is:unread newer_than:7d. Defaults to in:inbox.",
          },
          limit: { type: "integer", minimum: 1, maximum: 25 },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_email_draft",
      description: "Create a Gmail draft (does NOT send). Use when the user asks to draft an email.",
      parameters: {
        type: "object",
        properties: {
          recipient_email: { type: "string" },
          subject: { type: "string" },
          body: { type: "string" },
        },
        required: ["recipient_email", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_automations",
      description: "List user's automations. Currently returns empty — automation engine coming soon.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_contact",
      description: "Create a CRM contact.",
      parameters: { type: "object", properties: { name: { type: "string" }, email: { type: "string" }, phone: { type: "string" }, company: { type: "string" } }, required: ["name"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_contacts",
      description: "List user's CRM contacts.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "log_interaction",
      description: "Log a CRM interaction (call, email, meeting, note) for a contact.",
      parameters: { type: "object", properties: { contact_id: { type: "string" }, kind: { type: "string" }, summary: { type: "string" } }, required: ["contact_id", "summary"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_meeting_prep",
      description: "Generate meeting prep for a calendar event.",
      parameters: { type: "object", properties: { event_id: { type: "string" } }, required: ["event_id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "create_chore",
      description: "Create a chore for the user's family team.",
      parameters: { type: "object", properties: { title: { type: "string" }, assigned_user_id: { type: "string" }, due_at: { type: "string" } }, required: ["title"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_chores",
      description: "List pending chores for the user's team.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "create_appointment",
      description: "Create a business appointment.",
      parameters: { type: "object", properties: { title: { type: "string" }, starts_at: { type: "string" }, ends_at: { type: "string" }, contact_id: { type: "string" }, notes: { type: "string" } }, required: ["title", "starts_at"] },
    },
  },
  {
    type: "function",
    function: {
      name: "list_appointments",
      description: "List upcoming appointments.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_marketing_copy",
      description: "Generate marketing copy (social post, promo, announcement).",
      parameters: { type: "object", properties: { type: { type: "string" }, topic: { type: "string" } }, required: ["topic"] },
    },
  },
  {
    type: "function",
    function: {
      name: "plan_travel",
      description: "Save a conversational travel plan as a note and optionally add trip dates to the calendar.",
      parameters: {
        type: "object",
        properties: {
          destination: { type: "string" },
          starts_at: { type: "string", description: "Trip start ISO date-time or date." },
          ends_at: { type: "string", description: "Trip end ISO date-time or date." },
          notes: { type: "string", description: "Itinerary ideas, lodging, transport, packing." },
          add_calendar: { type: "boolean", description: "If true and dates provided, create a calendar event." },
        },
        required: ["destination"],
      },
    },
  },
];

async function runTool(name, args, { db, user, env }) {
  const ts = nowIso();
  switch (name) {
    case "save_memory": {
      const title = String(args.title || args.content || "Memory").slice(0, 200);
      const content = String(args.content || "");
      const kind = String(args.kind || "note").slice(0, 40);
      const importance = Math.min(5, Math.max(1, Number(args.importance) || 3));
      const id = uid("mem");
      await db
        .prepare(
          "INSERT INTO memories (id, user_id, kind, title, content, importance, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(id, user.id, kind, title, content, importance, "assistant", ts, ts)
        .run();
      await writeAudit(db, { userId: user.id, action: "memory.create", resourceType: "memory", resourceId: id, meta: { via: "talk" } });
      return { data: { id, title, content, kind, importance }, summary: `Saved memory "${title}".` };
    }
    case "list_memories": {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      let query = "SELECT id, kind, title, content, importance, created_at FROM memories WHERE user_id = ?";
      const binds = [user.id];
      if (args.kind) {
        query += " AND kind = ?";
        binds.push(String(args.kind));
      }
      query += " ORDER BY importance DESC, created_at DESC LIMIT ?";
      binds.push(limit);
      const rows = await db.prepare(query).bind(...binds).all();
      const results = rows.results || [];
      return { data: results, summary: `Found ${results.length} memories.` };
    }
    case "create_calendar_event": {
      if (!args.title || !args.starts_at) {
        return { data: { error: "title and starts_at are required" }, summary: "Missing required fields for the event." };
      }
      const id = uid("evt");
      await db
        .prepare(
          `INSERT INTO calendar_events (id, user_id, title, description, location, starts_at, ends_at, all_day, recurrence, external_id, external_source, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          user.id,
          String(args.title).slice(0, 200),
          args.description || null,
          args.location || null,
          String(args.starts_at),
          args.ends_at || null,
          args.all_day ? 1 : 0,
          null,
          null,
          null,
          ts,
          ts,
        )
        .run();
      await writeAudit(db, { userId: user.id, action: "calendar_event.create", resourceType: "calendar_event", resourceId: id, meta: { via: "talk" } });
      return { data: { id, title: args.title, starts_at: args.starts_at }, summary: `Created "${args.title}" on the calendar.` };
    }
    case "list_calendar_events": {
      const from = args.from || ts;
      const to = args.to || new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString();
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const rows = await db
        .prepare(
          "SELECT id, title, starts_at, ends_at, all_day, location FROM calendar_events WHERE user_id = ? AND starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC LIMIT ?",
        )
        .bind(user.id, from, to, limit)
        .all();
      const results = rows.results || [];
      return { data: results, summary: `Found ${results.length} events between ${from} and ${to}.` };
    }
    case "create_reminder": {
      if (!args.title || !args.due_at) {
        return { data: { error: "title and due_at are required" }, summary: "Missing required fields for the reminder." };
      }
      const id = uid("rem");
      const channel = args.channel === "email" ? "email" : "app";
      await db
        .prepare(
          `INSERT INTO reminders (id, user_id, title, body, due_at, status, channel, notify_email, calendar_event_id, sent_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL, ?, ?)`,
        )
        .bind(id, user.id, String(args.title).slice(0, 200), args.body || null, String(args.due_at), channel, channel === "email" ? user.email : null, ts, ts)
        .run();
      await writeAudit(db, { userId: user.id, action: "reminder.create", resourceType: "reminder", resourceId: id, meta: { via: "talk" } });
      return { data: { id, title: args.title, due_at: args.due_at }, summary: `Set a reminder for "${args.title}" at ${args.due_at}.` };
    }
    case "list_reminders": {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      let query = "SELECT id, title, due_at, status FROM reminders WHERE user_id = ?";
      const binds = [user.id];
      if (args.status) {
        query += " AND status = ?";
        binds.push(String(args.status));
      }
      query += " ORDER BY due_at ASC LIMIT ?";
      binds.push(limit);
      const rows = await db.prepare(query).bind(...binds).all();
      const results = rows.results || [];
      return { data: results, summary: `Found ${results.length} reminders.` };
    }
    case "get_account_status": {
      return {
        data: { planSlug: user.plan_slug || null, subscriptionStatus: user.subscription_status || "none", email: user.email },
        summary: `Plan: ${user.plan_slug || "none"} (${user.subscription_status || "none"}).`,
      };
    }
    case "create_note": {
      const body = String(args.body || "").trim();
      if (!body) return { data: { error: "body is required" }, summary: "Missing note content." };
      const title = String(args.title || body.slice(0, 80)).trim().slice(0, 200);
      const id = uid("note");
      await db
        .prepare("INSERT INTO notes (id, user_id, title, body, pinned, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
        .bind(id, user.id, title, body, ts, ts)
        .run();
      await writeAudit(db, { userId: user.id, action: "note.create", resourceType: "note", resourceId: id, meta: { via: "talk" } });
      return { data: { id, title, body }, summary: `Saved note "${title}".` };
    }
    case "list_notes": {
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 10));
      const rows = await db
        .prepare("SELECT id, title, body, pinned, updated_at FROM notes WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC LIMIT ?")
        .bind(user.id, limit)
        .all();
      const results = rows.results || [];
      return { data: results, summary: `Found ${results.length} notes.` };
    }
    case "create_list": {
      const title = String(args.title || "").trim();
      if (!title) return { data: { error: "title is required" }, summary: "Missing list title." };
      const kind = ["shopping", "todo", "custom"].includes(String(args.kind || "")) ? String(args.kind) : "shopping";
      const id = uid("list");
      await db
        .prepare("INSERT INTO lists (id, user_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, user.id, kind, title.slice(0, 200), ts, ts)
        .run();
      const items = Array.isArray(args.items) ? args.items : [];
      for (let i = 0; i < items.length; i++) {
        const text = String(items[i] || "").trim();
        if (!text) continue;
        await db
          .prepare(
            "INSERT INTO list_items (id, list_id, user_id, text, checked, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
          )
          .bind(uid("li"), id, user.id, text.slice(0, 500), i, ts, ts)
          .run();
      }
      await writeAudit(db, { userId: user.id, action: "list.create", resourceType: "list", resourceId: id, meta: { via: "talk", kind } });
      return { data: { id, title, kind, itemCount: items.filter((x) => String(x || "").trim()).length }, summary: `Created ${kind} list "${title}".` };
    }
    case "add_list_item": {
      const text = String(args.text || "").trim();
      if (!text) return { data: { error: "text is required" }, summary: "Missing item text." };
      let listId = args.list_id ? String(args.list_id) : null;
      if (!listId && args.list_title) {
        const found = await db
          .prepare("SELECT id FROM lists WHERE user_id = ? AND lower(title) = lower(?) ORDER BY updated_at DESC LIMIT 1")
          .bind(user.id, String(args.list_title).trim())
          .first();
        listId = found?.id || null;
      }
      if (!listId) {
        const latest = await db
          .prepare("SELECT id, title FROM lists WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1")
          .bind(user.id)
          .first();
        listId = latest?.id || null;
      }
      if (!listId) return { data: { error: "No list found. Create a list first." }, summary: "No list to add to." };
      const posRow = await db
        .prepare("SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM list_items WHERE list_id = ?")
        .bind(listId)
        .first();
      const itemId = uid("li");
      await db
        .prepare(
          "INSERT INTO list_items (id, list_id, user_id, text, checked, position, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
        )
        .bind(itemId, listId, user.id, text.slice(0, 500), posRow?.next_pos ?? 0, ts, ts)
        .run();
      await db.prepare("UPDATE lists SET updated_at = ? WHERE id = ?").bind(ts, listId).run();
      await writeAudit(db, { userId: user.id, action: "list_item.create", resourceType: "list_item", resourceId: itemId, meta: { via: "talk", listId } });
      return { data: { id: itemId, list_id: listId, text }, summary: `Added "${text}" to the list.` };
    }
    case "list_lists": {
      if (args.list_id) {
        const list = await db
          .prepare("SELECT id, kind, title, updated_at FROM lists WHERE id = ? AND user_id = ?")
          .bind(String(args.list_id), user.id)
          .first();
        if (!list) return { data: { error: "List not found" }, summary: "List not found." };
        const items = await db
          .prepare("SELECT id, text, checked FROM list_items WHERE list_id = ? ORDER BY position ASC, created_at ASC")
          .bind(list.id)
          .all();
        return { data: { ...list, items: items.results || [] }, summary: `List "${list.title}" has ${(items.results || []).length} items.` };
      }
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      let query = "SELECT id, kind, title, updated_at FROM lists WHERE user_id = ?";
      const binds = [user.id];
      if (args.kind) {
        query += " AND kind = ?";
        binds.push(String(args.kind));
      }
      query += " ORDER BY updated_at DESC LIMIT ?";
      binds.push(limit);
      const rows = await db.prepare(query).bind(...binds).all();
      const results = rows.results || [];
      return { data: results, summary: `Found ${results.length} lists.` };
    }
    case "complete_list_item": {
      const itemId = String(args.item_id || "").trim();
      if (!itemId) return { data: { error: "item_id is required" }, summary: "Missing item id." };
      const item = await db.prepare("SELECT id, text FROM list_items WHERE id = ? AND user_id = ?").bind(itemId, user.id).first();
      if (!item) return { data: { error: "Item not found" }, summary: "Item not found." };
      const checked = args.checked === false ? 0 : 1;
      await db.prepare("UPDATE list_items SET checked = ?, updated_at = ? WHERE id = ?").bind(checked, ts, itemId).run();
      await writeAudit(db, { userId: user.id, action: "list_item.update", resourceType: "list_item", resourceId: itemId, meta: { via: "talk", checked } });
      return { data: { id: itemId, checked: Boolean(checked) }, summary: checked ? `Checked off "${item.text}".` : `Unchecked "${item.text}".` };
    }
    case "get_briefing": {
      const briefing = await buildBriefing(db, env || {}, user, {
        mode: args.mode || "auto",
        timeZone: args.timeZone || "America/Los_Angeles",
        city: args.city || null,
      });
      await writeAudit(db, {
        userId: user.id,
        action: "briefing.generate",
        resourceType: "briefing",
        resourceId: null,
        meta: { via: "talk", mode: briefing.mode },
      });
      return {
        data: {
          mode: briefing.mode,
          dayKey: briefing.dayKey,
          summary: briefing.summary,
          eventCount: briefing.context?.events?.length || 0,
          reminderCount: briefing.context?.reminders?.length || 0,
          weather: briefing.context?.weather || null,
        },
        summary: briefing.summary,
      };
    }
    case "list_emails": {
      const connection = await resolveActiveGmailAccount(env, db, user.id);
      if (!connection?.composio_connected_account_id) {
        return {
          data: { error: "Gmail is not connected. Ask the user to connect it under Connections." },
          summary: "Gmail is not connected yet.",
        };
      }
      const { messages } = await fetchEmails(env, {
        userId: user.id,
        connectedAccountId: connection.composio_connected_account_id,
        query: args.query || "in:inbox",
        maxResults: Math.min(25, Math.max(1, Number(args.limit) || 8)),
      });
      await writeAudit(db, {
        userId: user.id,
        action: "gmail.fetch",
        resourceType: "gmail",
        resourceId: connection.composio_connected_account_id,
        meta: { via: "talk", count: messages.length },
      });
      return {
        data: { emails: messages, count: messages.length },
        summary: `Found ${messages.length} email${messages.length === 1 ? "" : "s"}.`,
      };
    }
    case "create_email_draft": {
      const connection = await resolveActiveGmailAccount(env, db, user.id);
      if (!connection?.composio_connected_account_id) {
        return {
          data: { error: "Gmail is not connected. Ask the user to connect it under Connections." },
          summary: "Gmail is not connected yet.",
        };
      }
      const draft = await createEmailDraft(env, {
        userId: user.id,
        connectedAccountId: connection.composio_connected_account_id,
        recipientEmail: args.recipient_email,
        subject: args.subject,
        body: args.body,
      });
      await writeAudit(db, {
        userId: user.id,
        action: "gmail.draft_create",
        resourceType: "gmail_draft",
        resourceId: draft.draftId,
        meta: { via: "talk", to: args.recipient_email },
      });
      return {
        data: { draftId: draft.draftId, to: args.recipient_email, subject: args.subject || null },
        summary: draft.draftId
          ? `Created Gmail draft to ${args.recipient_email} (not sent).`
          : `Draft request completed for ${args.recipient_email} (not sent).`,
      };
    }
    case "list_automations":
      return { data: { automations: [], message: "Automation engine coming soon." }, summary: "No automations yet — this feature is coming soon." };

    case "create_contact": {
      const id = uid("contact");
      const now = nowIso();
      await db.prepare("INSERT INTO crm_contacts (id, team_id, user_id, name, email, phone, company, notes, tags_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, null, user.id, args.name || "", args.email || null, args.phone || null, args.company || null, null, null, now, now).run();
      return { data: { id }, summary: `Created contact: ${args.name}` };
    }
    case "list_contacts": {
      const rows = await db.prepare("SELECT id, name, email, company FROM crm_contacts WHERE user_id = ? ORDER BY updated_at DESC LIMIT 20").bind(user.id).all();
      return { data: rows.results || [], summary: `Found ${(rows.results||[]).length} contacts.` };
    }
    case "log_interaction": {
      const id = uid("int");
      const now = nowIso();
      await db.prepare("INSERT INTO crm_interactions (id, contact_id, user_id, kind, summary, occurred_at, created_at) VALUES (?,?,?,?,?,?,?)")
        .bind(id, args.contact_id, user.id, args.kind || "note", args.summary || "", now, now).run();
      return { data: { id }, summary: `Logged ${args.kind || "note"} interaction.` };
    }
    case "get_meeting_prep": {
      const event = await db.prepare("SELECT * FROM calendar_events WHERE id = ? AND user_id = ?").bind(args.event_id, user.id).first();
      if (!event) return { data: { error: "Event not found" }, summary: "Could not find that event." };
      const existing = await db.prepare("SELECT * FROM meeting_prep WHERE calendar_event_id = ? AND user_id = ?").bind(args.event_id, user.id).first();
      if (existing) return { data: existing, summary: existing.summary };
      return { data: { event_title: event.title, starts_at: event.starts_at, tip: "Use the Meeting Prep panel for full AI-generated prep." }, summary: `Meeting: ${event.title} at ${event.starts_at}` };
    }
    case "create_chore": {
      const teamRow = await db.prepare("SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active' LIMIT 1").bind(user.id).first();
      if (!teamRow) return { data: { error: "No team found" }, summary: "You need a team to create chores." };
      const id = uid("chore");
      const now = nowIso();
      await db.prepare("INSERT INTO chores (id, team_id, assigned_user_id, title, body, recurrence, status, due_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .bind(id, teamRow.id, args.assigned_user_id || null, args.title, null, null, "pending", args.due_at || null, now, now).run();
      return { data: { id }, summary: `Created chore: ${args.title}` };
    }
    case "list_chores": {
      const teamRow = await db.prepare("SELECT t.id FROM teams t JOIN team_members tm ON tm.team_id = t.id WHERE tm.user_id = ? AND tm.status = 'active' LIMIT 1").bind(user.id).first();
      if (!teamRow) return { data: [], summary: "No team found." };
      const rows = await db.prepare("SELECT id, title, assigned_user_id, status, due_at FROM chores WHERE team_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 20").bind(teamRow.id).all();
      return { data: rows.results || [], summary: `${(rows.results||[]).length} pending chores.` };
    }
    case "create_appointment": {
      const id = uid("appt");
      const now = nowIso();
      await db.prepare("INSERT INTO appointments (id, team_id, user_id, contact_id, title, starts_at, ends_at, status, notes, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
        .bind(id, null, user.id, args.contact_id || null, args.title, args.starts_at, args.ends_at || null, "scheduled", args.notes || null, now, now).run();
      return { data: { id }, summary: `Created appointment: ${args.title}` };
    }
    case "list_appointments": {
      const rows = await db.prepare("SELECT id, title, starts_at, ends_at, status FROM appointments WHERE user_id = ? ORDER BY starts_at ASC LIMIT 20").bind(user.id).all();
      return { data: rows.results || [], summary: `${(rows.results||[]).length} appointments.` };
    }
    case "generate_marketing_copy": {
      return { data: { tip: "Marketing copy generated via the main conversation." }, summary: "I'll generate that copy in my reply." };
    }
    default:
      return { data: { error: `Unknown tool ${name}` }, summary: "That tool isn't available." };
  }
}

async function callOpenAI(key, messages, tools) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.4,
      messages,
      ...(tools ? { tools, tool_choice: "auto" } : {}),
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || `OpenAI request failed (${res.status})`);
  return data;
}

function faqReply(message, hasKey) {
  const hit = FAQ.find((f) => f.q.test(message));
  return {
    reply:
      hit?.a ||
      "I’m Amber. I can help you pick Personal, Family, Executive, or Business — then Start Now on Pricing for secure Stripe checkout. What are you trying to manage first?",
    source: hasKey ? "fallback" : "guided",
  };
}

async function handleAnonymous(message, key) {
  if (key) {
    try {
      const data = await callOpenAI(key, [
        { role: "system", content: MARKETING_SYSTEM_PROMPT },
        { role: "user", content: message },
      ]);
      const reply = data?.choices?.[0]?.message?.content;
      if (reply) return { reply, source: "openai", conversationId: null, toolsUsed: [] };
    } catch {
      // fall through to FAQ
    }
  }
  return { ...faqReply(message, Boolean(key)), conversationId: null, toolsUsed: [] };
}

export async function onRequestPost(context) {
  const body = await readJson(context.request);
  const message = String(body.message || "").trim();
  if (!message) return json({ error: "Message required" }, 400);

  const key = context.env.OPENAI_API_KEY;
  const db = context.env.DB;

  const user = db ? await getUserFromRequest(db, context.request).catch(() => null) : null;
  if (!user) {
    return json(await handleAnonymous(message, key));
  }

  await ensureSchema(db);

  try {
    let conversationId = body.conversationId ? String(body.conversationId) : null;
    const ts = nowIso();
    let isNewConversation = false;

    if (conversationId) {
      const existing = await db
        .prepare("SELECT id FROM conversations WHERE id = ? AND user_id = ?")
        .bind(conversationId, user.id)
        .first();
      if (!existing) conversationId = null;
    }
    if (!conversationId) {
      conversationId = uid("conv");
      isNewConversation = true;
      await db
        .prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .bind(conversationId, user.id, message.slice(0, 60), ts, ts)
        .run();
    }

    const historyRows = await db
      .prepare(
        "SELECT role, content FROM messages WHERE conversation_id = ? AND role IN ('user','assistant') ORDER BY created_at DESC LIMIT 20",
      )
      .bind(conversationId)
      .all();
    const history = (historyRows.results || []).reverse().map((r) => ({ role: r.role, content: r.content }));

    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, user_id, role, content, tool_name, tool_payload_json, created_at) VALUES (?, ?, ?, 'user', ?, NULL, NULL, ?)",
      )
      .bind(uid("msg"), conversationId, user.id, message, ts)
      .run();

    const memoryRows = await db
      .prepare("SELECT title, content FROM memories WHERE user_id = ? ORDER BY importance DESC, created_at DESC LIMIT 8")
      .bind(user.id)
      .all();
    const memories = memoryRows.results || [];
    const memoryBlock = memories.length
      ? `\n\nWhat you remember about this user:\n${memories.map((m) => `- ${m.title}: ${m.content}`).join("\n")}`
      : "";

    const systemPrompt =
      "You are Amber, the AmberOne assistant. Mission: One Assistant. One Place. One Life. Be warm, clear, concise, and proactive. " +
      "Use the provided tools to save memories, manage the user's calendar, set reminders, save notes, manage shopping/todo lists, deliver briefings, and help with Gmail (list inbox / create drafts only — never claim an email was sent unless a send tool succeeded). " +
      "When the user asks what's on today, for a briefing, or for an evening recap, call get_briefing. For inbox questions, call list_emails. For 'draft an email', call create_email_draft. " +
      "Never invent Enterprise custom quotes. Do not claim a feature (like phone calls, SMS, or third-party sync) is live unless you've verified it via a tool — Twilio calling/SMS is not available yet." +
      memoryBlock;

    if (!key) {
      const fallback = faqReply(message, false);
      await db
        .prepare(
          "INSERT INTO messages (id, conversation_id, user_id, role, content, tool_name, tool_payload_json, created_at) VALUES (?, ?, ?, 'assistant', ?, NULL, NULL, ?)",
        )
        .bind(uid("msg"), conversationId, user.id, fallback.reply, nowIso())
        .run();
      return json({ ...fallback, conversationId, toolsUsed: [] });
    }

    const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: message }];
    const toolsUsed = [];
    let finalReply = null;
    let source = "openai";

    try {
      for (let round = 0; round < 4; round++) {
        const data = await callOpenAI(key, messages, TOOLS);
        const choice = data?.choices?.[0]?.message;
        if (!choice) break;
        if (choice.tool_calls && choice.tool_calls.length) {
          messages.push(choice);
          for (const call of choice.tool_calls) {
            const name = call.function?.name;
            let args = {};
            try {
              args = JSON.parse(call.function?.arguments || "{}");
            } catch {
              args = {};
            }
            let result;
            try {
              result = await runTool(name, args, { db, user, env: context.env });
            } catch (err) {
              result = { data: { error: err instanceof Error ? err.message : String(err) }, summary: "Tool failed." };
            }
            toolsUsed.push({ name, args, summary: result.summary });
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.data ?? {}) });
          }
          continue;
        }
        finalReply = choice.content || null;
        break;
      }
    } catch (err) {
      source = "fallback";
      finalReply = null;
    }

    if (!finalReply) {
      const fallback = faqReply(message, true);
      finalReply = fallback.reply;
      source = toolsUsed.length ? "openai" : "fallback";
    }

    await db
      .prepare(
        "INSERT INTO messages (id, conversation_id, user_id, role, content, tool_name, tool_payload_json, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)",
      )
      .bind(
        uid("msg"),
        conversationId,
        user.id,
        finalReply,
        toolsUsed.length ? toolsUsed.map((t) => t.name).join(",") : null,
        toolsUsed.length ? JSON.stringify(toolsUsed) : null,
        nowIso(),
      )
      .run();

    await db
      .prepare("UPDATE conversations SET updated_at = ?, title = CASE WHEN ? THEN ? ELSE title END WHERE id = ?")
      .bind(nowIso(), isNewConversation ? 1 : 0, message.slice(0, 60), conversationId)
      .run();

    return json({ reply: finalReply, source, conversationId, toolsUsed: toolsUsed.map((t) => ({ name: t.name, summary: t.summary })) });
  } catch (err) {
    return json(
      {
        error: "Talk failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      500,
    );
  }
}

export async function onRequestGet() {
  return json({ error: "POST { message, conversationId? }" }, 405);
}
