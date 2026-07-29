/**
 * Daily briefing / evening recap helpers.
 * Weather uses free Open-Meteo (no API key) when lat/lon or city is available.
 */

function pad(n) {
  return String(n).padStart(2, "0");
}

/** Format a Date in a given IANA timezone as YYYY-MM-DD. */
export function dayKeyInTz(date, timeZone) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone || "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(date);
    const y = parts.find((p) => p.type === "year")?.value;
    const m = parts.find((p) => p.type === "month")?.value;
    const d = parts.find((p) => p.type === "day")?.value;
    if (y && m && d) return `${y}-${m}-${d}`;
  } catch {
    // fall through
  }
  return date.toISOString().slice(0, 10);
}

/** Hour 0–23 in timezone. */
export function hourInTz(date, timeZone) {
  try {
    const hour = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: timeZone || "UTC", hour: "numeric", hour12: false }).format(date),
    );
    return Number.isFinite(hour) ? hour % 24 : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

export function resolveMode(mode, timeZone, now = new Date()) {
  const m = String(mode || "auto").toLowerCase();
  if (m === "morning" || m === "briefing" || m === "daily") return "morning";
  if (m === "evening" || m === "recap") return "evening";
  return hourInTz(now, timeZone) >= 17 ? "evening" : "morning";
}

/** Local day window as ISO strings (approximate via offset sampling). */
export function localDayBounds(dayKey, timeZone) {
  // Build UTC instants that cover the local calendar day by scanning hours.
  // Safer than assuming a fixed offset.
  const startGuess = new Date(`${dayKey}T00:00:00.000Z`);
  let dayStart = null;
  let dayEnd = null;
  for (let h = -36; h <= 36; h++) {
    const candidate = new Date(startGuess.getTime() + h * 3600 * 1000);
    if (dayKeyInTz(candidate, timeZone) === dayKey) {
      if (!dayStart) dayStart = candidate;
      dayEnd = new Date(candidate.getTime() + 3600 * 1000);
    } else if (dayStart && dayEnd) {
      break;
    }
  }
  if (!dayStart || !dayEnd) {
    const start = new Date(`${dayKey}T00:00:00.000Z`);
    return { from: start.toISOString(), to: new Date(start.getTime() + 86400000).toISOString() };
  }
  return { from: dayStart.toISOString(), to: dayEnd.toISOString() };
}

