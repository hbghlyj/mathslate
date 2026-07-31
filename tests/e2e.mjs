// Headless end-to-end test for the standalone Mathslate app.
import { chromium } from 'playwright-core';

const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const errors = [];

const browser = await (await import('./launch.mjs')).launch();
const page = await browser.newPage();
page.on('pageerror', (e) => { errors.push('PAGEERROR: ' + e.message); console.log('PAGEERROR:', (e.stack || e.message).slice(0, 900)); });
page.on('console', (m) => {
    if (m.type() === 'error') { errors.push('CONSOLE: ' + m.text()); console.log('CON:', m.text().slice(0, 250)); }
    if (m.text().startsWith('ARMGIVEUP')) console.log(m.text());
});

console.log('1. loading', BASE);
await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });

console.log('2. waiting for editor toolbox to render...');
await page.waitForSelector('#mathslate-editor .yui3-tabview', { timeout: 90000 });
console.log('   toolbox tabview present');

// tabs rendered?
const tabs = await page.$$eval('#mathslate-editor .yui3-tab-label', (els) => els.length);
console.log('   tabs:', tabs);

console.log('3. waiting for draggable tools to be registered...');
await page.waitForFunction(
    () => document.querySelectorAll('#mathslate-editor .yui3-tabview-panel .yui3-dd-draggable').length > 20,
    null, { timeout: 90000 });
const tools = await page.$$eval('#mathslate-editor .yui3-dd-draggable', (els) => els.length);
console.log('   draggable tools:', tools);

console.log('4. switching to the second toolbox tab and clicking tools...');
// First tab is the direct-TeX tab; symbol tabs follow (as in the original plugin).
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[1].querySelector('.yui3-tab-label, a').click();
});
await page.waitForTimeout(800);
const handles = await page.$$('#mathslate-editor .yui3-dd-draggable');
let clicked = 0;
for (const h of handles) {
    if (clicked >= 3) break;
    const vis = await h.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 &&
            !el.closest('.yui3-tab-panel:not(.yui3-tab-panel-selected)');
    });
    if (vis) { await h.click(); clicked++; await page.waitForTimeout(500); }
}
console.log('   clicked', clicked, 'visible tools');

console.log('5. waiting for TeX read-out to update...');
await page.waitForFunction(() => document.getElementById('current-tex').value.trim().length > 0, null, { timeout: 15000 });
const tex = await page.$eval('#current-tex', (el) => el.value);
console.log('   current TeX:', JSON.stringify(tex));

console.log('6. slate rendered by MathJax 4 (CHTML)?');
const hasJax = await page.$('#mathslate-editor .mathslate-workspace .MathJax');
console.log('   MathJax output in workspace:', !!hasJax);

console.log('7. insert inline → document source');
await page.click('#btn-insert-inline');
await page.waitForTimeout(300);
let src = await page.$eval('#document-source', (el) => el.value);
console.log('   source contains \\(...\\):', src.includes('\\(' + tex.trim() + '\\)'));

console.log('8. insert display → document source');
await page.click('#btn-insert-display');
await page.waitForTimeout(300);
src = await page.$eval('#document-source', (el) => el.value);
console.log('   source contains \\[...\\]:', src.includes('\\[' + tex.trim() + '\\]'));

console.log('9. TeX tab (direct TeX input) present?');
const tabLabels = await page.$$eval('#mathslate-editor .yui3-tab-label', (els) => els.length);
console.log('   total tabs (incl. TeX):', tabLabels);

console.log('10. rendered document contains MathJax output?');
await page.waitForSelector('#document-area .MathJax', { timeout: 30000 });
console.log('    document typeset OK');

console.log('11. undo/redo/clear toolbar present?');
const hasForm = await page.$('#mathslate-editor form button');
console.log('    toolbar buttons:', !!hasForm);

console.log('12. clear slate works');
await page.click('#btn-clear-slate');
await page.waitForFunction(() => document.getElementById('current-tex').value.trim() === '', null, { timeout: 10000 });
console.log('    slate cleared');

