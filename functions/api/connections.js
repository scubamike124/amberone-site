/**
 * Legacy /api/connections — GET/DELETE still work.
 * POST was edge-rate-limited; clients should use /api/connected-services.
 * This POST handler forwards internally to the same logic by re-exporting.
 */
export {
  onRequestGet,
  onRequestDelete,
} from "./connected-services.js";

import { onRequestPost as connectedServicesPost } from "./connected-services.js";

/** Prefer /api/connected-services; keep POST working if the edge rule is removed. */
export async function onRequestPost(context) {
  return connectedServicesPost(context);
}
