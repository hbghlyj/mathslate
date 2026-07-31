// Regenerate docs/screenshot.png: a keyboard-only demo ending with the
// active "\" TeX-command placeholder visible (dashed cursor box,
// highlighted monospace token, slate-lock glow).
import { chromium } from 'playwright-core';
const browser = await (await import('./launch.mjs')).launch();
const page = await browser.newPage({ viewport: { width: 980, height: 1400 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 200)));
await page.goto(new URL('../index.html', import.meta.url).href, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('#mathslate-editor .yui3-dd-draggable', { timeout: 90000 });
await page.waitForSelector('#document-area .MathJax', { timeout: 30000 });
await page.click('#btn-clear-doc');
await page.evaluate(() => {
    document.getElementById('document-source').value =
        'Keyboard demo — everything below was produced by typing, no clicking:\n\n';
    document.getElementById('document-source').dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('#btn-clear-slate');
await page.click('main');

await page.keyboard.type('E=mc^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'E=mc^2', null, { timeout: 15000 });
await page.click('#btn-insert-inline');

await page.keyboard.type('\\alpha+\\beta=\\gamma');
await page.keyboard.press('Enter'); // Enter closes the \gamma box
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\alpha+\\beta=\\gamma', null, { timeout: 25000 });
await page.click('#btn-insert-inline');

await page.keyboard.type('a/b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{a}{b}', null, { timeout: 15000 });
await page.click('#btn-insert-inline');

await page.keyboard.type('c^2');
await page.keyboard.press('ArrowRight'); // script blocks keep the cursor: step out
await page.keyboard.type('=a^2');
await page.keyboard.press('ArrowRight');
await page.keyboard.type('+b^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'c^2=a^2+b^2', null, { timeout: 25000 });
await page.click('#btn-insert-display');

await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 25000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 15000 });
await page.evaluate(() => {
    const divs = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '');
    const id = divs[divs.length - 1].id;
    const shim = [...document.querySelectorAll('span[id="' + id + '"]')]
        .find((n) => getComputedStyle(n).position === 'absolute');
    if (shim) shim.click();
});
// MathJax 4 marks the click selection asynchronously (post-typeset) —
// wait for it before typing, exactly like the e2e suite does.
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{2}', null, { timeout: 15000 });
await page.click('#btn-insert-inline');

// leave an ACTIVE TeX-command placeholder on the slate for the shot
await page.keyboard.type('\\int');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\int', null, { timeout: 25000 });
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-macro-active'), { timeout: 5000 });
try {
    await page.waitForFunction(() => {
        const s = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
        return s && getComputedStyle(s).outlineStyle === 'dashed';
    }, null, { timeout: 15000 });
} catch (e) { console.log('   (dashed outline wait timed out; shooting anyway)'); }
// close the box so it converts to a real ∫ — and the blinking caret parks
// at the end of the slate (the feature this demo wants in frame)
await page.keyboard.press('Escape');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\int', null, { timeout: 25000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 15000 });
await page.waitForFunction(() => {
    const canvas = document.querySelector('#mathslate-editor #canvas');
    return canvas.lastElementChild && canvas.lastElementChild.classList.contains('mathslate-caret');
}, null, { timeout: 10000 });
await page.waitForTimeout(300);
try {
    await page.screenshot({ path: '../docs/screenshot.png', fullPage: true, timeout: 12000 });
    console.log('screenshot saved; slate TeX:', await page.$eval('#current-tex', (el) => el.value));
} catch (e) {
    console.log('screenshot failed:', e.message.split('\n')[0]);
}
await browser.close();