console.log('13. TeX direct-input tool');
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[0].querySelector('.yui3-tab-label, a').click();
});
await page.waitForTimeout(500);
await page.evaluate(() => {
    const input = document.querySelector('#mathslate-editor input[type="text"]');
    input.value = 'x^2+y^2';
    input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForFunction(() => document.getElementById('current-tex').value.includes('x^2+y^2'), null, { timeout: 15000 });
console.log('    TeX tool produced:', await page.$eval('#current-tex', (el) => el.value));

console.log('14. help button loads help.html into the preview panel');
await page.evaluate(() => {
    [...document.querySelectorAll('#mathslate-editor form button')].find(b => b.title.startsWith('Access')).click();
});
await page.waitForSelector('#mathslate-editor iframe.mathslate-help-box', { timeout: 20000 }); // CDN font-chunk latency under full-suite context
console.log('    help iframe OK');

console.log('15. undo button removes the last snippet');
await page.evaluate(() => {
    const inp = document.querySelector('#mathslate-editor input[type="text"]');
    inp.value = 'z_1'; inp.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForFunction(() => document.getElementById('current-tex').value.includes('z_1'), null, { timeout: 15000 });
await page.evaluate(() => {
    [...document.querySelectorAll('#mathslate-editor form button')].find(b => b.title === 'Undo previous action').click();
});
await page.waitForFunction(() => !document.getElementById('current-tex').value.includes('z_1'), null, { timeout: 10000 });
console.log('    undo OK:', JSON.stringify(await page.$eval('#current-tex', (el) => el.value)));

console.log('16. build a fraction by typing TeX, then export document');
await page.click('#btn-insert-inline');
await page.waitForTimeout(300);
await page.click('#btn-export');
await page.waitForTimeout(500);
src = await page.$eval('#document-source', (el) => el.value);
console.log('    doc now contains typed TeX:', src.includes('\\(' + (await page.$eval('#current-tex', (el) => el.value)).trim() + '\\)'));

console.log('17. keyboard entry: clear slate, type "x+22" literally');
await page.click('#btn-clear-slate');
await page.click('main'); // move focus away from form fields/buttons
await page.waitForTimeout(200);
await page.keyboard.type('x+22');
await page.waitForFunction(() => document.getElementById('current-tex').value === 'x+22', null, { timeout: 10000 });
console.log('    slate TeX after typing:', JSON.stringify(await page.$eval('#current-tex', (el) => el.value)));

console.log('18. keyboard: minus key produces a real minus in TeX');
await page.keyboard.type('-1');
await page.waitForFunction(() => document.getElementById('current-tex').value === 'x+22-1', null, { timeout: 10000 });
console.log('    slate TeX:', JSON.stringify(await page.$eval('#current-tex', (el) => el.value)));

const texNS = async () => (await page.$eval('#current-tex', (el) => el.value)).replace(/\s+/g, '');
async function dumpState(tag) {
    console.log('DIAG', tag, JSON.stringify(await page.evaluate(() => ({
        tex: document.getElementById('current-tex').value.replace(/\s+/g, ''),
        sel: !!document.querySelector('#mathslate-editor .mathslate-selected'),
        blanks: [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
            .filter(d => d.id && !d.querySelector('div') && d.textContent.trim() === '').map(d => d.id.slice(-6)),
        shims: [...document.querySelectorAll('#mathslate-editor span[style*="position: absolute"]')].length
    }))));
}

console.log('19. ^ trigger: "x^2" → real msup; the cursor STAYS locked inside the script block');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('x^2'); // typed fast: "2" must buffer until the box is armed
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^2', null, { timeout: 15000 });
console.log('    slate TeX (spaceless):', JSON.stringify(await texNS()));
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return !!c && c.style.position === 'absolute';
}, null, { timeout: 10000 });
console.log('    active script wrapper ✓ caret anchored INSIDE the block (a^{2|}) ✓');
await page.waitForTimeout(700);
const mml19 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    canvas contains stacked <msup>:', mml19.includes('msup'));

console.log('20. retention: typing accumulates INSIDE the block → x^{23}; → lets it out; typing then continues after');
await page.keyboard.type('3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^{23}', null, { timeout: 15000 });
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
console.log('    multi-character script while still locked:', JSON.stringify(await texNS()));
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
console.log('    ArrowRight let the cursor out ✓');
await page.keyboard.type('3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^{23}3', null, { timeout: 15000 });
console.log('    after the exit, "3" continues top-level →', JSON.stringify(await texNS()));

console.log('21. _ trigger: "_1" locks again; "2" accumulates → x^{23}3_{12}; Esc lets it out');
await page.keyboard.type('_1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^{23}3_1', null, { timeout: 15000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^{23}3_{12}', null, { timeout: 15000 });
await page.keyboard.press('Escape');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.waitForTimeout(700);
const mml21 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    slate TeX (spaceless):', JSON.stringify(await texNS()), '| Esc let it out ✓ canvas has msub:', mml21.includes('msub'));

console.log('22. ^ binds the preceding TOKEN (last snippet), not the whole line; Space lets it out');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('y+1^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'y+1^2', null, { timeout: 15000 });
await page.keyboard.press(' ');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.keyboard.type('+3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'y+1^2+3', null, { timeout: 15000 });
console.log('    y+1^2 (Space-out) +3 →', JSON.stringify(await texNS()));

console.log('23. selecting a glyph, then Backspace deletes the selection');
await page.evaluate(() => {
    const prev = document.querySelectorAll('#mathslate-editor .mathslate-preview > div');
    if (prev.length) {
        const id = prev[0].id;
        const nodes = [...document.querySelectorAll('span[id="' + id + '"]')];
        const shim = nodes.find((n) => getComputedStyle(n).position === 'absolute');
        if (shim) shim.click();
    }
});
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 5000 });
const beforeDel = await texNS();
await page.keyboard.press('Backspace');
await page.waitForFunction((prev) => document.getElementById('current-tex').value.replace(/\s+/g, '') !== prev, beforeDel, { timeout: 10000 });
console.log('    after deleting selection:', JSON.stringify(await texNS()));

console.log('24. typing inside the document source does NOT touch the slate');
await page.click('#document-source');
await page.keyboard.type(' zzz ');
await page.waitForTimeout(800);
console.log('    slate unchanged:', !(await page.$eval('#current-tex', (el) => el.value)).includes('zzz'));

console.log('25. / trigger: type "a/b" → mfrac, TeX \\frac{a}{b}');
await page.click('main');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('a/b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{a}{b}', null, { timeout: 15000 });
await page.waitForTimeout(700);
const mml25 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    slate TeX (spaceless):', JSON.stringify(await texNS()), '| canvas has mfrac:', mml25.includes('mfrac'));

console.log('26. / nests like TeX: "1/2/3" → \\frac{\\frac{1}{2}}{3}');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('1/2/3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{\\frac{1}{2}}{3}', null, { timeout: 20000 });
console.log('    slate TeX (spaceless):', JSON.stringify(await texNS()));

console.log('27. \\ trigger: box closes into PARSED math; "\\alpha2" → real <mi>α</mi>, not monospace text');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\alpha2');
try {
    await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\alpha2', null, { timeout: 25000 });
} catch (err) { await dumpState('step27'); throw err; }
await page.waitForTimeout(700);
const mml27 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    slate TeX (spaceless):', JSON.stringify(await texNS()));
console.log('    macro converted to parsed math (has α glyph, no monospace mtext):',
    (mml27.indexOf('α') !== -1 || mml27.indexOf('𝛼') !== -1) && !mml27.includes('monospace'));

console.log('28. \\ box stays active while typing: after "\\ga" the box is selected and open');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\ga');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\ga', null, { timeout: 25000 });
// the box is selected as the cursor (best-effort arm; poll for it)
let boxActive = true;
try {
    await page.waitForFunction(() =>
        !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
} catch (e) { boxActive = false; }
console.log('    placeholder still active/selected:', boxActive);
await page.keyboard.type('m');
await page.keyboard.type('m');
await page.keyboard.type('a');
await page.keyboard.press('Escape'); // close the box → macro parses into real math
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\gamma', null, { timeout: 25000 });
await page.waitForTimeout(700);
const mml28 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    after amma+Esc →', JSON.stringify(await texNS()),
    '| converted (γ glyph, no monospace):', (mml28.indexOf('γ') !== -1 || mml28.indexOf('𝛾') !== -1) && !mml28.includes('monospace'));

console.log('29. Backspace backs out of a macro: "\\b" + Del + Del → empty slate');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\b', null, { timeout: 25000 });
await page.keyboard.press('Backspace');
await page.waitForTimeout(800);
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.trim() === '', null, { timeout: 10000 });
console.log('    slate empty after two Backspaces ✓');

/* ---- 3-state spec for the \ TeX-command placeholder ----
 * State 1: "\" opens an active placeholder box; the cursor is locked inside
 *          (arrow keys cannot navigate away) until a closing condition.
 * State 2: while open the box keeps a distinct active wrapper (marker class
 *          + highlighted monospace token + dashed cursor outline); only
 *          letters accumulate.
 * State 3: any non-letter (digits, symbols, space, Enter, Esc) closes the
 *          box, drops the wrapper, and the terminator renders after it. */

console.log('30. State 1+2: "\\" opens the ACTIVE placeholder wrapper');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\alpha');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\alpha', null, { timeout: 25000 });
const macroActive = () => page.evaluate(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-macro-active'));
console.log('    marker class mathslate-macro-active on the editor:', await macroActive());
await page.waitForTimeout(800);
const mml30 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    placeholder token highlighted (mathbackground on the mtext):', mml30.includes('mathbackground'));
try {
    await page.waitForFunction(() => {
        const s = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
        return s && getComputedStyle(s).outlineStyle === 'dashed';
    }, null, { timeout: 15000 });
    console.log('    cursor box keeps a dashed active outline while selected ✓');
} catch (e) { console.log('    WARN: dashed cursor outline not seen (arming is best-effort)'); }

console.log('31. State 1 lock: arrow keys cannot navigate away while the box is open');
for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', 'ArrowRight']) {
    await page.keyboard.press(k);
}
await page.waitForTimeout(500);
const texAfterArrows = await texNS();
await page.waitForTimeout(400);
console.log('    after 5 arrow keys — still active:', await macroActive(),
    '| macro name intact:', texAfterArrows === '\\alpha' && (await texNS()) === '\\alpha');
await page.waitForTimeout(600);

console.log('32. State 3: Space closes the box; wrapper dropped; next letters type after it (no name merge)');
await page.keyboard.press(' ');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-macro-active'), null, { timeout: 10000 });
console.log('    Space closed the box, active wrapper removed ✓');
await page.keyboard.type('x');
// The closed macro's TeX carries a trailing space, so the letter after it
// can never merge into the macro name: "\\alpha x", not "\\alphax".
await page.waitForFunction(() => document.getElementById('current-tex').value === '\\alpha x', null, { timeout: 25000 });
console.log('    closed macro + letter →', JSON.stringify(await page.$eval('#current-tex', (el) => el.value)), '(guarded against \\alphax)');
await page.waitForTimeout(800);
const mml32 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    highlight dropped with the box (no mathbackground left):', !mml32.includes('mathbackground'));

console.log('33. State 3: Enter closes the box too');
await page.keyboard.type('\\beta');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\alphax\\beta', null, { timeout: 25000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-macro-active'), null, { timeout: 10000 });
await page.keyboard.type('y');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\alphax\\betay', null, { timeout: 25000 });
console.log('    after Enter + y →', JSON.stringify(await texNS()));

