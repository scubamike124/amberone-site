/** Ensure D1 schema exists before any API that needs the database. */
import { ensureSchema } from "./_lib/core.js";

export async function onRequest(context) {
  if (context.env.DB) {
    try {
      await ensureSchema(context.env.DB);
    } catch {
      // continue; handlers will surface DB errors
    }
  }
  return context.next();
}
