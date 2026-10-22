import { chromium } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exportArg = process.argv.find((arg) => arg.startsWith('--output-dir='));
const exportDir = exportArg ? resolve(exportArg.slice('--output-dir='.length)) : null;
const outputDir = exportDir ?? join(repoRoot, 'icons');
const sizes = exportDir ? [16, 32, 48, 64, 96, 128] : [16, 32, 48, 128];
const svg = await readFile(join(repoRoot, 'welcome/assets/study-buddy-hat-tile.svg'), 'utf8');
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await mkdir(outputDir, { recursive: true });
  for (const size of sizes) {
    const encodedSvg = Buffer.from(svg).toString('base64');
    await page.setContent(`<img id="icon" width="${size}" height="${size}" src="data:image/svg+xml;base64,${encodedSvg}">`);
    const image = page.locator('#icon');
    await image.evaluate((element) => element.decode());
    const png = await image.screenshot({ omitBackground: true });
    await writeFile(join(outputDir, `icon${size}.png`), png);
    if (!exportDir && size === 32) {
      const welcomeIcon = join(repoRoot, 'welcome/icon32.png');
      await mkdir(dirname(welcomeIcon), { recursive: true });
      await writeFile(welcomeIcon, png);
    }
  }
} finally {
  await browser.close();
}
