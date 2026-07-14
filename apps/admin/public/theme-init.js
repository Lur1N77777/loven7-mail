(() => {
  try {
    const normalizeTheme = (value) =>
      value === "dark" || value === "light" ? value : "";
    const localTheme = normalizeTheme(
      window.localStorage?.getItem("loven7.uiTheme"),
    );
    const sessionTheme = normalizeTheme(
      window.sessionStorage?.getItem("loven7.uiTheme"),
    );
    if ((localTheme || sessionTheme) === "dark") {
      document.documentElement.classList.add("theme-dark");
      document.documentElement.style.colorScheme = "dark";
    }
  } catch {
    // Storage can be unavailable in privacy-restricted contexts. The app
    // safely falls back to its light theme in that case.
  }
})();
