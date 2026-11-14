// Reads numbers the way people and AI models write them:
// "12.5", "-3", "1,234.5", "5/8", "1 1/2", "½", "\frac{5}{8}", "62.5%", "3.2 cm",
// "x = 4", "£12.50", "1.2e3", "1.2 × 10^3", "±0.1".

const UNICODE_FRACTIONS: Record<string, number> = {
  "½": 1 / 2, "⅓": 1 / 3, "⅔": 2 / 3, "¼": 1 / 4, "¾": 3 / 4, "⅕": 1 / 5, "⅖": 2 / 5, "⅗": 3 / 5, "⅘": 4 / 5,
  "⅙": 1 / 6, "⅚": 5 / 6, "⅐": 1 / 7, "⅛": 1 / 8, "⅜": 3 / 8, "⅝": 5 / 8, "⅞": 7 / 8, "⅑": 1 / 9, "⅒": 1 / 10,
};

export interface ParsedNumber {
  value: number;
  unit: string | null;
  tolerance: number | null; // from "±0.1" / "+/- 0.1"
}

const NUM = String.raw`[-+−]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?`;

export function parseNumberish(input: unknown): ParsedNumber | null {
  if (typeof input === "number") return Number.isFinite(input) ? { value: input, unit: null, tolerance: null } : null;
  if (typeof input !== "string") return null;
  let s = input.trim();
  if (!s) return null;

  // strip maths delimiters and simple LaTeX
  s = s.replace(/^\$+|\$+$/g, "").replace(/^\\\(|\\\)$/g, "").trim();
  s = s.replace(/\\[dt]?frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, "$1/$2");
  s = s.replace(/\\(?:,|;|:|!|quad|qquad)/g, " ").replace(/\\text\{([^{}]*)\}/g, "$1").replace(/\\mathrm\{([^{}]*)\}/g, "$1");
  s = s.replace(/\\times|×/g, "×").replace(/\\cdot|·/g, "×").replace(/\\pm/g, "±").replace(/\\%/g, "%");
  s = s.replace(/[{}]/g, "").replace(/−/g, "-").trim();

  // "x = 4", "answer: 4"
  s = s.replace(/^[A-Za-z][A-Za-z\s]{0,20}[=:]\s*/, "");

  let tolerance: number | null = null;
  const pm = s.match(/(?:±|\+\/-|\+-)\s*([0-9.]+)\s*(%?)/);
  if (pm) {
    tolerance = Number(pm[1]);
    s = s.replace(pm[0], "").trim();
  }

  // leading currency symbol becomes the unit
  let unit: string | null = null;
  const cur = s.match(/^([£$€¥₹])\s*/);
  if (cur) {
    unit = cur[1];
    s = s.slice(cur[0].length);
  }

  // scientific "1.2 × 10^3" / "1.2 x 10^-3"
  const sci = s.match(new RegExp(`^(${NUM})\\s*[×x*]\\s*10\\s*\\^\\s*\\(?([-+]?\\d+)\\)?(.*)$`));
  if (sci) {
    const v = Number(sci[1].replace(/,/g, "")) * Math.pow(10, Number(sci[2]));
    return finish(v, sci[3], unit, tolerance);
  }

  // mixed number "1 1/2" or "1½"
  const mixed = s.match(/^([-+]?\d+)\s+(\d+)\s*\/\s*(\d+)(.*)$/);
  if (mixed && Number(mixed[3]) !== 0) {
    const whole = Number(mixed[1]);
    const frac = Number(mixed[2]) / Number(mixed[3]);
    return finish(whole < 0 || mixed[1].startsWith("-") ? whole - frac : whole + frac, mixed[4], unit, tolerance);
  }
  const uni = s.match(/^([-+]?\d*)\s*([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅐⅛⅜⅝⅞⅑⅒])(.*)$/);
  if (uni) {
    const whole = uni[1] === "" || uni[1] === "+" ? 0 : uni[1] === "-" ? -0 : Number(uni[1]);
    const neg = uni[1].startsWith("-");
    const v = Math.abs(whole) + UNICODE_FRACTIONS[uni[2]];
    return finish(neg ? -v : v, uni[3], unit, tolerance);
  }

  // simple fraction "5/8", "-3/4"
  const frac = s.match(/^([-+]?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)(.*)$/);
  if (frac && Number(frac[2]) !== 0) return finish(Number(frac[1]) / Number(frac[2]), frac[3], unit, tolerance);

  // plain number with optional unit after it
  const plain = s.match(new RegExp(`^(${NUM})(.*)$`));
  if (plain && /\d/.test(plain[1])) return finish(Number(plain[1].replace(/,/g, "")), plain[2], unit, tolerance);
  return null;
}

function finish(value: number, rest: string, unit: string | null, tolerance: number | null): ParsedNumber | null {
  if (!Number.isFinite(value)) return null;
  const r = rest.trim();
  if (r) {
    // anything after the number must look like a unit, not more words/numbers
    if (/\d/.test(r.replace(/\^-?\d+|[²³]/g, "")) || r.length > 16) return null;
    unit = unit ? `${unit} ${r}` : r;
  }
  return { value, unit, tolerance };
}

export function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e10) / 1e10);
}
