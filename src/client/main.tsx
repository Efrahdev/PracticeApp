import { render, type ComponentChild, type ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import temmlCss from "temml/dist/Temml-Local.css";
import { setMathCss } from "./render";
import { Toaster } from "./ui";
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
  return C ? <C /> : <p class="muted">Loading…</p>;
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
    case undefined: return { tab: "library", el: <Library /> };
    case "import": return { tab: "import", el: <LazyImport /> };
    case "q": return { tab: "library", el: <Question id={b} /> };
    case "papers":
      if (b === "new") return { tab: "papers", el: <PaperBuilder />, wide: true };
      return b ? { tab: "papers", el: <PaperDetail id={b} /> } : { tab: "papers", el: <Papers /> };
    case "practice": return { tab: "papers", el: <Practice key={b} paperId={b} />, bare: true };
    case "practice-q": return { tab: "library", el: <Practice key={b} questionId={b} />, bare: true };
    case "analytics": return { tab: "analytics", el: <Analytics /> };
    case "settings": return { tab: "settings", el: <Settings /> };
    default: return { tab: "", el: <div class="page"><p>Page not found. <a href="#/">Go to library</a></p></div> };
  }
}

const TABS = [
  { id: "library", href: "#/", label: "Library", icon: "▤" },
  { id: "papers", href: "#/papers", label: "Papers", icon: "✎" },
  { id: "analytics", href: "#/analytics", label: "Progress", icon: "↗" },
  { id: "import", href: "#/import", label: "Import", icon: "⇪" },
  { id: "settings", href: "#/settings", label: "Settings", icon: "⚙" },
];

function App() {
  const h = useHash();
  const r = route(h);
  return (
    <>
      {!r.bare && (
        <header class="topbar">
          <a href="#/" class="brand">Practice</a>
          <nav class="tabs" aria-label="Main">
            {TABS.map((t) => (
              <a href={t.href} class={r.tab === t.id ? "on" : ""} aria-current={r.tab === t.id ? "page" : undefined}>
                <span class="ti" aria-hidden="true">{t.icon}</span><span class="tl">{t.label}</span>
              </a>
            ))}
          </nav>
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
