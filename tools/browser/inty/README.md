# Inty

Inty is the ArmorIQ mascot. The recipe browser uses it on empty, loading, and error screens, on the home page, on the Policy tab, and in Try it, where it acts out each tool call as the offline run streams in.

These files are exported from the Inty playground (v2 material) by `tools/inty/export.mjs`. Don't edit them by hand. To pick up a design change, export again:

```bash
npm i --no-save playwright   # then npx playwright install chromium, unless Chrome is installed
node tools/inty/export.mjs
```

| File | What it is |
|---|---|
| `<state>.svg` | One state per file, coloured with the `--color-aq-*` tokens, so it follows the light and dark theme. |
| `inty.css` | The `ic2-*` animation rules and the colour utilities those files use. Respects reduced motion. |
| `../../../.github/assets/inty-guard.svg` | A self contained copy for the repo README. GitHub shows it as an image, so its colours and CSS are inlined. |

To add a state, add its playground key to `STATES` in `tools/inty/export.mjs` and to `INTY_STATES` in `tools/browser/app.js`, then export again.
