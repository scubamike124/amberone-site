import {

  json,

  nowIso,

  randomToken,

  readJson,

  sha256Hex,

  uid,

} from "../../_lib/core.js";



async function sendResend({ apiKey, from, to, subject, html }) {

  const mail = await fetch("https://api.resend.com/emails", {

    method: "POST",

    headers: {

      Authorization: `Bearer ${apiKey}`,

      "Content-Type": "application/json",

    },

    body: JSON.stringify({ from, to: [to], subject, html }),

  });

  const text = await mail.text();

  return { ok: mail.ok, status: mail.status, text: text.slice(0, 400) };

}



export async function onRequestPost(context) {

  try {

    const db = context.env.DB;

    if (!db) return json({ error: "Database not configured" }, 503);



    const body = await readJson(context.request);

    const email = String(body.email || "")

      .trim()

      .toLowerCase();

    if (!email) return json({ error: "Email required" }, 400);



    const user = await db.prepare("SELECT id, email, name FROM users WHERE email = ?").bind(email).first();

    // Always return ok to avoid account enumeration

    if (!user) {

      return json({

        ok: true,

        message: "If that email exists, a reset link was sent.",

      });

    }



    const token = randomToken(32);

    const tokenHash = await sha256Hex(token);

    const id = uid("reset");

    const created = nowIso();

    const expires = new Date(Date.now() + 1000 * 60 * 60).toISOString();

    await db

      .prepare(

        "INSERT INTO password_resets (id, user_id, token_hash, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, NULL, ?)",

      )

      .bind(id, user.id, tokenHash, expires, created)

      .run();



    const origin = new URL(context.request.url);

    const resetUrl = `${origin.protocol}//${origin.host}/reset-password?token=${encodeURIComponent(token)}`;

    const html = `<p>Hi${user.name ? ` ${user.name}` : ""},</p><p>Reset your AmberOne password:</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`;



    const resendKey = context.env.RESEND_API_KEY;

    let emailed = false;

    if (resendKey) {

      const primaryFrom = context.env.EMAIL_FROM || "AmberOne <onboarding@resend.dev>";

      let result = await sendResend({

        apiKey: resendKey,

        from: primaryFrom,

        to: user.email,

        subject: "Reset your AmberOne password",

        html,

      });

      if (!result.ok && !/onboarding@resend\.dev/i.test(primaryFrom)) {

        result = await sendResend({

          apiKey: resendKey,

          from: "AmberOne <onboarding@resend.dev>",

          to: user.email,

          subject: "Reset your AmberOne password",

          html,

        });

      }

      emailed = result.ok;

    }



    const allowFallback =

      context.env.ALLOW_RESET_URL_FALLBACK === "true" ||

      origin.hostname === "127.0.0.1" ||

      origin.hostname === "localhost";



    if (emailed) {

      return json({ ok: true, message: "If that email exists, a reset link was sent." });

    }



    // Production: do not leak reset tokens in API responses

    if (allowFallback) {

      return json({

        ok: true,

        message: "Password reset created. Email delivery unavailable — use this link (dev fallback).",

        resetUrl,

      });

    }



    return json({

      ok: true,

      message:

        "If that email exists, a reset link was sent. If you don’t see it, check spam or try again shortly.",

    });

  } catch (err) {

    return json(

      {

        error: "Forgot password failed",

        detail: err instanceof Error ? err.message : String(err),

      },

      500,

    );

  }

}


