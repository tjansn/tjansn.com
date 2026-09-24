(() => {
  const COPY = window.GL_PAGE_COPY || {};
  const DEFAULT_LANGUAGE = window.GL_DEFAULT_LANGUAGE || "de";
  const LANGUAGE_STORAGE_KEY = "gl-language";

  // v3: the default language ships in the markup, so read it back instead of
  // keeping a second copy in GL_PAGE_COPY.
  if (!COPY[DEFAULT_LANGUAGE]) {
    const fromMarkup = {};
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      const key = element.getAttribute("data-i18n");
      if (key in fromMarkup) return;
      fromMarkup[key] = element.hasAttribute("data-i18n-html") ? element.innerHTML : element.textContent;
    });
    COPY[DEFAULT_LANGUAGE] = fromMarkup;
  }

  const hasLanguage = (language) => Object.prototype.hasOwnProperty.call(COPY, language);

  const setText = (element, value) => {
    if (value == null) return;
    if (element.hasAttribute("data-i18n-html")) {
      element.innerHTML = value;
    } else {
      element.textContent = value;
    }
  };

  const setAttributes = (element, dictionary) => {
    const map = element.getAttribute("data-i18n-attr");
    if (!map) return;
    map.split(";").forEach((entry) => {
      const [attribute, key] = entry.split(":").map((part) => part && part.trim());
      if (!attribute || !key || dictionary[key] == null) return;
      element.setAttribute(attribute, dictionary[key]);
    });
  };

  const readSavedLanguage = () => {
    try { return localStorage.getItem(LANGUAGE_STORAGE_KEY); } catch (_) { return null; }
  };
  const saveLanguage = (language) => {
    try { localStorage.setItem(LANGUAGE_STORAGE_KEY, language); } catch (_) { /* Storage may be disabled. */ }
  };

  const inSiteChrome = (element) => Boolean(element.closest(".gl-site-header, .gl-site-footer"));

  const applyLanguage = (language, persist = true) => {
    const requested = language || DEFAULT_LANGUAGE;
    document.documentElement.classList.add("is-lang-changing");

    // A page may ship no dictionary for the requested language (articles, project list).
    // Then the markup language stays visible and untouched; the request is still honoured
    // below, so the button is pressed and the preference reaches the other pages.
    if (hasLanguage(requested)) {
      const dictionary = COPY[requested];
      const elements = [...document.querySelectorAll("[data-i18n]")];
      // A full translation covers every key in the markup and reaches the page body, not
      // only the site header and footer; then the document language follows. A partial one
      // (legal pages, leaderboard) keeps the document in the markup language and marks
      // just the translated elements. The markup language itself is always complete.
      const complete = requested === DEFAULT_LANGUAGE || (
        Object.keys(COPY[DEFAULT_LANGUAGE] || {}).every((key) => key in dictionary) &&
        elements.some((element) => !inSiteChrome(element))
      );
      if (complete) document.documentElement.lang = requested;
      elements.forEach((element) => {
        const value = dictionary[element.getAttribute("data-i18n")];
        setText(element, value);
        if (!complete && value != null) {
          element.setAttribute("lang", requested);
          element.setAttribute("data-i18n-lang", "");
        } else if (element.hasAttribute("data-i18n-lang")) {
          element.removeAttribute("lang");
          element.removeAttribute("data-i18n-lang");
        }
      });
      document.querySelectorAll("[data-i18n-attr]").forEach((element) => {
        setAttributes(element, dictionary);
      });
    }
    document.querySelectorAll("[data-language-option]").forEach((button) => {
      const active = button.getAttribute("data-language-option") === requested;
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });

    if (persist) saveLanguage(requested);
    window.setTimeout(() => document.documentElement.classList.remove("is-lang-changing"), 180);
  };

  document.querySelectorAll("[data-language-option]").forEach((button) => {
    button.addEventListener("click", () => applyLanguage(button.getAttribute("data-language-option")));
  });

  // Markup ships in the default language; only re-render for a saved override.
  // A saved language without a dictionary here still gets its button pressed.
  const savedLanguage = readSavedLanguage();
  if (savedLanguage && savedLanguage !== DEFAULT_LANGUAGE) {
    applyLanguage(savedLanguage, false);
  }
})();
