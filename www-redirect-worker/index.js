/**
 * Canonicalizes www.amberoneai.com -> amberoneai.com (permanent redirect).
 * Cloudflare Pages' _redirects file does not reliably catch requests that
 * arrive via a plain CNAME (not a registered Pages Custom Domain), so this
 * runs as a Worker bound directly to the www.amberoneai.com route instead.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    url.hostname = "amberoneai.com";
    return Response.redirect(url.toString(), 301);
  },
};
