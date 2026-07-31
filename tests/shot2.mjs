import { chromium } from 'playwright-core';
const browser = await (await import('./launch.mjs')).launch();
const page = await browser.newPage({ viewport: { width: 980, height: 1400 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#mathslate-editor .yui3-dd-draggable', { timeout: 90000 });
await page.waitForSelector('#document-area .MathJax', { timeout: 30000 });
// Demo the keyboard-driven input, scripts included
await page.click('#btn-clear-doc');
await page.evaluate(() => { document.getElementById('document-source').value =
    'Keyboard demo — everything below was produced by typing, no clicking:\n\n'; });
await page.click('#btn-clear-slate');
await page.click('main');
await page.keyboard.type('E=mc^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'E=m{c}^2', null, { timeout: 15000 });
await page.click('#btn-insert-inline');
await page.keyboard.type('x_1+x_2=0');
await page.waitForFunction(() => document.getElementById('current-tex').value.includes('}_{1}'), null, { timeout: 15000 });
await page.click('#btn-insert-inline');
await page.waitForTimeout(2500);
await page.screenshot({ path: '../docs/screenshot.png', fullPage: true });
console.log('screenshot saved; slate TeX:', await page.$eval('#current-tex', (el) => el.value));
await browser.close();