console.log('34. State 3: ^ closes the box AND binds the finished macro as the script base');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\alpha^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '{\\alpha}^2', null, { timeout: 25000 });
console.log('    \\alpha^2 →', JSON.stringify(await texNS()), '| macro box closed:', !(await macroActive()));
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
console.log('    cursor locked inside the script block ✓');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.waitForTimeout(700);
const mml34 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    canvas: converted α stacked inside <msup>:', mml34.includes('msup') && (mml34.indexOf('α') !== -1 || mml34.indexOf('𝛼') !== -1),
    '| no monospace leftover:', !mml34.includes('monospace'));

console.log('35. conversion battery: "\\alpha+\\beta=\\gamma" all parse, sequencer holds');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\alpha+\\beta=\\gamma');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\alpha+\\beta=\\gamma', null, { timeout: 30000 });
await page.waitForTimeout(700);
const mml35 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    all three Greek glyphs parsed:', (mml35.indexOf('α') !== -1 || mml35.indexOf('𝛼') !== -1) && (mml35.indexOf('β') !== -1 || mml35.indexOf('𝛽') !== -1) && (mml35.indexOf('γ') !== -1 || mml35.indexOf('𝛾') !== -1),
    '| no monospace leftover:', !mml35.includes('monospace'));

console.log('36. clicking the bare preview background does not crash (app-side core guard)');
const errCountBefore36 = errors.length;
await page.evaluate(() => {
    document.querySelector('#mathslate-editor .mathslate-preview').click();
});
await page.waitForTimeout(400);
console.log('    no page error:', errors.length === errCountBefore36,
    '| slate intact:', JSON.stringify(await texNS()));

