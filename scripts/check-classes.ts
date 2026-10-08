// Copied with the UI kit from Ritu Desk (desk origin/main @ 8bee594); owned by this repo.
//
// THE PALETTE IS THE BRAND. tailwind.config.ts overrides Tailwind's colours, so
// a stray `text-rose-600` or `bg-gray-100` produces NO css — silently. This
// turns that silence into a failing gate: every colour and font-size utility
// must name a token the config actually defines. Reads the real config object, never a regex over it.
//
//   npm run check:classes   (tsx)
import fs from "node:fs";
import path from "node:path";
import config from "../tailwind.config";

const ROOT = path.join(__dirname, "..");
const theme = (config.theme ?? {}) as { colors?: Record<string, unknown>; extend?: { fontSize?: Record<string, unknown> } };

const colours = new Set<string>();
(function walk(obj: Record<string, unknown>, prefix: string[]) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === "object") walk(v as Record<string, unknown>, [...prefix, k]);
    else colours.add((k === "DEFAULT" ? prefix : [...prefix, k]).join("-"));
  }
})(theme.colors ?? {}, []);
const sizes = new Set(Object.keys(theme.extend?.fontSize ?? {}));
const TW_SIZES = new Set(["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl", "8xl", "9xl"]);
const TEXT_NON_COLOUR = new Set(["left", "right", "center", "justify", "start", "end", "balance", "pretty", "wrap", "nowrap", "ellipsis", "clip", "inherit"]);
const BG_NON_COLOUR = /^(gradient|none|cover|contain|fixed|local|scroll|repeat|no-repeat|auto|clip|origin|bottom|top|left|right|center|opacity)/;

const files: string[] = [];
for (const dir of ["app", "components"]) {
  (function walk(d: string) {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts|css)$/.test(f)) files.push(p);
    }
  })(path.join(ROOT, dir));
}

const DEFAULT_COLOURS = /\b(?:bg|text|border|ring|from|via|to|fill|stroke|divide|outline|decoration|placeholder|shadow|accent|caret)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/\d+)?\b/g;
const isColour = (k: string) => colours.has(k) || colours.has(k.replace(/\/\d+$/, ""));

let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, "utf8");
  const rel = path.relative(ROOT, f);
  for (const m of src.matchAll(DEFAULT_COLOURS)) {
    bad++;
    console.log(`  ✗ ${rel}: default palette "${m[0]}" — not a brand token, renders nothing`);
  }
  if (f.endsWith(".css")) continue; // CSS property names (text-transform…) are not classes
  for (const m of src.matchAll(/(?<![\w-])text-([a-z][a-z0-9-]*)(?:\/\d+)?(?![\w-])/g)) {
    const k = m[1];
    if (sizes.has(k) || TW_SIZES.has(k) || TEXT_NON_COLOUR.has(k) || isColour(k)) continue;
    bad++;
    console.log(`  ✗ ${rel}: "text-${k}" is neither a font size nor a colour token`);
  }
  for (const m of src.matchAll(/(?<![\w-])bg-([a-z][a-z0-9-]*)(?:\/\d+)?(?![\w-])/g)) {
    const k = m[1];
    if (isColour(k) || BG_NON_COLOUR.test(k)) continue;
    bad++;
    console.log(`  ✗ ${rel}: "bg-${k}" is not a colour token`);
  }
  for (const m of src.matchAll(/(?<![\w-])border-([a-z][a-z0-9-]*)(?:\/\d+)?(?![\w-])/g)) {
    const k = m[1];
    if (isColour(k) || /^(solid|dashed|dotted|double|none|hidden|collapse|separate|spacing|[trblxyse]|[trblxyse]-\d|\d)/.test(k)) continue;
    bad++;
    console.log(`  ✗ ${rel}: "border-${k}" is not a colour token`);
  }
}
if (bad) {
  console.error(`\n  ${bad} stray class(es). The palette is overridden: these render NOTHING.\n`);
  process.exit(1);
}
console.log(`  ✓ ${files.length} files: every colour and size class is a brand token (${colours.size} colours, ${sizes.size} sizes)`);