export async function fetchWeather({ lat, lon, city, timeZone }) {
  try {
    let latitude = lat != null ? Number(lat) : null;
    let longitude = lon != null ? Number(lon) : null;
    let label = city || null;

    if ((!Number.isFinite(latitude) || !Number.isFinite(longitude)) && city) {
      const geoRes = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`,
      );
      if (geoRes.ok) {
        const geo = await geoRes.json();
        const hit = geo?.results?.[0];
        if (hit) {
          latitude = hit.latitude;
          longitude = hit.longitude;
          label = [hit.name, hit.admin1, hit.country_code].filter(Boolean).join(", ");
        }
      }
    }

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.searchParams.set("latitude", String(latitude));
    url.searchParams.set("longitude", String(longitude));
    url.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m");
    url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_probability_max");
    url.searchParams.set("timezone", timeZone || "auto");
    url.searchParams.set("forecast_days", "1");

    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    return {
      label,
      latitude,
      longitude,
      currentTempC: data?.current?.temperature_2m ?? null,
      weatherCode: data?.current?.weather_code ?? null,
      windSpeed: data?.current?.wind_speed_10m ?? null,
      highC: data?.daily?.temperature_2m_max?.[0] ?? null,
      lowC: data?.daily?.temperature_2m_min?.[0] ?? null,
      precipChance: data?.daily?.precipitation_probability_max?.[0] ?? null,
      summary: weatherCodeLabel(data?.current?.weather_code),
    };
  } catch {
    return null;
  }
}

function weatherCodeLabel(code) {
  const map = {
    0: "Clear",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Foggy",
    48: "Foggy",
    51: "Light drizzle",
    61: "Rain",
    63: "Rain",
    65: "Heavy rain",
    71: "Snow",
    80: "Showers",
    95: "Thunderstorm",
  };
  return map[code] || (code == null ? null : "Mixed conditions");
}

export async function gatherBriefingContext(db, user, { mode, timeZone, dayKey, weather }) {
  const bounds = localDayBounds(dayKey, timeZone);
  const nowIso = new Date().toISOString();

  const [events, pendingReminders, unreadNotifications, memories, openListItems, recentNotes] = await Promise.all([
    db
      .prepare(
        "SELECT id, title, starts_at, ends_at, all_day, location FROM calendar_events WHERE user_id = ? AND starts_at >= ? AND starts_at < ? ORDER BY starts_at ASC LIMIT 20",
      )
      .bind(user.id, bounds.from, bounds.to)
      .all(),
    db
      .prepare("SELECT id, title, due_at, status FROM reminders WHERE user_id = ? AND status = 'pending' ORDER BY due_at ASC LIMIT 10")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT id, kind, title, body FROM notifications WHERE user_id = ? AND read_at IS NULL ORDER BY created_at DESC LIMIT 8")
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT title, content, importance FROM memories WHERE user_id = ? ORDER BY importance DESC, created_at DESC LIMIT 5")
      .bind(user.id)
      .all(),
    db
      .prepare(
        `SELECT l.title AS list_title, i.text AS item_text
         FROM list_items i JOIN lists l ON l.id = i.list_id
         WHERE i.user_id = ? AND i.checked = 0
         ORDER BY l.updated_at DESC, i.position ASC LIMIT 12`,
      )
      .bind(user.id)
      .all(),
    db
      .prepare("SELECT title, body, updated_at FROM notes WHERE user_id = ? ORDER BY updated_at DESC LIMIT 3")
      .bind(user.id)
      .all(),
  ]);

  return {
    mode,
    dayKey,
    timeZone,
    generatedAt: nowIso,
    name: user.name || null,
    events: events.results || [],
    reminders: pendingReminders.results || [],
    notifications: unreadNotifications.results || [],
    memories: memories.results || [],
    openListItems: openListItems.results || [],
    recentNotes: recentNotes.results || [],
    weather: weather || null,
    window: bounds,
  };
}

function formatTime(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(11, 16);
  }
}

export function buildTemplateSummary(ctx) {
  const who = ctx.name ? `, ${ctx.name}` : "";
  const lines = [];
  if (ctx.mode === "evening") {
    lines.push(`Evening recap${who}.`);
    lines.push(`Today (${ctx.dayKey}): ${ctx.events.length} event${ctx.events.length === 1 ? "" : "s"} on the calendar.`);
  } else {
    lines.push(`Good morning${who}.`);
    lines.push(`Here's your briefing for ${ctx.dayKey}.`);
  }

  if (ctx.weather) {
    const bits = [
      ctx.weather.summary,
      ctx.weather.currentTempC != null ? `${Math.round(ctx.weather.currentTempC)}°C now` : null,
      ctx.weather.highC != null && ctx.weather.lowC != null
        ? `high ${Math.round(ctx.weather.highC)}° / low ${Math.round(ctx.weather.lowC)}°`
        : null,
      ctx.weather.precipChance != null ? `${ctx.weather.precipChance}% rain chance` : null,
    ].filter(Boolean);
    lines.push(`Weather${ctx.weather.label ? ` in ${ctx.weather.label}` : ""}: ${bits.join(" · ") || "available"}.`);
  }

  if (ctx.events.length) {
    lines.push(
      "Schedule: " +
        ctx.events
          .slice(0, 5)
          .map((e) => `${e.all_day ? "All day" : formatTime(e.starts_at, ctx.timeZone)} — ${e.title}`)
          .join("; ") +
        (ctx.events.length > 5 ? ` (+${ctx.events.length - 5} more)` : "") +
        ".",
    );
  } else {
    lines.push(ctx.mode === "evening" ? "No calendar events were logged for today." : "Nothing on the calendar yet today.");
  }

  if (ctx.reminders.length) {
    lines.push(
      `Reminders: ${ctx.reminders
        .slice(0, 4)
        .map((r) => r.title)
        .join("; ")}${ctx.reminders.length > 4 ? ` (+${ctx.reminders.length - 4} more)` : ""}.`,
    );
  }

  if (ctx.openListItems.length) {
    lines.push(
      `Open list items: ${ctx.openListItems
        .slice(0, 5)
        .map((i) => i.item_text)
        .join("; ")}${ctx.openListItems.length > 5 ? "…" : ""}.`,
    );
  }

  if (ctx.notifications.length) {
    lines.push(`Unread notifications: ${ctx.notifications.length}.`);
  }

  if (ctx.mode === "evening") {
    lines.push("Wrap-up tip: clear due reminders and note anything Amber should remember tomorrow.");
  } else {
    lines.push("Ask Amber to add events, set reminders, or update your shopping list anytime.");
  }

  return lines.join(" ");
}

export async function polishWithOpenAI(apiKey, ctx, template) {
  if (!apiKey) return null;
  const payload = {
    mode: ctx.mode,
    dayKey: ctx.dayKey,
    name: ctx.name,
    weather: ctx.weather,
    events: ctx.events.map((e) => ({ title: e.title, starts_at: e.starts_at, location: e.location, all_day: e.all_day })),
    reminders: ctx.reminders.map((r) => ({ title: r.title, due_at: r.due_at })),
    openListItems: ctx.openListItems.slice(0, 8),
    notifications: ctx.notifications.map((n) => n.title),
    memories: ctx.memories.map((m) => `${m.title}: ${m.content}`),
  };
  const system =
    ctx.mode === "evening"
      ? "You are Amber for AmberOne. Write a warm, concise evening recap (3–6 short sentences or short bullets). Use only the provided facts. Do not invent events, weather, or commitments."
      : "You are Amber for AmberOne. Write a warm, concise daily morning briefing (3–6 short sentences or short bullets). Use only the provided facts. Do not invent events, weather, or commitments.";
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.4,
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: `Facts JSON:\n${JSON.stringify(payload)}\n\nTemplate fallback (improve, don't contradict):\n${template}`,
          },
        ],
      }),
    });
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    return text ? String(text).trim() : null;
  } catch {
    return null;
  }
}

export async function buildBriefing(db, env, user, options = {}) {
  const timeZone = options.timeZone || "America/Los_Angeles";
  const now = options.now || new Date();
  const mode = resolveMode(options.mode, timeZone, now);
  const dayKey = options.dayKey || dayKeyInTz(now, timeZone);

  let weather = null;
  if (options.includeWeather !== false) {
    weather = await fetchWeather({
      lat: options.lat,
      lon: options.lon,
      city: options.city,
      timeZone,
    });
  }

  const ctx = await gatherBriefingContext(db, user, { mode, timeZone, dayKey, weather });
  const template = buildTemplateSummary(ctx);
  const polished = await polishWithOpenAI(env.OPENAI_API_KEY, ctx, template);
  const summary = polished || template;

  return {
    mode,
    dayKey,
    timeZone,
    summary,
    source: polished ? "openai" : "template",
    context: {
      events: ctx.events,
      reminders: ctx.reminders,
      notifications: ctx.notifications,
      openListItems: ctx.openListItems,
      weather: ctx.weather,
      window: ctx.window,
    },
    generatedAt: ctx.generatedAt,
  };
}