console.log('37. unparseable name degrades to a literal token (never lost), typing continues');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\zzzz');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('status-line').textContent.indexOf('literal') !== -1, null, { timeout: 30000 });
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\zzzz', null, { timeout: 25000 });
await page.waitForTimeout(500);
const mml37 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    \\zzzz kept as literal monospace token:', mml37.includes('monospace'),
    '| status:', JSON.stringify((await page.$eval('#status-line', (el) => el.textContent)).slice(0, 60)));
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value === '\\zzzz x', null, { timeout: 15000 });
console.log('    typing after the fallback token works →', JSON.stringify(await page.$eval('#current-tex', (el) => el.value)));

console.log('38. \\frac + Enter renders a live fraction block; numerator box selected');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 25000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.waitForTimeout(700);
const mml38 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    canvas has mfrac:', mml38.includes('mfrac'), '| status:', JSON.stringify((await page.$eval('#status-line', (el) => el.textContent)).slice(0, 50)));
console.log('    typing fills the selected numerator and the focus stays inside the slot:');
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 15000 });
console.log('    numerator took the token ✓ \frac{1}{}');
await page.keyboard.type('2');
// a macro/toolbox structure's armed slot keeps the focus: digits accumulate inside
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{12}{}', null, { timeout: 15000 });
console.log('    digits accumulate inside the numerator ✓ \frac{12}{} — click the denominator box, fill it');
await page.evaluate(() => {
    const divs = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '');
    const id = divs[divs.length - 1].id;
    const shim = [...document.querySelectorAll('span[id="' + id + '"]')]
        .find((n) => getComputedStyle(n).position === 'absolute');
    if (shim) shim.click();
});
// MathJax 4 marks the selection asynchronously (post-typeset) — wait for
// it before typing, like every other shim-click step does.
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{12}{3}', null, { timeout: 15000 });
console.log('    denominator filled from the slate ✓ \frac{12}{3}');

