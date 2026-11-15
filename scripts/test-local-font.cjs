// Item #258: a deployment must never depend on Google's servers being well-behaved.
//
// The root layout used next/font/google, which downloads the font from Google WHILE BUILDING. On 2026-10-17 one
// malformed answer from Google failed a preview deployment ("An error occurred in `next/font` ... TypeError: Cannot
// read properties of null (reading '1')" - the loader read a font URL with no file extension) while the production
// build of the same commit passed. The font now lives in the repository and is loaded with next/font/local.
//
// Run:  node scripts/test-local-font.cjs
const fs = require("fs");
const path = require("path");
const root = path.join(__dirname, "..");
let pass = 0, fail = 0;
const t = (name, ok) => { ok ? pass++ : (fail++, console.log("FAIL", name)); };
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

// every source file: nothing may pull a font (or anything else) from Google while building
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (/\.(ts|tsx|js|jsx|mjs|cjs|css)$/.test(e.name)) out.push(p);
  }
  return out;
}
const sources = walk(path.join(root, "src"));
// Code only: the layout's own comment explains what went wrong and has to be able to name the thing it replaced.
const code = (f) => fs.readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const googleFont = sources.filter((f) => /next\/font\/google/.test(code(f)));
t(`no file imports next/font/google (a build-time download from Google)${googleFont.length ? ": " + googleFont.map((f) => path.relative(root, f)).join(", ") : ""}`, googleFont.length === 0);
const googleCss = sources.filter((f) => /fonts\.(googleapis|gstatic)\.com/.test(code(f)));
t(`no file refers to fonts.googleapis.com / fonts.gstatic.com${googleCss.length ? ": " + googleCss.map((f) => path.relative(root, f)).join(", ") : ""}`, googleCss.length === 0);

// the layout loads the font from the repository
const layout = read("src/app/layout.tsx");
t("layout imports next/font/local", /import localFont from "next\/font\/local"/.test(layout));
const m = layout.match(/localFont\(\{[\s\S]*?src:\s*"([^"]+)"[\s\S]*?\}\);/);
t("layout loads the font with localFont({ src })", !!m);
const fontRel = m ? m[1] : "";
const fontPath = path.join(root, "src/app", fontRel);
t("the font file it points at exists in the repository", !!m && fs.existsSync(fontPath));
if (m && fs.existsSync(fontPath)) {
  const buf = fs.readFileSync(fontPath);
  t("it is a real woff2 file (wOF2 header)", buf.subarray(0, 4).toString("latin1") === "wOF2");
  t("it is not an empty placeholder (over 20 KB)", buf.length > 20 * 1024);
  t("it is not the whole multi-script family (under 200 KB: latin subset only)", buf.length < 200 * 1024);
}
t("the layout keeps the --font-inter variable the stylesheet reads", /variable:\s*"--font-inter"/.test(layout) && /var\(--font-inter\)/.test(read("src/app/globals.css")));
t("the layout still applies the font's variable class to <html>", /className=\{inter\.variable\}/.test(layout));
t("it is a variable font covering every weight the app uses (100-900)", /weight:\s*"100 900"/.test(layout));
t("swap, so text shows at once while the font loads", /display:\s*"swap"/.test(layout));

// the licence travels with the font (SIL OFL requires it when the font is redistributed)
const lic = path.join(root, "src/app/fonts/OFL.txt");
t("the SIL Open Font License text sits next to the font", fs.existsSync(lic) && /SIL OPEN FONT LICENSE Version 1\.1/.test(fs.readFileSync(lic, "utf8")));

console.log(`test-local-font: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
