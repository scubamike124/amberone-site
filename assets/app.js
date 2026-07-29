/* AmberOne shared client helpers */
window.AmberOne = {
  async api(path, options = {}) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
      ...options,
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  },

  showBanner(el, message, kind = "warn") {
    if (!el) return;
    el.className = `banner is-on ${kind}`;
    el.textContent = message;
  },

  qs(name) {
    return new URLSearchParams(location.search).get(name);
  },

  async requireAuth(redirect = "/login") {
    const { res, data } = await this.api("/api/auth/me");
    if (!res.ok || !data.user) {
      location.href = `${redirect}?next=${encodeURIComponent(location.pathname + location.search)}`;
      return null;
    }
    return data.user;
  },

  async logout() {
    await this.api("/api/auth/logout", { method: "POST", body: "{}" });
    location.href = "/";
  },

  bindNav() {
    const toggle = document.querySelector("[data-nav-toggle]");
    const links = document.querySelector("[data-nav-links]");
    if (toggle && links) {
      toggle.addEventListener("click", () => links.classList.toggle("is-open"));
    }
    document.querySelectorAll("[data-logout]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this.logout();
      });
    });
  },

  async startCheckout(plan, button) {
    const label = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "Opening Stripe…";
    }
    const me = await this.api("/api/auth/me");
    if (!me.res.ok || !me.data.user) {
      location.href = `/signup?plan=${encodeURIComponent(plan)}`;
      return;
    }
    const { res, data } = await this.api("/api/checkout", {
      method: "POST",
      body: JSON.stringify({ plan }),
    });
    if (!res.ok || !data.url) {
      if (button) {
        button.disabled = false;
        button.textContent = label;
      }
      throw new Error(data.error || "Checkout unavailable");
    }
    location.href = data.url;
  },

  mountTalk() {
    if (document.getElementById("ao-talk-root")) return;
    const root = document.createElement("div");
    root.id = "ao-talk-root";
    root.innerHTML = `
      <button type="button" class="btn btn-primary talk-fab" id="ao-talk-open">Talk to Amber</button>
      <div class="talk-panel" id="ao-talk-panel" role="dialog" aria-label="Talk to Amber">
        <div class="talk-head">
          <strong>Talk to Amber</strong>
          <button type="button" class="btn btn-ghost" id="ao-talk-close" style="padding:0.35rem 0.7rem">Close</button>
        </div>
        <div class="talk-log" id="ao-talk-log"></div>
        <form class="talk-form" id="ao-talk-form">
          <input class="field" id="ao-talk-input" placeholder="Ask about Personal, Family, Business…" required />
          <button class="btn btn-primary" type="submit">Send</button>
        </form>
      </div>`;
    document.body.appendChild(root);
    const panel = document.getElementById("ao-talk-panel");
    const log = document.getElementById("ao-talk-log");
    const add = (text, me = false) => {
      const div = document.createElement("div");
      div.className = `talk-bubble${me ? " me" : ""}`;
      div.textContent = text;
      log.appendChild(div);
      log.scrollTop = log.scrollHeight;
    };
    add("Hi — I’m Amber. Ask about plans, setup, or what AmberOne can manage.");
    document.getElementById("ao-talk-open").onclick = () => panel.classList.add("is-open");
    document.getElementById("ao-talk-close").onclick = () => panel.classList.remove("is-open");
    document.getElementById("ao-talk-form").onsubmit = async (e) => {
      e.preventDefault();
      const input = document.getElementById("ao-talk-input");
      const message = input.value.trim();
      if (!message) return;
      add(message, true);
      input.value = "";
      const { data } = await this.api("/api/talk", {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      add(data.reply || data.error || "I couldn’t answer that just now.");
    };
  },
};

document.addEventListener("DOMContentLoaded", () => {
  window.AmberOne.bindNav();
  if (!location.pathname.includes("/dashboard")) {
    window.AmberOne.mountTalk();
  }
});