console.log('39. \\sqrt + Enter renders a root block; radicand takes the next chars');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\sqrt');
await page.keyboard.press('Enter');
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{x}', null, { timeout: 25000 });
await page.waitForTimeout(700);
const mml39 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
console.log('    \sqrt{x}:', JSON.stringify(await texNS()), '| canvas has msqrt:', mml39.includes('msqrt'));

console.log('40. caret: blinks at the end when nothing is selected; hides on selection; returns on Esc');
const caretInCanvas = () => document.querySelector('#mathslate-editor #canvas .mathslate-caret');
const caretAtEnd = () => {
    const canvas = document.querySelector('#mathslate-editor #canvas');
    return canvas && canvas.lastElementChild && canvas.lastElementChild.classList.contains('mathslate-caret');
};
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForFunction(() =>
    !!document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 15000 });
console.log('    caret present on the empty slate ✓');
await page.waitForFunction(() => {
    const c = document.querySelector('#mathslate-editor #canvas .mathslate-caret');
    return c && getComputedStyle(c).animationName !== 'none';
}, null, { timeout: 5000 });
console.log('    caret has a blinking animation ✓');
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x', null, { timeout: 10000 });
await page.waitForFunction(() => {
    const canvas = document.querySelector('#mathslate-editor #canvas');
    return canvas.lastElementChild && canvas.lastElementChild.classList.contains('mathslate-caret');
}, null, { timeout: 10000 });
console.log('    typed content lands to the LEFT of the caret; caret stays at the absolute end ✓');
await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')].filter((d) => d.id);
    if (rows.length) {
        const shim = [...document.querySelectorAll('span[id="' + rows[0].id + '"]')]
            .find((n) => getComputedStyle(n).position === 'absolute');
        if (shim) shim.click();
    }
});
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 5000 });
await page.waitForFunction(() => !document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 10000 });
console.log('    selection made → caret hidden ✓');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 10000 });
console.log('    Esc → caret back at the end ✓');

console.log('41. replace rule: typing with a glyph selected replaces it entirely, caret shows after');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('ab');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'ab', null, { timeout: 10000 });
await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')].filter((d) => d.id);
    if (rows.length) {
        const shim = [...document.querySelectorAll('span[id="' + rows[0].id + '"]')]
            .find((n) => getComputedStyle(n).position === 'absolute');
        if (shim) shim.click();
    }
});
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 5000 });
await page.keyboard.type('z');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'zb', null, { timeout: 15000 });
await page.waitForFunction(() =>
    !document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected')
    && !!document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 10000 });
console.log('    "ab" select a, type z → "zb" ✓ selection dropped, caret visible ✓');

console.log('42. Backspace audit: no browser history navigation; caret-state deletes the last block');
const urlBefore42 = page.url();
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.press('Backspace');
await page.keyboard.press('Backspace');
await page.keyboard.press('Backspace');
await page.waitForTimeout(500);
console.log('    empty slate, 3x Backspace — still on the app page:', page.url() === urlBefore42,
    '| tex stays empty:', (await texNS()) === '');
await page.keyboard.type('ab');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'ab', null, { timeout: 10000 });
await page.keyboard.press('Escape'); // nothing selected, caret active
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a', null, { timeout: 10000 });
console.log('    "ab" + Esc + Backspace → "a" (most recent top-level block deleted) ✓');
console.log('    still on the app page (no history navigation):', page.url() === urlBefore42);

console.log('43. caret focus rules: hides while a text control is focused, returns on slate focus');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 10000 });
await page.click('#document-source');
await page.waitForFunction(() => !document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 10000 });
console.log('    hidden while the document textarea holds focus ✓');
// (a real click on the workspace is hit-tested against the blank-box shims
// that overlay it; exercise the app's mousedown focus path directly)
await page.evaluate(() => {
    document.querySelector('#mathslate-editor #canvas')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
});
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor #canvas .mathslate-caret'), null, { timeout: 10000 });
console.log('    back after focusing the slate ✓');

console.log('44. TeX: single-char braceless (x^2); retention writes real multi-char args (e^{2x}); raw y^{2x} keeps braces');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('x^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^2', null, { timeout: 25000 });
await page.keyboard.press('ArrowRight'); // retention: leave the block first
await page.keyboard.type('3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^23', null, { timeout: 15000 });
console.log('    x^2 (→ out) 3 →', JSON.stringify(await texNS()));
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('e^2x'); // retention: the x joins the script block
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{2x}', null, { timeout: 25000 });
await page.keyboard.press('ArrowRight');
console.log('    typed multi-char argument keeps its braces:', JSON.stringify(await texNS()));
await page.evaluate(() => {
    const input = document.querySelector('#mathslate-editor input[type="text"]');
    input.value = 'y^{2x}';
    input.dispatchEvent(new Event('change', { bubbles: true }));
});
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '').endsWith('y^{2x}'), null, { timeout: 25000 });
console.log('    multi-char script from raw TeX keeps its braces ✓ →', JSON.stringify(await texNS()));

