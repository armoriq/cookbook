// Exports the Inty mascot (v2 material) from the Inty playground into the recipe browser.
//
//   npm i --no-save playwright      (then npx playwright install chromium, unless Chrome is installed)
//   node tools/inty/export.mjs
//
// Writes:
//   tools/browser/inty/<state>.svg   one file per state, coloured with --color-aq-* tokens
//   tools/browser/inty/inty.css      the ic2-* rules and keyframes those files need
//   .github/assets/inty-guard.svg    a self contained copy for the README (tokens resolved, CSS inlined)
//
// Run it again whenever the design changes upstream. Files are overwritten.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const URL = process.env.INTY_URL || 'https://inty-agent-chat.vercel.app/playground/inty-costumes';
const OUT = path.join(ROOT, 'tools/browser/inty');
const README_SVG = path.join(ROOT, '.github/assets/inty-guard.svg');

// Only the states the browser uses. Keys are the playground's own state names.
const STATES = ['hello', 'search', 'read', 'think', 'act', 'yourMove', 'block', 'failed', 'offline', 'celebrate', 'wait', 'guard'];

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i --no-save playwright');
  process.exit(1);
}

// Falls back to an installed Chrome when Playwright's own browser is not downloaded.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'v2 material' }).click();
await page.waitForFunction(() => document.querySelector('button[aria-pressed="true"]')?.textContent.includes('v2'));

