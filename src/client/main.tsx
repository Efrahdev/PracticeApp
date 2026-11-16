import { render, type ComponentChild, type ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import temmlCss from "temml/dist/Temml-STIX2.css";
import { setMathCss } from "./render";
import { Loading, Toaster } from "./ui";
import { Icon, type IconName } from "./builder/controls";
import { openBuilder } from "./store";
import { Home } from "./pages/Home";
import { Library } from "./pages/Library";
import { Question } from "./pages/Question";
import { Papers, PaperDetail } from "./pages/Papers";
import { PaperBuilder } from "./pages/PaperBuilder";
import { Practice } from "./pages/Practice";
import { Analytics } from "./pages/Analytics";
import { Settings } from "./pages/Settings";

setMathCss(temmlCss);

/** The importer (YAML, zip, validation) loads only when the Import screen opens. */
function LazyImport() {
  const [C, setC] = useState<ComponentType | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    import("./pages/Import").then((m) => setC(() => m.Import)).catch(() => setErr("Could not load the importer — reload the page."));
  }, []);
  if (err) return <p class="error-box">{err}</p>;
  return C ? <C /> : <Loading />;
}

function useHash() {
  const [h, setH] = useState(location.hash || "#/");
  useEffect(() => {
    const f = () => { setH(location.hash || "#/"); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", f);
    return () => window.removeEventListener("hashchange", f);
  }, []);
  return h;
}

function route(h: string): { tab: string; el: ComponentChild; bare?: boolean; wide?: boolean } {
  const parts = h.replace(/^#\/?/, "").split("/").filter(Boolean);
  const [a, b] = parts;
  switch (a) {
    case undefined: return { tab: "home", el: <Home /> };
    case "library": return { tab: "library", el: <Library />, wide: true };
    case "import": return { tab: "import", el: <LazyImport /> };
    case "q": return { tab: "library", el: <Question id={b} /> };
    case "papers":
      if (b === "new") return { tab: "papers", el: <PaperBuilder />, wide: true };
      return b ? { tab: "papers", el: <PaperDetail key={b} id={b} /> } : { tab: "papers", el: <Papers /> };
    case "practice": return { tab: "papers", el: <Practice key={b} paperId={b} />, bare: true };
    case "practice-q": return { tab: "library", el: <Practice key={b} questionId={b} />, bare: true };
    case "analytics": return { tab: "analytics", el: <Analytics /> };
    case "settings": return { tab: "settings", el: <Settings /> };
    default: return { tab: "", el: <div class="page"><div class="empty card"><p><b>Page not found.</b></p><a class="btn primary" href="#/">Go to the home page</a></div></div> };
  }
}

const TABS: { id: string; href: string; label: string; icon: IconName; phone?: boolean }[] = [
  { id: "home", href: "#/", label: "Home", icon: "home", phone: true },
  { id: "papers", href: "#/papers", label: "Papers", icon: "paper", phone: true },
  { id: "library", href: "#/library", label: "Library", icon: "bank", phone: true },
  { id: "analytics", href: "#/analytics", label: "Progress", icon: "chart", phone: true },
  { id: "import", href: "#/import", label: "Import", icon: "upload" },
  { id: "settings", href: "#/settings", label: "Settings", icon: "sliders", phone: true },
];

function App() {
  const h = useHash();
  const r = route(h);
  return (
    <>
      {!r.bare && (
        <header class="topbar">
          <div class="topbar-in">
            <a href="#/" class="brand" aria-label="Practice — home">
              <span class="brand-mark" aria-hidden="true">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7" /></svg>
              </span>
              Practice
            </a>
            <nav class="tabs" aria-label="Main">
              {TABS.map((t) => (
                <a href={t.href} class={`${r.tab === t.id ? "on" : ""}${t.phone ? "" : " hide-phone"}`} aria-current={r.tab === t.id ? "page" : undefined}>
                  <Icon name={t.icon} size={17} /><span class="tl">{t.label}</span>
                </a>
              ))}
            </nav>
            {h !== "#/papers/new" && <button type="button" class="btn primary small topbar-cta" onClick={() => openBuilder()}><Icon name="plus" size={14} /> New paper</button>}
          </div>
        </header>
      )}
      <main class={r.bare ? "bare" : r.wide ? "wide" : ""}>{r.el}</main>
      <Toaster />
    </>
  );
}

const root = document.getElementById("app")!;
root.textContent = "";
render(<App />, root);