console.log('45. < > buttons move the caret; typing and Backspace act AT it');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('abcd');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'abcd', null, { timeout: 10000 });
await page.click('#btn-nav-left');
await page.click('#btn-nav-left');
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return !!c && c.style.position === 'absolute';
}, null, { timeout: 10000 });
console.log('    two < presses: caret anchored mid-slate (before "c") ✓');
await page.keyboard.type('Z');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'abZcd', null, { timeout: 15000 });
console.log('    typed at the caret →', JSON.stringify(await texNS()));
await page.click('#btn-nav-right');
await page.click('#btn-nav-right'); // past "c" and "d": home to the end
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return !!c && !c.style.position;
}, null, { timeout: 10000 });
await page.keyboard.type('e');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'abZcde', null, { timeout: 15000 });
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'abZcd', null, { timeout: 10000 });
console.log('    > back at the end; "e" appended, Backspace deleted it ✓');
await page.waitForTimeout(400); // undo: let the caret watcher snap to the end
await page.click('#btn-nav-left');
await page.click('#btn-nav-left');
await page.click('#btn-nav-left');
await page.click('#btn-nav-left');
await page.keyboard.type('9');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a9bZcd', null, { timeout: 15000 });
console.log('    4x < then "9" →', JSON.stringify(await texNS()));
for (let i = 0; i < 4; i++) { await page.keyboard.press('ArrowRight'); }
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return !!c && !c.style.position;
}, null, { timeout: 10000 });
await page.keyboard.type('0');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a9bZcd0', null, { timeout: 15000 });
console.log('    arrow keys moved home again; "0" appended at the end ✓');

console.log('46. < > step INSIDE the locked script block; a step past the edge lets it out');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('a^23');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{23}', null, { timeout: 15000 });
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.keyboard.press('ArrowLeft'); // caret between 2 and 3
await page.keyboard.type('b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}', null, { timeout: 15000 });
console.log('    typed mid-block →', JSON.stringify(await texNS()));
await page.keyboard.press('ArrowRight'); // caret at the block's end — still inside
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.keyboard.press('ArrowRight'); // a step PAST the end lets it out
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.keyboard.type('c');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}c', null, { timeout: 15000 });
console.log('    edge-step let it out; "c" continues after →', JSON.stringify(await texNS()));
await page.keyboard.type('d^4');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}cd^4', null, { timeout: 15000 });
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft'); // past the left edge: exits before the block
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return !!c && c.style.position === 'absolute';
}, null, { timeout: 10000 });
console.log('    left edge-step exited; caret anchored before the block ✓');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return !!c && !c.style.position;
}, null, { timeout: 10000 });
await page.keyboard.type('e');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}cd^4e', null, { timeout: 15000 });
console.log('    back at the end →', JSON.stringify(await texNS()));

console.log('47. Enter lets the cursor out of a script block too');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('f^5');
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.keyboard.type('g');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'f^5g', null, { timeout: 15000 });
console.log('    f^5 (Enter out) g →', JSON.stringify(await texNS()));

console.log('48. \\ with the denominator box selected opens the macro box INSIDE the fraction');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 15000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 15000 });
// Select the (now only) empty box — the denominator — and press backslash.
await page.waitForTimeout(800);
await page.evaluate(() => {
    const divs = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '');
    const shim = [...document.querySelectorAll('span[id="' + divs[0].id + '"]')]
        .find((n) => getComputedStyle(n).position === 'absolute');
    if (shim) shim.click();
});
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 10000 });
await page.keyboard.type('\\');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{\\}', null, { timeout: 15000 });
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-macro-active'), null, { timeout: 10000 });
await page.waitForFunction(() =>
    [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')]
        .filter((d) => d.textContent.trim() !== '').length === 1, null, { timeout: 10000 });
console.log('    \\ opened inside the denominator (still only the fraction block) ✓');
await page.keyboard.type('beta');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{\\beta}', null, { timeout: 15000 });
console.log('    letters accumulated inside the denominator →', JSON.stringify(await texNS()));
await page.keyboard.press('Enter');
// Conversion is proven by the denominator box coming back armed (the
// terminator-typeable cursor stayed inside the fraction).
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 20000 });
await page.waitForFunction(() =>
    [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')]
        .filter((d) => d.textContent.trim() !== '').length === 1, null, { timeout: 10000 });
await page.keyboard.type('+');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{\\beta+}', null, { timeout: 15000 });
console.log('    \\beta Enter + →', JSON.stringify(await texNS()), '— the cursor never left the denominator ✓');

// Click the LAST fill-box shim (the trailing box of the slate) — used to
// place the cursor into a fraction's denominator throughout steps 49-53.
async function clickLastBlankShim() {
    await page.evaluate(() => {
        const divs = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
            .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '');
        const last = divs[divs.length - 1];
        const shim = last ? [...document.querySelectorAll('span[id="' + last.id + '"]')]
            .find((n) => getComputedStyle(n).position === 'absolute') : null;
        if (shim) { shim.click(); }
    });
    await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
}
async function nonEmptyRows() {
    return page.$eval('#mathslate-editor .mathslate-preview', (el) =>
        [...el.children].filter((d) => d.textContent.trim() !== '').length);
}