const result = await page.evaluate((wanted) => {
  // State key comes from the small trigger-size copy ("Inty, listen"); the large copy is the one we export.
  const found = {};
  const foreignClasses = new Set();
  const colorClasses = new Set();
  const COLOR = /^(fill|stroke)-aq-[a-z0-9-]+$/;
  for (const li of document.querySelectorAll('section li')) {
    const svgs = li.querySelectorAll('svg[role="img"]');
    const key = svgs[1]?.getAttribute('aria-label')?.replace(/^Inty,\s*/, '');
    if (!key || !wanted.includes(key) || !svgs[0]) continue;
    const svg = svgs[0].cloneNode(true);

    // Unique, readable ids: inty-<key>-<n>. app.js adds a per instance suffix at render time.
    const map = new Map();
    svg.querySelectorAll('[id]').forEach((el, i) => {
      const next = `inty-${key}-${i}`;
      map.set(el.id, next);
      el.id = next;
    });
    const fix = (v) => v.replace(/url\(#([^)]+)\)/g, (m, id) => (map.has(id) ? `url(#${map.get(id)})` : m))
      .replace(/^#(.+)$/, (m, id) => (map.has(id) ? `#${map.get(id)}` : m));
    for (const el of [svg, ...svg.querySelectorAll('*')]) {
      for (const a of [...el.attributes]) {
        if (a.name === 'id') continue;
        const v = fix(a.value);
        if (v !== a.value) el.setAttribute(a.name, v);
      }
      const cls = el.getAttribute('class');
      if (cls) {
        // Keep ic2-* classes and the Tailwind colour utilities (fill-aq-*, stroke-aq-*), which inty.css recreates.
        // Anything else (layout utilities on the root) is dropped and reported.
        const parts = cls.split(/\s+/).filter(Boolean);
        const keep = parts.filter((c) => c.startsWith('ic2-') || COLOR.test(c));
        parts.filter((c) => COLOR.test(c)).forEach((c) => colorClasses.add(c));
        parts.filter((c) => !keep.includes(c)).forEach((c) => foreignClasses.add(c));
        if (keep.length) el.setAttribute('class', keep.join(' '));
        else el.removeAttribute('class');
      }
    }
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.removeAttribute('role');
    svg.removeAttribute('aria-label');
    svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    svg.setAttribute('aria-hidden', 'true');
    found[key] = svg.outerHTML;
  }

  // Every rule the v2 mascot needs: ic2-* selectors, ic2-* keyframes, and media blocks that mention them.
  const css = [];
  const walk = (rules, out) => {
    for (const r of rules) {
      if (r.type === CSSRule.KEYFRAMES_RULE) {
        if (r.name.startsWith('ic2-')) out.push(r.cssText);
      } else if (r.type === CSSRule.MEDIA_RULE) {
        const inner = [];
        walk(r.cssRules, inner);
        if (inner.length) out.push(`@media ${r.conditionText} {\n${inner.join('\n')}\n}`);
      } else if (r.selectorText && r.selectorText.includes('ic2-')) {
        out.push(r.cssText);
      }
    }
  };
  for (const ss of document.styleSheets) {
    try { walk(ss.cssRules, css); } catch {}
  }

  // Recreate the Tailwind colour utilities. They sit in a layer, as in Tailwind, so the unlayered
  // ic2-* rules (which recolour parts per state) still win over them.
  const utils = [...colorClasses].sort().map((c) => {
    const [, prop, token] = c.match(/^(fill|stroke)-(aq-.+)$/);
    return `  .${c} { ${prop}: var(--color-${token}); }`;
  });
  css.unshift(`.ic2-root { overflow: visible; }`, `@layer inty-utilities {\n${utils.join('\n')}\n}`);

  // Light theme values of the tokens the CSS reads, for the self contained README copy.
  const tokens = {};
  const cs = getComputedStyle(document.documentElement);
  for (const v of new Set(css.join('\n').match(/--color-aq-[a-z0-9-]+/g) || [])) tokens[v] = cs.getPropertyValue(v).trim();

  return { found, css: css.join('\n'), rules: css, tokens, foreignClasses: [...foreignClasses] };
}, STATES);

await browser.close();

const missing = STATES.filter((s) => !result.found[s]);
if (missing.length) {
  console.error(`Missing states on the playground: ${missing.join(', ')}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });
for (const s of STATES) await writeFile(path.join(OUT, `${s}.svg`), result.found[s] + '\n');
const header = `/* Inty v2 material, exported from ${URL} by tools/inty/export.mjs. Do not edit by hand. */\n`;
// One rule per line keeps the generated file short; it is never edited by hand.
await writeFile(path.join(OUT, 'inty.css'), header + result.rules.map((r) => r.replace(/\s*\n\s*/g, ' ')).join('\n') + '\n');

// README copy: GitHub shows SVGs through <img>, so page CSS and tokens are not available. Inline both,
// keeping only the rules and keyframes the guard state uses, on one line.
const guardClasses = new Set([...result.found.guard.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
const usesGuard = (rule) => {
  const selector = rule.slice(0, rule.indexOf('{'));
  return [...selector.matchAll(/\.([\w-]+)/g)].some((m) => guardClasses.has(m[1]));
};
const filterRules = (rules) =>
  rules.flatMap((r) => {
    if (r.startsWith('@keyframes')) return [r];
    if (r.startsWith('@layer') || r.startsWith('@media')) {
      const head = r.slice(0, r.indexOf('{') + 1);
      const inner = r.slice(head.length, r.lastIndexOf('}')).split('\n').map((l) => l.trim()).filter((l) => l && usesGuard(l));
      return inner.length ? [`${head} ${inner.join(' ')} }`] : [];
    }
    return usesGuard(r) ? [r] : [];
  });
const kept = filterRules(result.rules);
const used = kept.filter((r) => !r.startsWith('@keyframes')).join(' ');
const readmeCss = kept
  .filter((r) => !r.startsWith('@keyframes') || used.includes(r.match(/^@keyframes ([\w-]+)/)[1]))
  .map((r) => r.replace(/\s*\n\s*/g, ' '))
  .join(' ');
const vars = Object.entries(result.tokens).map(([k, v]) => `${k}: ${v};`).join(' ');
const guard = result.found.guard
  .replace(/^<svg /, '<svg width="176" height="138" ')
  .replace(/(<svg[^>]*>)/, `$1<style>svg { ${vars} } ${readmeCss}</style>`);
await mkdir(path.dirname(README_SVG), { recursive: true });
await writeFile(README_SVG, guard + '\n');

console.log(`Exported ${STATES.length} states, ${result.css.length} bytes of CSS.`);
if (result.foreignClasses.length) console.log(`Non ic2 classes seen (check they are not needed): ${result.foreignClasses.join(' ')}`);
