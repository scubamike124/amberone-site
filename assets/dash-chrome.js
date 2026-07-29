/* Shared dashboard chrome — consistent light V3 nav on every page */
(function () {
  const path = location.pathname.replace(/\/$/, "") || "/dashboard";
  const is = (p) => path === p || path.startsWith(p + "/") || path.endsWith(p);

  const links = [
    { label: "Workspace", type: "label" },
    { href: "/dashboard/", label: "Home", match: (p) => p === "/dashboard" || p.endsWith("/dashboard") },
    { href: "/dashboard/calendar", label: "Calendar" },
    { href: "/dashboard/reminders", label: "Reminders" },
    { href: "/dashboard/memories", label: "Memories" },
    { href: "/dashboard/notes", label: "Notes" },
    { href: "/dashboard/connections", label: "Connections" },
    { label: "Account", type: "label" },
    { href: "/dashboard/billing", label: "Billing" },
    { href: "/dashboard/settings", label: "Settings" },
    { href: "/dashboard/notifications", label: "Notifications" },
    { href: "/dashboard/onboarding", label: "Onboarding" },
    { href: "/pricing", label: "Upgrade plan" },
    { label: "Surfaces", type: "label" },
    { href: "/dashboard/family/", label: "Family" },
    { href: "/dashboard/executive/", label: "Executive" },
    { href: "/dashboard/business/", label: "Business" },
    { href: "/dashboard/marketplace", label: "Marketplace" },
  ];

  function renderAside(activeHint) {
    return links
      .map((item) => {
        if (item.type === "label") return `<div class="nav-label">${item.label}</div>`;
        const on =
          (item.match && item.match(path)) ||
          (!item.match && (is(item.href.replace(/\/$/, "")) || path.includes(item.href.replace(/\/$/, "")))) ||
          (activeHint && item.label.toLowerCase() === activeHint.toLowerCase());
        return `<a class="${on ? "is-on" : ""}" href="${item.href}">${item.label}</a>`;
      })
      .join("");
  }

  document.querySelectorAll("[data-dash-nav]").forEach((el) => {
    el.innerHTML = renderAside(el.getAttribute("data-active") || "");
    el.classList.add("panel", "dash-nav");
  });
})();