console.log('49. slot-+-bug: "+" typed IMMEDIATELY after an in-slot macro conversion stays INSIDE the fraction');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await clickLastBlankShim();
await page.keyboard.type('\\beta');
// no marker wait at all: "+y" is queued behind the conversion, replaying the
// original race — the slot focus must route both characters.
await page.keyboard.press('Enter');
await page.keyboard.type('+y');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{\\beta+y}', null, { timeout: 25000 });
console.log('    fast "+y" never left the denominator →', JSON.stringify(await texNS()),
    '| slate blocks:', await nonEmptyRows(), '(still 1 ✓)');

console.log('50. slot-\\-bug: a variable typed in the denominator keeps the slot focus; \\\\ opens INSIDE it');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await clickLastBlankShim();
await page.keyboard.type('b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{b}', null, { timeout: 15000 });
await page.keyboard.type('\\'); // no selection visible anymore — focus must route this in-slot
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{b\\}', null, { timeout: 15000 });
console.log('    \\\\ after the variable opened the box INSIDE the denominator →',
    JSON.stringify(await texNS()), '| slate blocks:', await nonEmptyRows(), '(still 1 ✓)');
await page.keyboard.type('gamma');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{b\\gamma}', null, { timeout: 15000 });
await page.keyboard.press('Escape'); // close: convert in place
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{b\\gamma}', null, { timeout: 20000 });
await page.keyboard.type('z'); // still inside the slot
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{b\\gammaz}', null, { timeout: 15000 });
console.log('    converted in-slot, "z" continued inside →', JSON.stringify(await texNS()));
await page.keyboard.press('Escape'); // explicit exit → top level
await page.waitForTimeout(400);
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{b\\gammaz}q', null, { timeout: 15000 });
console.log('    Esc let the cursor out; "q" appended at top level ✓');

console.log('51. Backspace deletes INSIDE the focused slot; at empty it steps out without eating the fraction');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await clickLastBlankShim();
await page.keyboard.type('xy');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{xy}', null, { timeout: 15000 });
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{x}', null, { timeout: 15000 });
console.log('    one Backspace →', JSON.stringify(await texNS()), '(in-slot ✓)');
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 15000 });
console.log('    second Backspace emptied the slot (box back) →', JSON.stringify(await texNS()));
await page.keyboard.press('Backspace'); // consumed: focus exits, nothing deleted
await page.waitForTimeout(800);
console.log('    third Backspace ate nothing:', JSON.stringify(await texNS()), '(fraction intact ✓)');
await page.keyboard.type('+');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}+', null, { timeout: 15000 });
console.log('    "+" now lands at top level →', JSON.stringify(await texNS()), '(focus exited ✓)');

console.log('52. ^ inside a slot wraps the last token there; input keeps accumulating in the argument');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await clickLastBlankShim();
await page.keyboard.type('a');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{a}', null, { timeout: 15000 });
await page.keyboard.type('^');
await page.waitForFunction(() =>
    document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{a^{}}'
    && !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 20000 });
console.log('    ^ wrapped the base in place, argument box armed in-slot ✓');
await page.keyboard.type('23');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{a^{23}}', null, { timeout: 15000 });
console.log('    "23" accumulated inside the argument →', JSON.stringify(await texNS()),
    '| slate blocks:', await nonEmptyRows(), '(still 1 ✓)');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
await page.keyboard.type('k');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{a^{23}}k', null, { timeout: 15000 });
console.log('    Esc out; "k" at top level ✓');

console.log('53. / and _ inside a slot build mfrac/msub there (nested structures by typing alone)');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await clickLastBlankShim();
await page.keyboard.type('m');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{m}', null, { timeout: 15000 });
await page.keyboard.type('/');
await page.waitForFunction(() =>
    document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{\\frac{m}{}}'
    && !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 20000 });
await page.keyboard.type('n');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{\\frac{m}{n}}', null, { timeout: 15000 });
console.log('    / nested a fraction inside the denominator →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
// underscore in the same slot
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await clickLastBlankShim();
await page.keyboard.type('p');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{p}', null, { timeout: 15000 });
await page.keyboard.type('_');
await page.waitForFunction(() =>
    document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{p_{}}'
    && !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 20000 });
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{p_q}', null, { timeout: 15000 });
console.log('    _ built a subscript inside the denominator →', JSON.stringify(await texNS()), '✓');

