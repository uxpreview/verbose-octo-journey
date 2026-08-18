/* Regenerate the repository's pictures from the app's own code.
 *
 * The figures in the README and the Open Graph card are drawn by the same
 * renderer the app uses, over the same sample site, driven headlessly. So they
 * cannot drift from what the tool actually draws, and there is no hand-made
 * image in this repository that claims to be a screenshot.
 *
 *   npm run dev              # in one terminal
 *   npm i -D playwright && node scripts/make-figures.mjs
 *
 * Playwright is not a dependency of the app — only of this script — which is
 * why it is not in package.json's devDependencies by default. */

import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const ORIGIN = process.env.ORIGIN || 'http://localhost:8765';
const EXEC = process.env.CHROMIUM_PATH || undefined;
const root = new URL('..', import.meta.url).pathname;

const out = async (rel, buf) => {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, buf);
  console.log('wrote', rel);
};

const browser = await chromium.launch({ executablePath: EXEC });

/* --- the Open Graph card ------------------------------------------------ */
{
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  const svg = await page.evaluate(async () => {
    const [{ sampleSite }, { autoLayout }, { planFigureSvg }] = await Promise.all([
      import('/src/site.js'), import('/src/autolayout.js'), import('/src/render.js'),
    ]);
    const s = sampleSite();
    const plan = autoLayout(s);
    Object.assign(s, { heads: plan.heads, pipes: plan.pipes, drip: plan.drip });
    return planFigureSvg(s, { width: 900 }).outerHTML;
  });
  await page.setContent(`<!doctype html><html><head>
    <link rel="stylesheet" href="${ORIGIN}/styles.css">
    <style>
      /* The lot is portrait and the card is landscape, so the drawing is
         scaled to bleed off the right edge rather than shrunk to fit — at
         thumbnail size an arc you can see beats a whole plan you cannot. */
      html,body{margin:0;width:1200px;height:630px;overflow:hidden}
      body{background:var(--bg);font-family:var(--font-body);position:relative}
      .art{position:absolute;inset:0 -60px 0 480px;overflow:hidden;display:flex;align-items:center}
      .art svg{width:1000px;height:auto;margin-left:-90px}
      .fade{position:absolute;inset:0 auto 0 380px;width:220px;
            background:linear-gradient(90deg,var(--bg) 30%,transparent)}
      .copy{position:absolute;left:64px;top:50%;transform:translateY(-50%);width:430px}
      .eyebrow{margin:0 0 12px}
      h1{font-size:56px;line-height:1.0;letter-spacing:-0.035em;font-weight:800;color:var(--strong);margin:0}
      h1 em{font-style:italic;color:var(--accent-warm-ink)}
      p{font-size:19px;color:var(--body-2);margin:18px 0 0;max-width:26ch}
    </style></head><body>
    <div class="art">${svg}</div>
    <div class="fade"></div>
    <div class="copy">
      <p class="eyebrow label">EXP-039 · Irrigation Lab</p>
      <h1>A sprinkler plan for <em>your</em> yard.</h1>
      <p>Draw the lot, measure the spigot, get the heads, the zones and the trenches.</p>
    </div>
  </body></html>`, { waitUntil: 'networkidle' });
  await out('opengraph.png', await page.screenshot({ type: 'png' }));
  await page.close();
}

/* --- README figures ----------------------------------------------------- */
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle' });
  await page.click('#start-sample');
  await page.waitForTimeout(2000);
  await out('docs/figures/plan.png', await page.screenshot({ clip: { x: 0, y: 145, width: 1110, height: 755 } }));

  await page.selectOption('#sel-focus', '3');
  await page.waitForTimeout(900);
  await out('docs/figures/zone-focus.png', await page.screenshot({ clip: { x: 0, y: 145, width: 1110, height: 755 } }));
  await page.close();
}

await browser.close();
