#!/usr/bin/env node
/**
 * One-off script to capture screenshots of https://info.5ls.us
 * Run: npx playwright test scripts/screenshot-info-page.mjs --project=chromium
 * Or: node --experimental-strip-types scripts/screenshot-info-page.mjs
 *
 * Simpler: use playwright directly
 */
import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, '../screenshots-info-5ls');

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    colorScheme: 'dark',
    locale: 'en-US',
  });

  const page = await context.newPage();
  const consoleLogs = [];
  const consoleErrors = [];
  page.on('console', (msg) => {
    const text = msg.text();
    const type = msg.type();
    if (type === 'error') consoleErrors.push(text);
    else consoleLogs.push(`[${type}] ${text}`);
  });

  try {
    await page.goto('https://info.5ls.us', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000); // allow panels to load

    const fs = await import('fs');
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

    // Full page screenshot
    await page.screenshot({
      path: path.join(OUT_DIR, 'full-page.png'),
      fullPage: true,
    });
    console.log('Saved: screenshots-info-5ls/full-page.png');

    // Viewport screenshot
    await page.screenshot({
      path: path.join(OUT_DIR, 'viewport.png'),
    });
    console.log('Saved: screenshots-info-5ls/viewport.png');

    // Scroll down and capture more if page is long
    const bodyHeight = await page.evaluate(() => document.body.scrollHeight);
    const viewportHeight = 900;
    if (bodyHeight > viewportHeight) {
      await page.evaluate(() => window.scrollTo(0, viewportHeight));
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(OUT_DIR, 'scrolled-mid.png'),
      });
      console.log('Saved: screenshots-info-5ls/scrolled-mid.png');
    }

    // Write console output
    const report = [
      '=== CONSOLE ERRORS ===',
      ...consoleErrors,
      '',
      '=== CONSOLE LOGS (sample) ===',
      ...consoleLogs.slice(-30),
    ].join('\n');
    fs.writeFileSync(path.join(OUT_DIR, 'console-report.txt'), report);
    console.log('Saved: screenshots-info-5ls/console-report.txt');
    if (consoleErrors.length) {
      console.log('\nConsole errors:', consoleErrors);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