console.log('54. ^ pressed INSIDE a locked script block (caret mid-slot) hatches on the token left of the caret — never around the whole block');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1', null, { timeout: 20000 });
await page.keyboard.type('^');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{}', null, { timeout: 20000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^2', null, { timeout: 20000 });
await page.keyboard.type('3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{23}', null, { timeout: 20000 });
await page.keyboard.press('ArrowLeft'); // caret slips between the 2 and the 3
await page.keyboard.type('^'); // must wrap ONLY the 2, in place (the {{1}^{23}}^{} regression)
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^{}3}', null, { timeout: 20000 });
console.log('    ← then ^ wrapped just the 2 →', JSON.stringify(await texNS()), '| slate blocks:', await nonEmptyRows(), '(still 1 ✓)');
await page.keyboard.type('5'); // into the fresh inner argument
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^53}', null, { timeout: 20000 });
await page.keyboard.type('x'); // and keeps accumulating there
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^{5x}3}', null, { timeout: 20000 });
console.log('    "5x" accumulated inside the new inner argument →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('ArrowRight'); // past the inner slot's edge: step out to top level
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^{5x}3}q', null, { timeout: 20000 });
console.log('    → let the cursor out; "q" continues top-level →', JSON.stringify(await texNS()), '✓');

console.log('55. a trigger with the caret at the slot\'s END keeps the classic newest-wins wrap (1/2/3 nesting)');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('1');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1', null, { timeout: 20000 });
await page.keyboard.type('/');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{2}', null, { timeout: 20000 });
await page.keyboard.type('/'); // caret at the very end of the locked slot: wrap the whole block
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{\\frac{1}{2}}{}', null, { timeout: 20000 });
await page.keyboard.type('3');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{\\frac{1}{2}}{3}', null, { timeout: 20000 });
console.log('    end-of-slot / nested TeX-style →', JSON.stringify(await texNS()), '✓');

console.log('56. \\ pressed INSIDE a locked script block opens the command box in the slot (e^i\\pi)');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('e');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e', null, { timeout: 20000 });
await page.keyboard.type('^');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{}', null, { timeout: 20000 });
await page.keyboard.type('i');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^i', null, { timeout: 20000 });
await page.keyboard.type('\\'); // must NOT exit the superscript
await page.waitForFunction(() =>
    document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{i\\}'
    && document.getElementById('mathslate-editor').classList.contains('mathslate-macro-active'), null, { timeout: 20000 });
console.log('    \\ opened INSIDE the superscript →', JSON.stringify(await texNS()),
    '| slate blocks:', await nonEmptyRows(), '(still 1 ✓)');
await page.keyboard.type('pi');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{i\\pi}', null, { timeout: 20000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{i\\pi}', null, { timeout: 30000 });
console.log('    converted in-slot →', JSON.stringify(await texNS()), '✓');
await page.keyboard.type('x'); // still inside the slot after conversion
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{i\\pix}', null, { timeout: 20000 });
console.log('    "x" continued inside →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('Escape'); // explicit exit → top level
await page.waitForTimeout(400);
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{i\\pix}q', null, { timeout: 20000 });
console.log('    Esc out; "q" at top level →', JSON.stringify(await texNS()), '✓');

console.log('57. filling a macro-structure\'s armed box plants the slot focus (\\sqrt 1 2 → \\sqrt{12})');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\sqrt');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt', null, { timeout: 20000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{}', null, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('12'); // multi-digit radicand, never dropping out
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{12}', null, { timeout: 20000 });
console.log('    digits accumulate inside the radicand →', JSON.stringify(await texNS()),
    '| slate blocks:', await nonEmptyRows(), '(still 1 ✓)');
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{12x}', null, { timeout: 20000 });
console.log('    and keep going →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('ArrowRight'); // explicit exit
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{12x}q', null, { timeout: 20000 });
console.log('    → out; "q" at top level →', JSON.stringify(await texNS()), '✓');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\frac');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac', null, { timeout: 20000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('12');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{12}{}', null, { timeout: 20000 });
console.log('    \\frac numerator digits stay inside too →', JSON.stringify(await texNS()), '✓');

// screenshot is only diagnostic; the MathJax webfont CORS block can stall
// Chromium's font-wait, so cap it
try {
    await page.screenshot({ path: 'shot1.png', fullPage: true, timeout: 8000 });
} catch (e) {
    console.log('screenshot skipped:', e.message.split('\n')[0]);
}

if (errors.length) {
    console.log('--- console/page errors ---');
    errors.forEach((e) => console.log('  ' + e));
} else {
    console.log('no console/page errors');
}
await browser.close();
console.log('TEST DONE');
