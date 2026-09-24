(() => {
  const prefersReduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const syncThemeToggle = () => {
    const toggle = document.querySelector(".js-theme-toggle");
    if (!toggle) return;
    toggle.setAttribute("aria-pressed", document.documentElement.classList.contains("dark") ? "true" : "false");
  };
  syncThemeToggle();
  document.querySelectorAll(".js-theme-toggle").forEach((toggle) => {
    toggle.addEventListener("click", () => requestAnimationFrame(syncThemeToggle));
  });

  const progress = document.querySelector("[data-scroll-progress]");
  const header = document.querySelector("[data-site-header]");
  const scrollCue = document.querySelector("[data-scroll-cue]");
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      const top = window.scrollY || document.documentElement.scrollTop;
      const height = document.documentElement.scrollHeight - window.innerHeight;
      if (progress) progress.style.width = (height > 0 ? (top / height) * 100 : 0) + "%";
      if (header) header.classList.toggle("is-scrolled", top > 24);
      // Scrub the hero scroll cue directly from page scroll: fully invisible at top,
      // then drawn/faded in at the same pace as the user's first viewport scroll.
      if (scrollCue && !prefersReduce) {
        const span = Math.max(window.innerHeight * 0.62, 1);
        const cue = Math.min(Math.max(top / span, 0), 1);
        scrollCue.style.setProperty("--cue-progress", cue.toFixed(3));
      }
      ticking = false;
    });
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  document.querySelectorAll(".gl-nav details").forEach((details) => {
    const summary = details.querySelector("summary");
    if (!summary) return;
    summary.setAttribute("aria-haspopup", "menu");
    const syncMenu = () => summary.setAttribute("aria-expanded", details.open ? "true" : "false");
    details.addEventListener("toggle", syncMenu);
    details.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      details.removeAttribute("open");
      summary.focus();
      syncMenu();
    });
    document.addEventListener("click", (event) => {
      if (!details.open || details.contains(event.target)) return;
      details.removeAttribute("open");
      syncMenu();
    });
    syncMenu();
  });

  const animatedEls = document.querySelectorAll("[data-animate], [data-reveal]");
  if ("IntersectionObserver" in window) {
    const reveal = new IntersectionObserver((entries, obs) => {
      entries
        .filter((entry) => entry.isIntersecting)
        .forEach((entry, index) => {
          if (!prefersReduce) entry.target.style.transitionDelay = Math.min(index * 70, 350) + "ms";
          entry.target.classList.add("is-visible");
          obs.unobserve(entry.target);
        });
    }, { rootMargin: "0px 0px -5% 0px", threshold: 0.05 });
    animatedEls.forEach((el) => reveal.observe(el));
  } else {
    animatedEls.forEach((el) => el.classList.add("is-visible"));
  }

  // Pages without a full translation dictionary share the homepage navigation
  // language controls. Translate only the chrome; keep article/legal content
  // and the document language in German. Homepage i18n remains unchanged.
  if (!window.GL_PAGE_COPY) {
    const chrome = [...document.querySelectorAll(".tj-header, .tj-footer")];
    const english = {
      "nav.profile": "Profile", "nav.projects": "Projects", "nav.notes": "Notes",
      "footer.privacyLink": "Privacy", "footer.languageLabel": "Navigation language"
    };
    const labels = chrome.flatMap((region) => [...region.querySelectorAll("[data-i18n]")]);
    const german = new Map(labels.map((el) => [el, el.textContent]));
    const controls = document.querySelectorAll("[data-language-option]");
    const applyChromeLanguage = (language, persist = false) => {
      const lang = language === "en" ? "en" : "de";
      chrome.forEach((region) => region.setAttribute("lang", lang));
      labels.forEach((el) => {
        el.textContent = lang === "en" ? (english[el.dataset.i18n] || german.get(el)) : german.get(el);
      });
      chrome.forEach((region) => {
        const nav = region.querySelector("nav");
        if (nav) nav.setAttribute("aria-label", lang === "en" ? "Main navigation" : "Hauptnavigation");
        const brand = region.querySelector('a[aria-label]');
        if (brand) brand.setAttribute("aria-label", lang === "en" ? "Tom Jansen, homepage" : "Tom Jansen, Startseite");
        const toggle = region.querySelector(".js-theme-toggle");
        if (toggle) toggle.setAttribute("aria-label", lang === "en" ? "Toggle theme" : "Farbschema wechseln");
      });
      controls.forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.languageOption === lang)));
      if (persist) {
        try { localStorage.setItem("gl-language", lang); } catch (_) { /* Storage may be disabled. */ }
      }
    };
    controls.forEach((button) => button.addEventListener("click", () => applyChromeLanguage(button.dataset.languageOption, true)));
    let savedLanguage = "de";
    try { savedLanguage = localStorage.getItem("gl-language") || "de"; } catch (_) { /* Use German. */ }
    applyChromeLanguage(savedLanguage);
  }

  const clockTargets = document.querySelectorAll("[data-live-clock]");
  if (clockTargets.length) {
    const fmt = () => new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin", hourCycle: "h23" }).format(new Date());
    const tick = () => clockTargets.forEach((el) => (el.textContent = fmt()));
    tick();
    setTimeout(() => { tick(); setInterval(tick, 60_000); }, (60 - new Date().getSeconds()) * 1000 + 50);
  }
})();
