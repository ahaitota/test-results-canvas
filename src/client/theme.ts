// Theme: mirror the Copilot app's light/dark tone onto <html data-theme>.
// Colours themselves live in CSS vars (see view.ts), so a tone flip needs no re-render.

const darkMedia = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

// Brightness of a resolved CSS colour; "light" | "dark", or null if unparseable/transparent.
function toneFromColor(css: string | null): "light" | "dark" | null {
  if (!css) return null;
  css = ("" + css).trim();
  let r: number, g: number, b: number, a = 1;
  if (css.charAt(0) === "#") {
    let h = css.slice(1);
    if (h.length === 3) h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
    if (h.length < 6) return null;
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const o = css.indexOf("("), e = css.indexOf(")");
    if (o < 0 || e < 0) return null;
    const p = css.slice(o + 1, e).split(",");
    r = parseFloat(p[0]);
    g = parseFloat(p[1]);
    b = parseFloat(p[2]);
    if (p.length > 3) a = parseFloat(p[3]);
  }
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  if (!isNaN(a) && a === 0) return null;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5 ? "dark" : "light";
}

// Detect the app's tone from the theme contract it mirrors onto our document.
function appTone(): "light" | "dark" | null {
  const el = document.documentElement, bd = document.body;
  const attr = (n: string) => ("" + (el.getAttribute(n) || (bd && bd.getAttribute(n)) || "")).toLowerCase();
  const mode = attr("data-color-mode");
  if (mode === "light" || mode === "dark") return mode;
  const tone = attr("data-theme-tone");
  if (tone === "light" || tone === "dark") return tone;
  const vis = attr("data-visual-mode");
  if (vis === "light" || vis === "dark") return vis;
  if (!bd) return null;
  const probe = document.createElement("span");
  probe.style.cssText = "position:absolute;left:-9999px;top:-9999px;background-color:var(--background-color-default)";
  bd.appendChild(probe);
  const bg = getComputedStyle(probe).backgroundColor;
  bd.removeChild(probe);
  return toneFromColor(bg);
}

function applyAppTheme(): void {
  const osTone = darkMedia ? (darkMedia.matches ? "dark" : "light") : "dark";
  document.documentElement.setAttribute("data-theme", appTone() || osTone);
}

export function initTheme(): void {
  applyAppTheme();
  // data-theme is deliberately absent from the filter so our own writes don't re-fire.
  if (window.MutationObserver) {
    const obs = new MutationObserver(applyAppTheme);
    const opt: MutationObserverInit = {
      attributes: true,
      attributeFilter: ["data-color-mode", "data-theme-tone", "data-theme-source", "data-visual-mode", "data-dark-theme", "data-light-theme", "class", "style"],
    };
    obs.observe(document.documentElement, opt);
    if (document.body) obs.observe(document.body, opt);
  }
  if (darkMedia) {
    if (darkMedia.addEventListener) darkMedia.addEventListener("change", applyAppTheme);
    else if ((darkMedia as unknown as { addListener?: (cb: () => void) => void }).addListener) {
      (darkMedia as unknown as { addListener: (cb: () => void) => void }).addListener(applyAppTheme);
    }
  }
}
