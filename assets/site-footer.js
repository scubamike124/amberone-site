/* Shared marketing footer + top hook */
(function () {
  const hookText = "Run your whole life from one conversation.";
  if (!document.querySelector(".site-hook")) {
    const hook = document.createElement("div");
    hook.className = "site-hook";
    hook.setAttribute("role", "banner");
    hook.textContent = hookText;
    document.body.prepend(hook);
  }

  const year = new Date().getFullYear();
  const html = `
    <div class="site-footer-grid">
      <div>
        <p class="brand-line">Amber<span>One</span></p>
        <p>One Assistant. One Place. One Life. An AI operating system for personal life, family, work, and business.</p>
      </div>
      <div>
        <h4>Explore</h4>
        <ul>
          <li><a href="/#capabilities">What AmberOne does</a></li>
          <li><a href="/pricing">Pricing</a></li>
          <li><a href="/plans">Compare plans</a></li>
          <li><a href="/family">Family</a></li>
          <li><a href="/faq">FAQ</a></li>
          <li><a href="/contact">Contact</a></li>
        </ul>
      </div>
      <div>
        <h4>Account</h4>
        <ul>
          <li><a href="/signup">Create account</a></li>
          <li><a href="/login">Sign in</a></li>
          <li><a href="/dashboard/">Dashboard</a></li>
          <li><a href="/forgot-password">Reset password</a></li>
        </ul>
      </div>
      <div>
        <h4>Legal</h4>
        <ul>
          <li><a href="/privacy">Privacy Policy</a></li>
          <li><a href="/terms">Terms of Service</a></li>
          <li><a href="/cookies">Cookie Policy</a></li>
          <li><a href="/refunds">Refund Policy</a></li>
          <li><a href="/acceptable-use">Acceptable Use</a></li>
        </ul>
      </div>
    </div>
    <div class="site-footer-bottom">
      <span>© ${year} AmberOne. All rights reserved.</span>
      <div class="site-footer-legal">
        <a href="/privacy">Privacy</a>
        <a href="/terms">Terms</a>
        <a href="/cookies">Cookies</a>
        <a href="/refunds">Refunds</a>
        <a href="/acceptable-use">Acceptable Use</a>
      </div>
    </div>
  `;
  document.querySelectorAll("[data-site-footer]").forEach((el) => {
    el.classList.add("site-footer");
    el.innerHTML = html;
  });
})();
