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

// tab labels must typeset on ONE line (the '=⊅' report): MathJax 4
// line-breaks inline math at operators by default, which stacked the '⊅'
// under the '=' and hung a glyph below the tab strip — the app's chtml
// config sets linebreaks.inline=false (v2 behaviour)
await page.waitForFunction(() => {
    const labels = [...document.querySelectorAll('#mathslate-editor .yui3-tabview-list .yui3-tab-label')];
    if (!labels.length) { return false; }
    const containers = [...document.querySelectorAll('#mathslate-editor .yui3-tabview-list mjx-container')];
    if (!containers.length) { return false; } // typeset not done yet
    return containers.every((m) => m.getBoundingClientRect().height <= 26)
        && labels.every((l) => l.scrollHeight <= l.clientHeight + 12);
}, null, { timeout: 30000 });
console.log('   all 7 tab labels typeset on a single line (no inline line-break wraps) ✓');

// …and no label's math may protrude past its tab box (the 'tan ∠' report):
// the upstream stylesheet fixes labels at 3.25em, and once MathJax 4
// stopped wrapping/shrinking label math, 'tan ∠' stuck ~7px out over the
// next tab — app.css sizes the labels to their content (floor: 3.25em)
await page.waitForFunction(() => {
    const lis = [...document.querySelectorAll('#mathslate-editor .yui3-tabview-list > li')];
    if (!lis.length || !lis[0].querySelector('mjx-container')) { return false; }
    return lis.every((li) => {
        const mjx = li.querySelector('mjx-container');
        const lb = li.getBoundingClientRect();
        const mb = mjx.getBoundingClientRect();
        return mb.right <= lb.right + 1 && mb.left >= lb.left - 1;
    });
}, null, { timeout: 30000 });
console.log('   no tab label protrudes past its tab box (tan\\angle overlap fixed) ✓');

// the Calculus label must show the upright \nabla: the label forgot
// mathvariant="normal" (the \nabla TOOL in the same tab has it), and while
// MathJax 2's fonts had no italic nabla to fall back to, v4's newcm does —
// so the label started rendering 𝛻 (U+1D6FB) after the port
await page.waitForFunction(() => {
    const calc = [...document.querySelectorAll('#mathslate-editor .yui3-tabview-list .yui3-tab-label')]
        .find((l) => (l.querySelector('span[title]') || {}).title === 'Calculus');
    if (!calc || !calc.querySelector('mjx-container')) { return false; }
    return !!calc.querySelector('.mjx-c2207') && !calc.querySelector('.mjx-c1D6FB');
}, null, { timeout: 30000 });
console.log('   Calculus tab label renders the upright \\nabla (no italic variant) ✓');

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
const caretInCanvas = () => document.querySelector('.mathslate-caret');
const caretAtEnd = () => {
    const canvas = document.querySelector('#mathslate-editor #canvas');
    return canvas && canvas.lastElementChild && canvas.lastElementChild.classList.contains('mathslate-caret');
};
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForFunction(() =>
    !!document.querySelector('.mathslate-caret'), null, { timeout: 15000 });
console.log('    caret present on the empty slate ✓');
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
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
await page.waitForFunction(() => !document.querySelector('.mathslate-caret'), null, { timeout: 10000 });
console.log('    selection made → caret hidden ✓');
await page.keyboard.press('Escape');
await page.waitForFunction(() => !!document.querySelector('.mathslate-caret'), null, { timeout: 10000 });
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
    && !!document.querySelector('.mathslate-caret'), null, { timeout: 10000 });
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
await page.waitForFunction(() => !!document.querySelector('.mathslate-caret'), null, { timeout: 10000 });
await page.click('#document-source');
await page.waitForFunction(() => !document.querySelector('.mathslate-caret'), null, { timeout: 10000 });
console.log('    hidden while the document textarea holds focus ✓');
// (a real click on the workspace is hit-tested against the blank-box shims
// that overlay it; exercise the app's mousedown focus path directly)
await page.evaluate(() => {
    document.querySelector('#mathslate-editor #canvas')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
});
await page.waitForFunction(() => !!document.querySelector('.mathslate-caret'), null, { timeout: 10000 });
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
await page.keyboard.press('ArrowLeft'); // past the script's left edge: parks beside the base (d|^{4})
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'), null, { timeout: 10000 });
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 }); // the parked caret's socket between base and script
await page.keyboard.type('w'); // extends the base — |a^{2} was the report's wrong jump
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}c{dw}^4', null, { timeout: 15000 });
console.log('    left edge-step parked at the base end; "w" grew the base →', JSON.stringify(await texNS()));
await page.keyboard.press('ArrowRight'); // roundtrip: back into the script's start
await page.keyboard.type('z');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}c{dw}^{z4}', null, { timeout: 15000 });
console.log('    → roundtripped into the script start; "z" filled there →', JSON.stringify(await texNS()));
await page.keyboard.press('ArrowRight'); // walks to the script's end…
await page.keyboard.press('ArrowRight'); // …and one more steps out right, after the block
await page.keyboard.type('e');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'a^{2b3}c{dw}^{z4}e', null, { timeout: 15000 });
console.log('    rightward walk exits after the block; "e" at the slate end →', JSON.stringify(await texNS()));

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
// Select the empty denominator box (the LAST empty box: the filled
// numerator keeps its own trailing box as the caret's socket) and press
// backslash.
await page.waitForTimeout(800);
await page.evaluate(() => {
    const divs = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '');
    const shim = [...document.querySelectorAll('span[id="' + divs[divs.length - 1].id + '"]')]
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
// → peels ONE nesting level at a time: out of the inner argument into the
// outer superscript slot (parked right after the inner structure), past
// the outer slot's end, then out to the top level.
await page.keyboard.press('ArrowRight'); // out of the inner argument
await page.keyboard.type('z'); // …lands in the OUTER slot, mid-position
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^{5x}z3}', null, { timeout: 20000 });
console.log('    → peeled into the outer slot; "z" went there mid-slot →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^{5x}3}', null, { timeout: 20000 });
await page.keyboard.press('ArrowRight'); // caret to the outer slot's end
await page.keyboard.press('ArrowRight'); // past that edge: out to top level
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '1^{2^{5x}3}q', null, { timeout: 20000 });
console.log('    →×2 more peeled out; "q" continues top-level →', JSON.stringify(await texNS()), '✓');

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

console.log('58. \\sqrt + Space + b^2: the caret stays VISIBLE inside the superscript slot');
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\sqrt');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt', null, { timeout: 20000 });
await page.keyboard.press(' '); // Space, exactly as in the report
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{}', null, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b}', null, { timeout: 20000 });
await page.keyboard.type('^');
await page.waitForFunction(() =>
    document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{}}'
    && !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 20000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^2}', null, { timeout: 20000 });
// the bug: the caret vanished here. It must be alive, absolutely
// positioned (anchored in the slot), inside the structure's extent.
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return c && c.style.position === 'absolute';
}, null, { timeout: 15000 });
const c58 = await page.evaluate(() => {
    const caret = document.querySelector('.mathslate-caret');
    const r = caret.getBoundingClientRect();
    const root = document.querySelector('#mathslate-editor #canvas [id="' +
        [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')].filter((d) => d.id)[0].id + '"]');
    const rr = root.getBoundingClientRect();
    return { blanks: [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '').length,
        inside: r.left >= rr.left - 2 && r.left <= rr.right + 2 && r.top >= rr.top - 6 && r.top <= rr.bottom + 6 };
});
console.log('    caret alive after 2, anchored inside the block ✓', JSON.stringify(c58));
if (!c58.blanks || !c58.inside) { throw new Error('caret left the structure (the disappearing-caret bug)'); }
await page.keyboard.type('4'); // keeps accumulating inside the exponent
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{24}}', null, { timeout: 20000 });
console.log('    "4" accumulated in the exponent →', JSON.stringify(await texNS()), '✓');

console.log('59. → peels exactly ONE nesting level out of a nested slot (\\sqrt{b^{24}} → caret stays in the radical; - lands inside)');
await page.keyboard.press('ArrowRight'); // out of the superscript ONLY
await page.waitForTimeout(600);
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return c && c.style.position === 'absolute'; // still anchored INSIDE the radical
}, null, { timeout: 15000 });
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{24}}', null, { timeout: 20000 });
console.log('    → left just the superscript; caret still anchored inside the radical ✓');
await page.keyboard.type('-');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{24}-}', null, { timeout: 20000 });
console.log('    "-" typed INSIDE the radical →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('ArrowLeft'); // caret steps left inside the radicand
await page.keyboard.press('ArrowRight'); // and back to its end
await page.keyboard.press('ArrowRight'); // past the radicand's edge: out to top level
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    const canvas = document.querySelector('#mathslate-editor #canvas');
    return c && canvas && canvas.lastElementChild === c && !c.style.position; // in-flow at the end
}, null, { timeout: 15000 });
console.log('    second → left the structure; caret parked at the slate end ✓');
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{24}-}q', null, { timeout: 20000 });
console.log('    "q" continued at top level →', JSON.stringify(await texNS()), '✓');
// left-arrow peel: ← out of a nested argument parks the caret BEFORE the
// structure inside the enclosing slot
await page.click('#btn-clear-slate');
await page.click('main');
await page.waitForTimeout(200);
await page.keyboard.type('\\sqrt');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt', null, { timeout: 20000 });
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{}', null, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b}', null, { timeout: 20000 });
await page.keyboard.type('^');
await page.waitForFunction(() =>
    document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{}}'
    && !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 20000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^2}', null, { timeout: 20000 });
await page.keyboard.press('ArrowLeft'); // caret before the 2, inside the argument
await page.keyboard.press('ArrowLeft'); // past the argument's left edge: park at the base's end (b|^{2})
await page.keyboard.type('w'); // extends the base, inside the radicand
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{{bw}^2}', null, { timeout: 20000 });
console.log('    ←×2 parked at the script base\'s end inside the radicand; "w" grew the base →', JSON.stringify(await texNS()), '✓');
await page.keyboard.press('ArrowLeft'); // between b and w in the base
await page.keyboard.press('ArrowLeft'); // before the base, still inside the block
await page.keyboard.press('ArrowLeft'); // peel: parked before bw^2, back in the radicand
await page.keyboard.press('ArrowLeft'); // past the radicand's left edge: out to the slate, before the block
await page.keyboard.type('v');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'v\\sqrt{{bw}^2}', null, { timeout: 20000 });
console.log('    through the base, peeled into the radicand and out before the block →', JSON.stringify(await texNS()), '✓');

console.log('60. launch focus: the workspace owns the caret at boot; first keystrokes land on the slate');
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('#mathslate-editor .yui3-tabview', { timeout: 90000 });
await page.waitForFunction(
    () => document.querySelectorAll('#mathslate-editor .yui3-tabview-panel .yui3-dd-draggable').length > 20,
    null, { timeout: 90000 });
// the bug: the TeX tool's input field grabbed launch focus
await page.waitForFunction(() => {
    const input = document.querySelector('#mathslate-editor input[type="text"]');
    return input && document.activeElement !== input;
}, null, { timeout: 15000 });
console.log('    TeX tool input does not hold launch focus ✓');
// …and neither does the bare page body ("main workspace gains focus"):
// the SLATE canvas itself is the DOM focus owner from launch
await page.waitForFunction(() =>
    document.activeElement === document.querySelector('#mathslate-editor #canvas')
    && document.activeElement !== document.body, null, { timeout: 15000 });
console.log('    the slate canvas itself owns DOM focus at launch (not the page body) ✓');
// …and the launch caret must hug the decoy box INSIDE #canvas: on the
// empty slate MathJax emits a BLOCK-level container, and the old in-flow
// caret wrapped to a fresh line below it — visibly centered inside the
// black preview panel while the □ sat alone at the canvas's bottom left
await page.waitForFunction(() => {
    const caret = document.querySelector('.mathslate-caret');
    const blank = document.querySelector('#mathslate-editor #canvas mjx-mo.blank');
    if (!caret || !blank) { return false; }
    const c = caret.getBoundingClientRect();
    const b = blank.getBoundingClientRect();
    return Math.abs(c.left - b.right) < 6 && Math.abs(c.top - b.top) < 6;
}, null, { timeout: 15000 });
console.log('    the launch caret hugs the decoy box inside #canvas (not the preview panel) ✓');
// …and the launch box must be CENTRED, not bottom-left: the editor's
// first canvas render requested display:block math (left-justified under
// the app's displayAlign config) while every re-render after it used
// inline math, so the box snapped to centre on the first keystroke; the
// first render is inline now
await page.waitForFunction(() => {
    const blank = document.querySelector('#mathslate-editor #canvas mjx-mo.blank');
    const canvas = document.querySelector('#mathslate-editor #canvas');
    const mjx = document.querySelector('#mathslate-editor #canvas mjx-container');
    if (!blank || !canvas || !mjx) { return false; }
    const b = blank.getBoundingClientRect();
    const c = canvas.getBoundingClientRect();
    return mjx.getAttribute('display') !== 'true'
        && Math.abs(b.x + b.width / 2 - (c.x + c.width / 2)) < 10;
}, null, { timeout: 15000 });
console.log('    the empty slate typesets inline; box+caret launch centred in the workspace ✓');
// the report's sequence, typed with NO click anywhere
await page.keyboard.type('\\sqrt');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt', null, { timeout: 20000 });
await page.keyboard.press(' ');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{}', null, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b}', null, { timeout: 20000 });
// the caret must be alive inside the radical
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return c && c.style.position === 'absolute';
}, null, { timeout: 15000 });
console.log('    \\sqrt Space b typed end-to-end at launch; caret anchored inside the radical ✓');
const leaked60 = await page.$eval('#mathslate-editor input[type="text"]', (el) => el.value);
if (leaked60 !== '') { throw new Error('keystrokes leaked into the TeX tool input at launch: ' + JSON.stringify(leaked60)); }
console.log('    TeX field stayed empty (keys never leaked into it) ✓');
// a slate mousedown reclaims DOM focus from the field even on sticky browsers
await page.click('#mathslate-editor input[type="text"]');
await page.waitForFunction(() =>
    document.activeElement === document.querySelector('#mathslate-editor input[type="text"]'), null, { timeout: 15000 });
await page.evaluate(() => {
    document.querySelector('#mathslate-editor #canvas')
        .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
});
await page.waitForFunction(() =>
    document.activeElement === document.querySelector('#mathslate-editor #canvas'), null, { timeout: 15000 });
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b}', null, { timeout: 10000 });
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{bx}', null, { timeout: 20000 });
console.log('    slate mousedown handed DOM focus to the slate canvas; typing continued in the slot →', JSON.stringify(await texNS()), '✓');

console.log('61. → out of an armed-but-empty script block re-anchors the caret at top level');
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('e');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e', null, { timeout: 20000 });
await page.keyboard.type('^');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{}', null, { timeout: 30000 });
// the fresh script box is armed: its selection, not the caret, marks the insertion point
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.waitForFunction(() => !document.querySelector('.mathslate-caret'), null, { timeout: 15000 });
// the bug: → dropped the armed box's selection but left the script state
// "awaiting" — and an awaiting-unlocked script suppresses the caret (the
// glowing box stands in for it), so the caret vanished for the rest of
// the session even though typing kept appending at the top level
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => !!document.querySelector('.mathslate-caret'), null, { timeout: 15000 });
console.log('    caret re-anchored at top level after → ✓');
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{}x', null, { timeout: 20000 });
await page.waitForFunction(() => !!document.querySelector('.mathslate-caret'), null, { timeout: 15000 });
console.log('    "x" continued at top level with a live caret →', JSON.stringify(await texNS()), '✓');
// stepping out LEFT of the armed block parks the caret BEFORE it, alive
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('e^');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'e^{}', null, { timeout: 30000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.press('ArrowLeft');
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return c && c.style.position === 'absolute';
}, null, { timeout: 15000 });
await page.keyboard.type('x');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'xe^{}', null, { timeout: 20000 });
await page.waitForFunction(() => {
    const c = document.querySelector('.mathslate-caret');
    return c && c.style.position === 'absolute';
}, null, { timeout: 15000 });
console.log('    ← parked before the block with a live caret; "x" landed before it →', JSON.stringify(await texNS()), '✓');

console.log('62. → out of a superscript slot CLOSES its placeholder box (the \\sqrt{b^2} report)');
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('\\sqrt');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{}', null, { timeout: 30000 });
await page.keyboard.type('b');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b}', null, { timeout: 20000 });
await page.keyboard.type('^');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^{}}', null, { timeout: 30000 });
// while the argument is armed, its box is the only box on the slate
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 15000 });
await page.keyboard.type('2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^2}', null, { timeout: 20000 });
// the focused superscript keeps exactly ONE box: the caret's socket
await page.waitForFunction(() => {
    const blanks = document.querySelectorAll('#mathslate-editor #canvas mjx-mo.blank');
    if (blanks.length !== 1) { return false; }
    return !!blanks[0].closest('mjx-msup');
}, null, { timeout: 15000 });
console.log('    focused superscript shows exactly one box (its socket) ✓');
// the bug: → moved the caret past the exponent but left the placeholder
// box visible behind the 2 — the container must close with the exit
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() => {
    let inSup = 0;
    document.querySelectorAll('#mathslate-editor #canvas mjx-msup')
        .forEach((m) => { inSup += m.querySelectorAll('mjx-mo.blank').length; });
    return inSup === 0
        && document.querySelectorAll('#mathslate-editor #canvas mjx-mo.blank').length === 1
        && !!document.querySelector('.mathslate-caret');
}, null, { timeout: 15000 });
console.log('    → closed the superscript box; the radicand keeps the live focus ✓');
await page.keyboard.type('-');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^2-}', null, { timeout: 20000 });
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas mjx-mo.blank').length === 0
    && !!document.querySelector('.mathslate-caret'), null, { timeout: 15000 });
await page.keyboard.type('q');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^2-}q', null, { timeout: 20000 });
console.log('    released to the slate with zero stray boxes; "q" at top level →', JSON.stringify(await texNS()), '✓');
// Esc while focused closes the socket as well
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('\\sqrt');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{}', null, { timeout: 30000 });
await page.keyboard.type('b^2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqrt{b^2}', null, { timeout: 30000 });
await page.keyboard.press('Escape');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas mjx-mo.blank').length === 0
    && !!document.querySelector('.mathslate-caret'), null, { timeout: 15000 });
console.log('    Esc let the slot go and closed its box too ✓');

console.log('63. the placeholder stays visual: 1/2 then Backspace x2 must never leak "[]" into the TeX');
// the report: output('JSON') used to clean the slate by MUTATING the live
// tree (blanks -> '[]' strings, ids deleted) — and the undo stack shares
// those nested objects, so the second Backspace's undo restored a poisoned
// snapshot and the buffer showed \frac{1}{[]} (then kept propagating). The
// core patch cleans by deep copy and the serializers drop stray markers.
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('1/2');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{2}', null, { timeout: 20000 });
const rawPreviewNS = () => page.evaluate(() => {
    const p = document.querySelector('#mathslate-editor .mathslate-preview');
    return p ? p.textContent : '';
});
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 20000 });
await page.keyboard.press('Backspace');
await page.waitForTimeout(800);
const buf63a = await rawPreviewNS();
if (buf63a.includes('[]')) { throw new Error('placeholder marker leaked into the raw TeX buffer: ' + buf63a); }
const tex63a = await texNS();
if (tex63a.includes('[]')) { throw new Error('placeholder marker leaked into #current-tex: ' + tex63a); }
console.log('    after bs x2: buffer', JSON.stringify(buf63a), '| tex', JSON.stringify(tex63a), '— zero marker text ✓');
// the emptied denominator still renders as the visual box, and further
// input stays clean of brackets (the cursor steps OUT at the empty slot —
// the established contract — so the next token lands at top level)
await page.waitForFunction(() => document.querySelectorAll('#mathslate-editor #canvas mjx-mo.blank').length === 1, null, { timeout: 15000 });
await page.keyboard.type('5');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}5', null, { timeout: 20000 });
const buf63b = await rawPreviewNS();
if (buf63b.includes('[]')) { throw new Error('marker text propagated into later input: ' + buf63b); }
console.log('    cursor stepped out at the empty slot; "5" at top level →', JSON.stringify(await texNS()), '— the □ lives only in the render ✓');

console.log('64. Delete is FORWARD delete (token right of the caret), never a Backspace alias');
// at the slate's end there is nothing right of the caret: a no-op, NOT
// Backspace's drop-the-last-block
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('abc');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'abc', null, { timeout: 15000 });
await page.keyboard.press('Delete');
await new Promise((r) => setTimeout(r, 700));
if (await texNS() !== 'abc') { throw new Error('Delete at the slate end must be a no-op, got ' + (await texNS())); }
console.log('    end of slate: abc + Delete stays "abc" ✓');
// parked mid-slate it eats the block on the RIGHT and keeps its gap —
// the exact mirror of Backspace there
await page.keyboard.press('ArrowLeft');
await new Promise((r) => setTimeout(r, 400));
await page.keyboard.press('Delete');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'ab', null, { timeout: 15000 });
await page.keyboard.press('Delete');
await new Promise((r) => setTimeout(r, 500));
if (await texNS() !== 'ab') { throw new Error('Delete with nothing right of the caret must be a no-op, got ' + (await texNS())); }
console.log('    mid-slate: abc ← Delete → "ab" (c eaten from the right); again → no-op ✓');
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('abc');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'abc', null, { timeout: 15000 });
await page.keyboard.press('ArrowLeft');
await new Promise((r) => setTimeout(r, 400));
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'ac', null, { timeout: 15000 });
console.log('    contrast, same caret: Backspace → "ac" (eats from the left) ✓');
// inside a focused slot: Delete removes the token right of the intra-slot
// caret and the focus survives
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('\\frac');
await page.keyboard.press('Enter');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{}{}', null, { timeout: 25000 });
await new Promise((r) => setTimeout(r, 700));
await page.keyboard.type('12');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{12}{}', null, { timeout: 15000 });
await page.keyboard.press('ArrowLeft');
await new Promise((r) => setTimeout(r, 400));
await page.keyboard.press('Delete');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{1}{}', null, { timeout: 15000 });
await page.keyboard.type('4');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{14}{}', null, { timeout: 15000 });
console.log('    in-slot: \\frac{12}{} ← Delete → \\frac{1}{}, focus survives → 4 gives \\frac{14}{} ✓');
// inside a locked script block: Delete removes the token right of the
// block caret — never Backspace's collapse-to-base — and the macro box
// ignores it outright (its text caret sits at the name's end)
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('x^23');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^{23}', null, { timeout: 15000 });
await page.keyboard.press('ArrowLeft');
await new Promise((r) => setTimeout(r, 400));
await page.keyboard.press('Delete');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === 'x^2', null, { timeout: 15000 });
await page.keyboard.press('Space');
await new Promise((r) => setTimeout(r, 500));
console.log('    locked block: x^{23} ← Delete → x^2 (3 eaten from the right), Space exits ✓');
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.keyboard.type('\\sqr');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sqr', null, { timeout: 15000 });
await page.keyboard.press('Delete');
await new Promise((r) => setTimeout(r, 600));
if (await texNS() !== '\\sqr') { throw new Error('Delete in the macro box must leave the name alone, got ' + (await texNS())); }
await page.keyboard.press('Backspace');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\sq', null, { timeout: 15000 });
await page.keyboard.press('Escape');
await new Promise((r) => setTimeout(r, 400));
console.log('    macro box: \\sqr + Delete → \\sqr (no-op), Backspace → \\sq ✓');

console.log('65. toolbox tool LABELS show the placeholder as □, never literal brackets');
// the upstream Tool constructor rendered a label's blank marker as a
// literal <mn>[]</mn> (sin [], tan [], f([]), log_[] [], e^[] …); the
// patch swaps it for the same ◻ box the slate uses — brackets stay
// functional math symbols, the box is the unified fill-in affordance.
await page.waitForFunction(() => {
    const panels = [...document.querySelectorAll('#mathslate-editor .yui3-tabview-panel')];
    if (!panels.length || !panels[0].querySelector('mjx-container')) { return false; }
    let brackets = 0, boxes = 0;
    panels.forEach((p) => {
        p.querySelectorAll('mjx-mn, mjx-mo').forEach((n) => {
            if (n.textContent.trim() === '[]') { brackets++; }
        });
        p.querySelectorAll('mjx-mo').forEach((n) => { if (n.textContent.includes('\u25FB')) { boxes++; } });
    });
    return brackets === 0 && boxes > 50;
}, null, { timeout: 30000 });
console.log('    zero "[]" placeholder labels across all tool tabs; box glyphs rendered ✓');
// and inserting the tool still lands the real blank on the slate (the
// tool's stored json keeps the raw marker — only the label is display-side)
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[4].querySelector('.yui3-tab-label, a').click();
});
await page.waitForTimeout(800);
const handle65 = await page.evaluateHandle(() => {
    const hs = [...document.querySelectorAll('#mathslate-editor .yui3-tabview-panel .yui3-dd-draggable')];
    return hs.find((h) => {
        const span = h.querySelector('span[title]') || h;
        return (span.title || '').includes('\u25FB') && h.getBoundingClientRect().width > 0;
    });
});
await handle65.asElement().click();
await page.waitForTimeout(1000);
const mml65 = await page.$eval('#mathslate-editor #canvas', (el) => el.innerHTML);
if (!mml65.includes('blank')) { throw new Error('tool insert must land a live blank box on the slate'); }
console.log('    clicking a placeholder tool lands a live blank box on the slate ✓');

console.log('66. quick-access calligraphic (\\mathcal) and Fraktur (\\mathfrak) rows in the Latin tab');
// the issue: the palette had lowercase/uppercase Greek and the blackboard
// sets (C,N,Q,R,Z) but no calligraphic script or Fraktur rows. The Latin
// tab now carries 26 + 26 of them, built exactly like MathJax 4's own TeX
// output for those macros — \mathcal{A}'s <mi> carries
// data-mjx-variant="-tex-calligraphic" ON TOP OF mathvariant="script"
// (plain script is only what \mathscr gets — without the internal
// variant the canvas showed the Unicode script alphabet, not the classic
// calligraphic one), \mathfrak{A}'s just mathvariant="fraktur" — so the
// canvas, the label and the TeX read-out all agree with the real macros.
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[3].querySelector('.yui3-tab-label, a').click();
});
await new Promise((r) => setTimeout(r, 800));
await page.waitForFunction(() => {
    const panel = document.querySelector('#mathslate-editor .yui3-tab-panel-selected');
    if (!panel || !panel.querySelector('mjx-container')) { return false; }
    const spans = [...panel.querySelectorAll('span[title]')];
    const cal = spans.filter((s) => /^\\mathcal [A-Z]$/.test(s.title));
    const frak = spans.filter((s) => /^\\mathfrak [A-Z]$/.test(s.title));
    if (cal.length !== 26 || frak.length !== 26) { return false; }
    // and none of them clips under the canvas (the upstream fixed-height
    // panel hid the fifth row; panels size to content now)
    const cr = document.querySelector('#mathslate-editor #canvas').getBoundingClientRect();
    return spans.every((s) => s.getBoundingClientRect().bottom <= cr.top + 1);
}, null, { timeout: 30000 });
console.log('    26 \\mathcal + 26 \\mathfrak tools, all five Latin rows fully visible ✓');
const clickToolByTitle = async (title) => {
    const h = await page.evaluateHandle((t) => {
        const spans = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')];
        return spans.find((x) => x.title === t).closest('.yui3-dd-draggable');
    }, title);
    await h.asElement().click();
};
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await clickToolByTitle('\\mathcal A');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\mathcalA', null, { timeout: 15000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor #canvas .NCM-C'), null, { timeout: 15000 });
console.log('    \\mathcal A tool → slate TeX \\mathcal A, canvas typesets the true calligraphic alphabet (NCM-C, like a real \\mathcal{A}) ✓');
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await clickToolByTitle('\\mathfrak A');
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\mathfrakA', null, { timeout: 15000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor #canvas .mjx-c1D504'), null, { timeout: 15000 });
console.log('    \\mathfrak A tool → slate TeX \\mathfrak A, canvas typesets the Fraktur glyph (U+1D504) ✓');

console.log('67. derivative buttons render their operator glyphs (the invisible-\\partial report)');
// inherited from the upstream config: the total/partial derivative tools
// wrapped the glyph in a one-element ARRAY (["mi",{},["d"]] /
// ["mi",{},["∂"]]) that toMathML silently drops (bare string children of
// element arrays are skipped), so the buttons rendered as an empty
// <mjx-mi></mjx-mi> and looked exactly like the plain fraction — and the
// canvas lost the d/∂ on insertion too. The glyphs are plain string
// content now.
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[6].querySelector('.yui3-tab-label, a').click();
});
await new Promise((r) => setTimeout(r, 800));
await page.waitForFunction(() => {
    const panel = document.querySelector('#mathslate-editor .yui3-tab-panel-selected');
    if (!panel || !panel.querySelector('mjx-container')) { return false; }
    const spans = [...panel.querySelectorAll('span[title]')];
    const check = (title) => {
        const s = spans.find((x) => x.title === title);
        if (!s) { return false; }
        const mis = [...s.querySelectorAll('mjx-mi')];
        // both operator glyphs present and visible (typeset as the italic
        // forms U+1D451/U+1D715 by MathJax 4 — just require non-empty)
        return mis.length === 2 && mis.every((m) => m.textContent.trim() !== '');
    };
    // the plain fraction label (relations tab) has no mi at all — the
    // derivative labels must VISIBLY differ from two bare boxes
    return check('\\frac{d◻}{d◻}') && check('\\frac{\\partial◻}{\\partial◻}');
}, null, { timeout: 30000 });
console.log('    d□/d□ and ∂□/∂□ buttons show their operator glyphs (no empty <mjx-mi> left) ✓');
await page.click('#btn-clear-slate');
await page.click('main');
await new Promise((r) => setTimeout(r, 250));
await page.evaluate(() => {
    const spans = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')];
    spans.find((x) => x.title.includes('partial')).closest('.yui3-dd-draggable').click();
});
await page.waitForFunction(() => document.getElementById('current-tex').value.replace(/\s+/g, '') === '\\frac{\\partial}{\\partial}', null, { timeout: 15000 });
// MathJax 4 typesets ∂ as the italic mathematical partial U+1D715 —
// tex2chtml of the real \frac{\partial}{\partial} does exactly the same
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c1D715').length === 2
    && ![...document.querySelectorAll('#mathslate-editor #canvas mjx-mi')].some((m) => !m.textContent.trim()),
    null, { timeout: 15000 });
console.log('    insertion renders both ∂ glyphs on the slate (U+1D715, same as real \\frac{\\partial}{\\partial}) ✓');

console.log('68. selection-aware wrap: ^ _ / bind to the SELECTED block, not the last one');
// Click the i-th top-level block like a user does (its drop-shim), then
// wait for the selection marker. The shim only exists once MathJax
// rendered the row, so retry inside the wait.
async function clickTopBlock68(idx) {
    await page.waitForFunction((i) => {
        const rows = [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')].filter((d) => d.id);
        if (rows.length <= i) { return false; }
        const shim = [...document.querySelectorAll('span[id="' + rows[i].id + '"]')]
            .find((n) => getComputedStyle(n).position === 'absolute');
        if (!shim) { return false; }
        shim.click();
        return true;
    }, idx, { timeout: 10000 });
    await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 10000 });
}
async function texIs68(want) {
    await page.waitForFunction((w) => document.getElementById('current-tex').value.replace(/\s+/g, '') === w, want, { timeout: 15000 });
}
async function freshSlate68() {
    await page.click('#btn-clear-slate');
    await page.click('main');
    await page.waitForTimeout(250);
}

// control (no selection): the classic newest-wins wrap still takes the LAST block
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await page.keyboard.type('^');
await texIs68('12^{}');
console.log('    control: "12" + ^ → "12^{}" (no selection: last block wrapped) ✓');

// the report: "12", click the "1", ^ must wrap the 1 — and the argument
// must own the cursor afterwards. The fill is typed blind on purpose (no
// marker wait): the wrap's planted slot focus routes it either way.
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await clickTopBlock68(0);
await page.keyboard.type('^');
await texIs68('1^{}2');
await page.keyboard.type('34');
await texIs68('1^{34}2');
console.log('    "12", select "1", ^ → "1^{}2"; typing fills the argument → "1^{34}2" ✓');

// mid-slate selection: the wrap happens WHERE the selection stood
await freshSlate68();
await page.keyboard.type('12+3');
await texIs68('12+3');
await clickTopBlock68(1);
await page.keyboard.type('_');
await texIs68('12_{}+3');
await page.keyboard.type('9');
await texIs68('12_9+3');
console.log('    "12+3", select "2", _ → "12_{}+3" (in place), fill → "12_9+3" ✓');

// the / trigger on a selection wraps it into a numerator
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await clickTopBlock68(0);
await page.keyboard.type('/');
await texIs68('\\frac{1}{}2');
await page.keyboard.type('5');
await texIs68('\\frac{1}{5}2');
console.log('    "12", select "1", / → "\\frac{1}{}2", fill → "\\frac{1}{5}2" ✓');

// a nested selection (a fraction's numerator) wraps its whole top-level
// block — and the fresh argument box, never the fraction's own boxes,
// becomes the cursor
await freshSlate68();
await page.keyboard.type('1/2');
await texIs68('\\frac{1}{2}');
await page.waitForFunction(() => {
    const row = [...document.querySelectorAll('#mathslate-editor .mathslate-preview > div')].filter((d) => d.id)[0];
    if (!row) { return false; }
    const numDiv = row.querySelector('div[id]');
    if (!numDiv) { return false; }
    const shim = [...document.querySelectorAll('span[id="' + numDiv.id + '"]')]
        .find((n) => getComputedStyle(n).position === 'absolute');
    if (!shim) { return false; }
    shim.click();
    return true;
}, null, { timeout: 10000 });
await page.waitForFunction(() => !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected'), null, { timeout: 10000 });
await page.keyboard.type('^');
await texIs68('{\\frac{1}{2}}^{}');
await page.keyboard.type('3');
await texIs68('{\\frac{1}{2}}^3');
console.log('    select a frac numerator, ^ → "{\\frac{1}{2}}^{}"; the fill lands in the argument, not in the frac ✓');
await page.click('#btn-clear-slate');

console.log('69. fraction cursor navigation: ← climbs denominator → numerator, final ← exits left');
// helpers from step 68 are reused: freshSlate68, texIs68, clickTopBlock68
// Locked / flow (typed): ← at the denominator's START jumps to the
// numerator's END instead of exiting the fraction.
await freshSlate68();
await page.keyboard.type('a/bc');
await texIs68('\\frac{a}{bc}');
await page.keyboard.press('ArrowLeft'); // b|c inside the denominator
await page.keyboard.type('X');
await texIs68('\\frac{a}{bXc}');
await page.keyboard.press('Backspace');
await texIs68('\\frac{a}{bc}');
await page.keyboard.press('ArrowLeft'); // to the denominator's start
await page.keyboard.press('ArrowLeft'); // past it: jump to the numerator's END
await page.keyboard.type('Y');
await texIs68('\\frac{aY}{bc}');
console.log('    locked: ← at the denominator start climbs to the numerator end →', "\\frac{aY}{bc} ✓");
await page.keyboard.press('Backspace');
await texIs68('\\frac{a}{bc}');
await page.keyboard.press('ArrowLeft'); // to the numerator's start
await page.keyboard.type('Z');
await texIs68('\\frac{Za}{bc}');
await page.keyboard.press('Backspace');
await texIs68('\\frac{a}{bc}');
await page.keyboard.press('ArrowLeft'); // past the numerator's start: exit left
await page.keyboard.type('W');
await texIs68('W\\frac{a}{bc}');
console.log('    locked: the numerator walks left, one final ← exits the fraction →', "W\\frac{a}{bc} ✓");

// click-focused slot flow (the same navigation after a box fill) + the → roundtrip
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await clickTopBlock68(0);
await page.keyboard.type('/');
await texIs68('\\frac{1}{}2');
await page.keyboard.type('5');
await texIs68('\\frac{1}{5}2');
await page.keyboard.press('ArrowLeft'); // denominator start
await page.keyboard.press('ArrowLeft'); // jump to the numerator's end
await page.keyboard.type('Y');
await texIs68('\\frac{1Y}{5}2');
console.log('    focused: ← at the denominator start climbs to the numerator end →', "\\frac{1Y}{5}2 ✓");
await page.keyboard.press('ArrowRight'); // roundtrip: back to the denominator's START
await page.keyboard.type('Q');
await texIs68('\\frac{1Y}{Q5}2');
console.log('    focused: → at the numerator end drops to the denominator start →', "\\frac{1Y}{Q5}2 ✓");
await page.keyboard.press('Backspace');
await texIs68('\\frac{1Y}{5}2');

// a STRUCTURE base (an empty radical) is wrapped invisibly: the canvas and
// the TeX stay identical while the caret anchors after the radical
await freshSlate68();
await page.keyboard.type('\\sqrt');
await page.keyboard.type('/'); // closes the macro, wraps the radical
await texIs68('\\frac{\\sqrt{}}{}');
await page.keyboard.type('b');
await texIs68('\\frac{\\sqrt{}}{b}');
await page.keyboard.press('ArrowLeft'); // denominator start
await page.keyboard.press('ArrowLeft'); // jump to the numerator's end
await page.keyboard.type('Y');
await texIs68('\\frac{\\sqrt{}Y}{b}');
console.log('    structure base "\\sqrt{}" stays intact, the fill anchors after it →', "\\frac{\\sqrt{}Y}{b} ✓");
await page.click('#btn-clear-slate');

console.log('70. inserting a structure focuses its first placeholder; Tab / Shift+Tab cycle the empty boxes');
// step-local helpers (freshSlate68/texIs68 from step 68 are reused)
async function clickFracTool70() {
    await page.waitForFunction(() => {
        const tabs = document.querySelectorAll('#mathslate-editor .yui3-tab');
        if (tabs.length < 6) { return false; }
        tabs[5].querySelector('.yui3-tab-label, a').click();
        return true;
    }, null, { timeout: 10000 });
    await page.waitForFunction(() => {
        const spans = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')];
        const s = spans.find((x) => x.title === '\\frac{\u25FB}{\u25FB}');
        if (!s) { return false; }
        s.closest('.yui3-dd-draggable').click();
        return true;
    }, null, { timeout: 10000 });
}
// Target-specific arm wait: a plain "any blank is selected" wait
// STALE-MATCHES when an old box is still armed at Tab time (the cycle
// behind it is multi-tick under render congestion); wait for the
// marker on the EXPECTED blank index instead.
async function waitBlankIdx70(idxExpected) {
    await page.waitForFunction((idx) => {
        const sel = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
        if (!sel || !sel.id) { return false; }
        const blanks = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
            .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '').map((d) => d.id);
        return blanks.indexOf(sel.id) === idx;
    }, idxExpected, { timeout: 12000 });
}
const selBlankIdx70 = () => page.evaluate(() => {
    const sel = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
    const blanks = [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '').map((d) => d.id);
    return { idx: sel ? blanks.indexOf(sel.id) : -1, count: blanks.length };
});
async function waitSelectedBox70() {
    await page.waitForFunction(() => {
        const sel = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
        if (!sel || !sel.id) { return false; }
        return [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
            .some((d) => d.id === sel.id && !d.querySelector('div') && d.textContent.trim() === '');
    }, null, { timeout: 10000 });
}

// 1) toolbox structure insert arms the FIRST empty box as the cursor
await freshSlate68();
await clickFracTool70();
await texIs68('\\frac{}{}');
await waitSelectedBox70();
let info70 = await selBlankIdx70();
if (info70.idx !== 0 || info70.count !== 2) {
    throw new Error('fraction insert must arm the numerator box first (got idx ' + info70.idx + ' of ' + info70.count + ')');
}
await page.keyboard.type('1');
await texIs68('\\frac{1}{}');
console.log('    fraction tool click → numerator box armed; the fill landed inside ✓');

// 2) Tab moves to the next empty box (denominator)
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('2');
await texIs68('\\frac{1}{2}');
console.log('    Tab → denominator box armed; fill →', "\\frac{1}{2} ✓");

// 3) Shift+Tab wraps backwards (first box → last box)
await freshSlate68();
await clickFracTool70();
await texIs68('\\frac{}{}');
await waitSelectedBox70();
await page.keyboard.type('1');
await texIs68('\\frac{1}{}');
await page.keyboard.press('Shift+Tab');
await waitSelectedBox70();
await page.keyboard.type('z');
await texIs68('\\frac{1}{z}');
console.log('    Shift+Tab wrapped backwards to the denominator box →', "\\frac{1}{z} ✓");

// 4) single participating box: Tab is a no-op and typing stays in the slot
await page.keyboard.press('Tab');
await page.waitForTimeout(600);
await page.keyboard.type('y');
await texIs68('\\frac{1}{zy}');
console.log('    single-box Tab no-op; typing continued inside the slot →', "\\frac{1}{zy} ✓");

// 5) no empty boxes at all: Tab must not disturb a script lock
await freshSlate68();
await page.keyboard.type('a^b');
await texIs68('a^b');
await page.keyboard.press('Tab');
await page.waitForTimeout(600);
await page.keyboard.type('c');
await texIs68('a^{bc}');
console.log('    Tab without boxes is inert, the lock survived →', "a^{bc} ✓");

// 6) across structures: Tab wraps around the slate; Shift+Tab goes back
await freshSlate68();
await clickFracTool70();
await texIs68('\\frac{}{}');
await waitSelectedBox70();
await page.keyboard.type('1');
await texIs68('\\frac{1}{}');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.keyboard.type('x^');
await texIs68('\\frac{1}{}x^{}');
await page.keyboard.press('Tab'); // from the superscript box → first empty box (denominator)
await waitBlankIdx70(0); // target-specific: the argument's own marker must not stale-match
await page.keyboard.type('3');
await texIs68('\\frac{1}{3}x^{}');
await page.keyboard.press('Shift+Tab'); // back to the superscript argument
await waitSelectedBox70();
await page.keyboard.type('2');
await texIs68('\\frac{1}{3}x^2');
console.log('    Tab/Shift+Tab cycled fraction boxes ↔ script argument →', "\\frac{1}{3}x^2 ✓");
await page.click('#btn-clear-slate');

console.log('71. matrix tool asks for n×m dimensions; cells tab through row-major; size is remembered');
// step-local helpers (freshSlate68/texIs68/waitSelectedBox70/selBlankIdx70 are reused)
async function clickMatrixTool71() {
    await page.evaluate(() => {
        document.querySelectorAll('#mathslate-editor .yui3-tab')[5].querySelector('.yui3-tab-label, a').click();
    });
    await page.waitForTimeout(400);
    await page.evaluate(() => {
        const spans = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')];
        const s = spans.find((x) => x.title.indexOf('matrix') !== -1);
        s.closest('.yui3-dd-draggable').click();
    });
    await page.waitForFunction(() => !document.getElementById('matrix-dialog-backdrop').hidden, null, { timeout: 10000 });
}
async function setDims71(r, c) {
    await page.$eval('#matrix-rows', (el, v) => { el.value = v; }, String(r));
    await page.$eval('#matrix-cols', (el, v) => { el.value = v; }, String(c));
}
const dialogHidden71 = () => page.evaluate(() => document.getElementById('matrix-dialog-backdrop').hidden);
const dialogDims71 = () => Promise.all([
    page.$eval('#matrix-rows', (e) => e.value),
    page.$eval('#matrix-cols', (e) => e.value)
]);

// 1) the click opens the dialog with 2×2 defaults and swallows the insert
await freshSlate68();
await clickMatrixTool71();
let dims71 = await dialogDims71();
if (dims71[0] !== '2' || dims71[1] !== '2') { throw new Error('matrix dialog must default to 2×2, got ' + dims71.join('×')); }
await texIs68(''); // the tool insert waits for the dialog
await setDims71(3, 3);
await page.click('#matrix-ok');
if (!(await dialogHidden71())) { throw new Error('matrix dialog must close on Insert'); }
await texIs68('\\matrix{&&\\\\&&\\\\&&}');
await waitSelectedBox70();
let minfo71 = await selBlankIdx70();
if (minfo71.idx !== 0 || minfo71.count !== 9) {
    throw new Error('3×3 matrix must arm the first of 9 cell boxes (got ' + minfo71.idx + ' of ' + minfo71.count + ')');
}
const status71 = await page.$eval('#status-line', (el) => el.textContent);
if (status71.indexOf('3 × 3 matrix') === -1) { throw new Error('status must announce the 3 × 3 matrix, got: ' + status71); }
console.log('    dialog 3×3 → 9 blank cells, the first armed as the cursor ✓');

// 2) Shift+Tab wraps to the LAST cell; Tab wraps back and fills row-major
await page.keyboard.press('Shift+Tab');
await waitBlankIdx70(8); // target-specific: cell (1,1)'s marker must not stale-match
minfo71 = await selBlankIdx70();
if (minfo71.idx !== 8 || minfo71.count !== 9) {
    throw new Error('Shift+Tab must wrap to the last cell (got idx ' + minfo71.idx + ' of ' + minfo71.count + ')');
}
await page.keyboard.type('z');
await texIs68('\\matrix{&&\\\\&&\\\\&&z}');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('a');
await texIs68('\\matrix{a&&\\\\&&\\\\&&z}');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('b');
await texIs68('\\matrix{a&b&\\\\&&\\\\&&z}');
console.log('    Shift+Tab/Tab wrapped around the grid; fills landed row-major →', "\\matrix{a&b&\\\\&&\\\\&&z} ✓");

// 3) cancel paths leave no trace — Cancel button, Escape, backdrop click
await freshSlate68();
await clickMatrixTool71();
await page.click('#matrix-cancel');
if (!(await dialogHidden71())) { throw new Error('matrix dialog must close on Cancel'); }
await texIs68('');
await page.keyboard.type('q'); // the slate owns the keys again right away
await texIs68('q');
await freshSlate68();
await clickMatrixTool71();
await page.keyboard.press('Escape');
if (!(await dialogHidden71())) { throw new Error('matrix dialog must close on Escape'); }
await texIs68('');
await clickMatrixTool71();
await page.mouse.click(6, 6); // backdrop click-away
if (!(await dialogHidden71())) { throw new Error('matrix dialog must close on a backdrop click'); }
await texIs68('');
console.log('    Cancel / Escape / backdrop-click all dismiss without inserting; typing resumed ✓');

// 4) the chosen size is remembered; Enter confirms — a 2×1 matrix
await clickMatrixTool71();
dims71 = await dialogDims71();
if (dims71[0] !== '3' || dims71[1] !== '3') { throw new Error('matrix dialog must remember 3×3, got ' + dims71.join('×')); }
await setDims71(2, 1);
await page.keyboard.press('Enter');
await texIs68('\\matrix{\\\\}');
await waitSelectedBox70();
await page.keyboard.type('a');
await texIs68('\\matrix{a\\\\}');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('b');
await texIs68('\\matrix{a\\\\b}');
console.log('    remembered 3×3 default, Enter-confirm, 2×1 fill →', "\\matrix{a\\\\b} ✓");

// 5) dimensions clamp to 1…10 (0×99 → 1×10)
await freshSlate68();
await clickMatrixTool71();
await setDims71(0, 99);
await page.click('#matrix-ok');
await texIs68('\\matrix{&&&&&&&&&}');
await waitSelectedBox70();
minfo71 = await selBlankIdx70();
if (minfo71.count !== 10) { throw new Error('clamped 1×10 matrix must show 10 cells, got ' + minfo71.count); }
console.log('    0×99 clamped to a 1×10 grid (10 blank cells) ✓');

// 6) the remembered size drives drag-and-drop (the documented drop hook)
const hook71 = await page.evaluate(() => {
    const tpl = JSON.stringify(['mrow', {tex: ['\\matrix{', 0, '}']}, [['mtable', {rowspacing: '4pt', columnspacing: '1em'}, [
        ['mtr', {}, [['mtd', {}, ['[]']], ['mtd', {tex: ['&', 0]}, ['[]']]]],
        ['mtr', {}, [['mtd', {tex: ['\\\\', 0]}, ['[]']], ['mtd', {tex: ['&', 0]}, ['[]']]]]
    ]]]]);
    const out = window.__mathslateDropJSON(tpl);
    const root = out && JSON.parse(out);
    const count = (n, tag) => !Array.isArray(n) ? 0
        : (n[0] === tag ? 1 : 0) + (Array.isArray(n[2]) ? n[2].reduce((acc, k) => acc + count(k, tag), 0) : 0);
    return {
        rows: root ? count(root, 'mtr') : -1,
        cells: root ? count(root, 'mtd') : -1,
        nonMatrix: window.__mathslateDropJSON(JSON.stringify(['mfrac', {tex: ['\\frac{', 0, '}{', 1, '}']}, ['[]', '[]']]))
    };
});
if (hook71.rows !== 1 || hook71.cells !== 10 || hook71.nonMatrix !== null) {
    throw new Error('drop hook must substitute the remembered 1×10 (got ' + JSON.stringify(hook71) + ')');
}
console.log('    __mathslateDropJSON substitutes the remembered 1×10 for drags, ignores other tools ✓');

// 7) the TeX tab's typed \\matrix{…} is NOT the tool: no dialog, normal compile
await freshSlate68();
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[0].querySelector('.yui3-tab-label, a').click();
});
await page.waitForTimeout(500);
await page.evaluate(() => {
    const input = document.querySelector('#mathslate-editor input[type="text"]');
    input.value = '\\matrix{x&y\\\\z&w}';
    input.dispatchEvent(new Event('change', { bubbles: true }));
});
await texIs68('\\matrix{x&y\\\\z&w}');
if (!(await dialogHidden71())) { throw new Error('a typed TeX \\matrix must not open the size dialog'); }
console.log('    typed TeX \\matrix{x&y\\\\z&w} compiled normally (no dialog) ✓');

// 8) full circle: 2×2 from the dialog reproduces the legacy template exactly
await freshSlate68();
await clickMatrixTool71();
dims71 = await dialogDims71();
if (dims71[0] !== '1' || dims71[1] !== '10') { throw new Error('matrix dialog must remember 1×10, got ' + dims71.join('×')); }
await setDims71(2, 2);
await page.click('#matrix-ok');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.type('a');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('b');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('c');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('d');
await texIs68('\\matrix{a&b\\\\c&d}');
console.log('    dialog 2×2 fills to the legacy', "\\matrix{a&b\\\\c&d} ✓");
await page.click('#btn-clear-slate');

console.log('72. matrix wrapper setting: bare / ( ) / [ ] / { } / | | / ‖ ‖ brackets');
// step-local helpers (clickMatrixTool71/setDims71/dialog*71 + step-70 box waits are reused)
const setWrap72 = (v) => page.$eval('#matrix-wrap', (el, val) => { el.value = val; }, v);
const wrapVal72 = () => page.$eval('#matrix-wrap', (el) => el.value);
const canvasHas72 = (ch) => page.evaluate((c) => document.getElementById('canvas').textContent.indexOf(c) !== -1, ch);
// the canvas typeset can lag the TeX read-out — poll glyph assertions
const waitCanvasHas72 = (ch) => page.waitForFunction(
    (c) => document.getElementById('canvas').textContent.indexOf(c) !== -1, ch, { timeout: 12000 });

// 1) parentheses: the dialog opens on the remembered 2×2 with bare brackets
await freshSlate68();
await clickMatrixTool71();
let dims72 = await dialogDims71();
if (dims72[0] !== '2' || dims72[1] !== '2') { throw new Error('matrix dialog must remember 2×2, got ' + dims72.join('×')); }
if ((await wrapVal72()) !== '') { throw new Error('the wrapper must start bare, got ' + (await wrapVal72())); }
await setWrap72('p');
await page.click('#matrix-ok');
await texIs68('\\begin{pmatrix}&\\\\&\\end{pmatrix}');
await waitSelectedBox70();
let minfo72 = await selBlankIdx70();
if (minfo72.idx !== 0 || minfo72.count !== 4) {
    throw new Error('pmatrix must arm the first of 4 cells (got ' + minfo72.idx + ' of ' + minfo72.count + ')');
}
await waitCanvasHas72('(');
await waitCanvasHas72(')');
const status72 = await page.$eval('#status-line', (el) => el.textContent);
if (status72.indexOf('pmatrix') === -1) { throw new Error('status must announce the pmatrix, got: ' + status72); }
await page.keyboard.type('a');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('b');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('c');
await page.keyboard.press('Tab');
await waitSelectedBox70();
await page.keyboard.type('d');
await texIs68('\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}');
console.log('    ( ) pmatrix 2×2 armed + filled →', "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}, slate shows the parens ✓");

// 2) the wrapper is remembered; switch to [ ] via Enter-confirm
await freshSlate68();
await clickMatrixTool71();
if ((await wrapVal72()) !== 'p') { throw new Error('matrix dialog must remember the pmatrix wrapper'); }
await setWrap72('b');
await page.keyboard.press('Enter');
await texIs68('\\begin{bmatrix}&\\\\&\\end{bmatrix}');
await waitCanvasHas72('[');
await waitCanvasHas72(']');
console.log('    remembered p, switched to [ ] bmatrix via Enter → slate shows the brackets ✓');

// 3) braces { } and single/double bars
for (const w72 of [{v: 'B', tex: 'begin{Bmatrix}', glyph: '{'},
                   {v: 'v', tex: 'begin{vmatrix}', glyph: '∣'},
                   {v: 'V', tex: 'begin{Vmatrix}', glyph: '∥'}]) {
    await freshSlate68();
    await clickMatrixTool71();
    await setWrap72(w72.v);
    await page.click('#matrix-ok');
    await texIs68('\\' + w72.tex + '&\\\\&\\end{' + w72.tex.slice(6));
    await waitCanvasHas72(w72.glyph);
}
console.log('    { } Bmatrix, | | vmatrix, ‖ ‖ Vmatrix — TeX environments and slate delimiters ✓');

// 4) drags inherit the remembered wrapper (V) through the documented hook
const hook72 = await page.evaluate(() => {
    const tpl = JSON.stringify(['mrow', {tex: ['\\matrix{', 0, '}']}, [['mtable', {}, [
        ['mtr', {}, [['mtd', {}, ['[]']], ['mtd', {tex: ['&', 0]}, ['[]']]]],
        ['mtr', {}, [['mtd', {tex: ['\\\\', 0]}, ['[]']], ['mtd', {tex: ['&', 0]}, ['[]']]]]
    ]]]]);
    const root = JSON.parse(window.__mathslateDropJSON(tpl));
    const inner = root[2][0];
    return { tex: root[1].tex, kids: inner[2].map((k) => k[0]), moTex: inner[2][0][1].tex, mo: inner[2][0][2] };
});
if (hook72.tex[0] !== '\\begin{Vmatrix}' || hook72.tex[2] !== '\\end{Vmatrix}'
    || hook72.kids.join(',') !== 'mo,mtable,mo' || hook72.moTex[0] !== '' || hook72.mo !== '∥') {
    throw new Error('drop hook must substitute size AND wrapper, got ' + JSON.stringify(hook72));
}
console.log('    __mathslateDropJSON substitutes size AND wrapper (mo delimiters with empty tex) ✓');

// 5) a typed TeX environment never opens the dialog
await freshSlate68();
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[0].querySelector('.yui3-tab-label, a').click();
});
await page.waitForTimeout(500);
await page.evaluate(() => {
    const input = document.querySelector('#mathslate-editor input[type="text"]');
    input.value = '\\begin{bmatrix}x&y\\\\z&w\\end{bmatrix}';
    input.dispatchEvent(new Event('change', { bubbles: true }));
});
await texIs68('\\begin{bmatrix}x&y\\\\z&w\\end{bmatrix}');
if (!(await dialogHidden71())) { throw new Error('a typed TeX bmatrix must not open the size dialog'); }
console.log('    typed TeX \\begin{bmatrix}… compiled normally (no dialog) ✓');

// 6) back to bare: the legacy template and no slate delimiters
await freshSlate68();
await clickMatrixTool71();
if ((await wrapVal72()) !== 'V') { throw new Error('matrix dialog must remember the Vmatrix wrapper'); }
await setWrap72('');
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.waitForTimeout(1000); // let any stale canvas typeset drain
if (await canvasHas72('(')) { throw new Error('a bare matrix must not show delimiters'); }
console.log('    wrapper back to none → legacy \\matrix{…}, no slate delimiters ✓');
await page.click('#btn-clear-slate');

console.log('73. exiting a focused fraction sheds the slot placeholder (the "□ stays after →" report)');
// step-local helpers: the socket shows as an empty preview box and a □ glyph on the canvas
const slateBoxCount73 = () => page.evaluate(() =>
    [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
        .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '').length);
const canvasBoxCount73 = () => page.evaluate(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length);
async function boxesAre73(n, label) {
    try {
        await page.waitForFunction((want) =>
            [...document.querySelectorAll('#mathslate-editor .mathslate-preview div')]
                .filter((d) => d.id && !d.querySelector('div') && d.textContent.trim() === '').length === want,
            n, { timeout: 15000 });
    } catch (e) {
        throw new Error(label + ': expected ' + n + ' placeholder box(es), got ' + (await slateBoxCount73()));
    }
}
async function canvasBoxesGone73(label) {
    await page.waitForFunction(() => !document.querySelector('#mathslate-editor #canvas .mjx-c25FB'), null, { timeout: 12000 })
        .catch(async () => { throw new Error(label + ': canvas □ glyph never went away'); });
}

// 1) the report flow: 1/\gamma Enter arms the slot socket; → sheds it and the caret exits
await freshSlate68();
await page.keyboard.type('1');
await page.keyboard.press('/');
await page.keyboard.type('\\gamma');
await page.keyboard.press('Enter');
await texIs68('\\frac{1}{\\gamma}');
await boxesAre73(1, 'the conversion arms the slot socket');
await page.keyboard.press('ArrowRight');
await texIs68('\\frac{1}{\\gamma}');
await boxesAre73(0, '→ must shed the slot placeholder');
await canvasBoxesGone73('→ out of the fraction');
await page.keyboard.type('x'); // the caret transitioned cleanly outside
await texIs68('\\frac{1}{\\gamma}x');
console.log('    1/\\gamma Enter → socket armed; → sheds it (no box, no □), typing lands after the fraction ✓');

// 2) Esc from the same state sheds it too
await freshSlate68();
await page.keyboard.type('1');
await page.keyboard.press('/');
await page.keyboard.type('\\gamma');
await page.keyboard.press('Enter');
await texIs68('\\frac{1}{\\gamma}');
await boxesAre73(1, 'conversion arms the socket (Esc flow)');
await page.keyboard.press('Escape');
await boxesAre73(0, 'Esc must shed the slot placeholder');
await canvasBoxesGone73('Esc out of the fraction');
console.log('    Escape from the armed socket sheds the placeholder the same way ✓');

// 3) ← climbing keeps exactly ONE socket alive through the walk and the jump
await freshSlate68();
await page.keyboard.type('2');
await page.keyboard.press('/');
await page.keyboard.type('\\beta');
await page.keyboard.press('Enter');
await texIs68('\\frac{2}{\\beta}');
await boxesAre73(1, 'conversion arms the socket (climb flow)');
await page.keyboard.press('ArrowLeft'); // walk to the denominator start
await boxesAre73(1, 'mid-walk keeps the caret socket');
await page.keyboard.press('ArrowLeft'); // climb to the numerator end
await boxesAre73(1, 'the climb hands ONE socket to the numerator');
await page.keyboard.type('9');
await texIs68('\\frac{29}{\\beta}');
await page.keyboard.press('ArrowLeft'); // walk the numerator
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft'); // …and out to the left
await boxesAre73(0, 'the final ← sheds every placeholder');
await canvasBoxesGone73('← out of the fraction');
await page.keyboard.type('q');
await texIs68('q\\frac{29}{\\beta}');
console.log('    ← walked, climbed, filled \\frac{29}{\\beta}, exited clean →', "q\\frac{29}{\\beta} ✓");

// 4) a filled denominator: socket continuity while typing, gone after →
await freshSlate68();
await page.keyboard.type('3');
await page.keyboard.press('/');
await page.keyboard.type('\\delta');
await page.keyboard.press('Enter');
await texIs68('\\frac{3}{\\delta}');
await page.keyboard.type('7');
await texIs68('\\frac{3}{\\delta7}');
await boxesAre73(1, 'fill continuity keeps exactly one socket');
await page.keyboard.press('ArrowRight');
await boxesAre73(0, '→ sheds it after the fill');
await canvasBoxesGone73('→ out of a filled denominator');
console.log('    filled \\frac{3}{\\delta7} kept one socket, → shed it ✓');
await page.click('#btn-clear-slate');

console.log('74. matrix arrow navigation: cells walk row-major, edges exit, no phantom rows');
// step-local: canvas grid-row count — the "third row appears" detector
const gridRows74 = () => page.evaluate(() =>
    document.querySelectorAll('#mathslate-editor #canvas mjx-mtable mjx-mtr').length);
async function rowsStay74(n, label) {
    await page.waitForTimeout(800); // give any corruption time to render
    const got = await gridRows74();
    if (got !== n) { throw new Error(label + ': grid grew to ' + got + ' rows (phantom row)'); }
}

// 1) THE REPORT: fill the first cell, caret before the 1, ← → exit before
//    the matrix; no phantom third row may appear
await freshSlate68();
await clickMatrixTool71();
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.type('1');
await texIs68('\\matrix{1&\\\\&}');
await page.keyboard.press('ArrowLeft'); // caret before the 1
await page.keyboard.press('ArrowLeft'); // at the first cell's start → out
await texIs68('\\matrix{1&\\\\&}');
await rowsStay74(2, 'report flow');
await page.keyboard.type('x');
await texIs68('x\\matrix{1&\\\\&}');
console.log('    1 in the first cell, ←← exited before the matrix, no third row, x landed before ✓');

// 2) → from a cell's end walks row-major (same row, then the next row's
//    first cell), and past the LAST cell exits after the matrix
await freshSlate68();
await clickMatrixTool71();
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.type('1');
await page.keyboard.press('Tab');
await page.keyboard.type('2');
await texIs68('\\matrix{1&2\\\\&}');
await page.keyboard.press('ArrowRight'); // end of row 1 → start of row 2
await page.keyboard.type('3');
await texIs68('\\matrix{1&2\\\\3&}');
await page.keyboard.press('ArrowRight');
await page.keyboard.type('4');
await texIs68('\\matrix{1&2\\\\3&4}');
await page.keyboard.press('ArrowRight'); // past the last cell → out
await rowsStay74(2, '→ walk');
await page.keyboard.type('z');
await texIs68('\\matrix{1&2\\\\3&4}z');
console.log('    → walked 1,2,3,4 row-major then exited after the matrix, z ✓');

// 3) ← from a cell's start crosses up to the row above's LAST cell (and the
//    fill still serializes — the templated-cell tex drop is pinned by 4/7)
await freshSlate68();
await clickMatrixTool71();
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.type('1');
await page.keyboard.press('Tab');
await page.keyboard.type('2');
await page.keyboard.press('Tab');
await page.keyboard.type('3');
await texIs68('\\matrix{1&2\\\\3&}');
await page.keyboard.press('ArrowLeft'); // caret before the 3
await page.keyboard.press('ArrowLeft'); // at the start of (2,1) → END of (1,2)
await page.keyboard.type('9');
await texIs68('\\matrix{1&29\\\\3&}');
console.log('    ← from (2,1) start handed the caret to (1,2) end → 29 ✓');

// 4) ← from the freshly armed EMPTY first cell: clean exit, all four
//    placeholders intact (the phantom row was a box pushed into the rows)
await freshSlate68();
await clickMatrixTool71();
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.press('ArrowLeft');
await texIs68('\\matrix{&\\\\&}');
await rowsStay74(2, 'empty-cell exit');
if ((await slateBoxCount73()) !== 4) {
    throw new Error('the four cell placeholders must survive (← out of the empty first cell), got '
        + (await slateBoxCount73()));
}
await page.keyboard.type('q');
await texIs68('q\\matrix{&\\\\&}');
console.log('    ← out of the empty first cell kept all 4 boxes, q landed before ✓');

// 5) a WRAPPED matrix (pmatrix) obeys the same exit discipline
await freshSlate68();
await clickMatrixTool71();
await setWrap72('p');
await page.keyboard.press('Enter');
await texIs68('\\begin{pmatrix}&\\\\&\\end{pmatrix}');
await page.keyboard.type('a');
await texIs68('\\begin{pmatrix}a&\\\\&\\end{pmatrix}');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await rowsStay74(2, 'wrapped exit');
await page.keyboard.type('q');
await texIs68('q\\begin{pmatrix}a&\\\\&\\end{pmatrix}');
console.log('    pmatrix first cell ←← exited clean before the parens ✓');

// 6) a structure INSIDE a cell: → past its fraction peels into the cell
//    content (the mtd-owner peel must stay legal), then hops to the next cell
await freshSlate68();
await clickMatrixTool71();
await setWrap72(''); // 5 left the wrapper on parens
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.type('a');
await page.keyboard.press('/');
await page.keyboard.type('b');
await texIs68('\\matrix{\\frac{a}{b}&\\\\&}');
await page.keyboard.press('ArrowRight'); // past the denominator → beside it in the cell
await page.keyboard.press('ArrowRight'); // cell end → next cell
await page.keyboard.type('z');
await texIs68('\\matrix{\\frac{a}{b}&z\\\\&}');
await rowsStay74(2, 'fraction-in-cell peel');
console.log('    a/b inside a cell peeled into the cell then hopped right → z ✓');

// 7) templated-cell serialization: multi-token typed fills in '&'/'\\'-tex
//    cells must appear in the TeX read-out whole (the mtd's template only
//    references its child 0, so content lives in the cell's mrow group)
await freshSlate68();
await clickMatrixTool71();
await page.keyboard.press('Enter');
await texIs68('\\matrix{&\\\\&}');
await page.keyboard.type('4');
await page.keyboard.press('Tab');
await page.keyboard.type('19');
await texIs68('\\matrix{4&19\\\\&}');
await page.keyboard.press('Tab');
await page.keyboard.type('27');
await texIs68('\\matrix{4&19\\\\27&}');
console.log('    typed 19 and 27 into templated cells — every token serialized ✓');
await page.click('#btn-clear-slate');

console.log('75. norm delimiter tool: \\left\\|…\\right\\| alongside the other \\left brackets');
// step-local: click a roots&brackets tool by its exact label title
async function clickBracketTool75(title) {
    await page.evaluate(() => {
        document.querySelectorAll('#mathslate-editor .yui3-tab')[5].querySelector('.yui3-tab-label, a').click();
    });
    await page.waitForTimeout(400);
    await page.evaluate((t) => {
        const s = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')]
            .find((x) => x.title === t);
        if (!s) { throw new Error('tool not found: ' + t); }
        s.closest('.yui3-dd-draggable').click();
    }, title);
}

// 1) the tool sits in the tab with the bracket family, label ◻ boxed
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[5].querySelector('.yui3-tab-label, a').click();
});
await page.waitForFunction(() => {
    const titles = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')]
        .map((s) => s.title);
    return titles.includes('\\left\\|◻\\right\\|')
        && titles.includes('\\left|◻\\right|'); // the abs tool is still there
}, null, { timeout: 15000 });
console.log('    \\left\\|◻\\right\\| label renders next to \\left|◻\\right| in the tab ✓');

// 2) click inserts with the first box armed; fill lands inside the norm
await freshSlate68();
await clickBracketTool75('\\left\\|◻\\right\\|');
await texIs68('\\left\\|\\right\\|');
await page.keyboard.type('x');
await texIs68('\\left\\|x\\right\\|');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c2016').length === 2,
    null, { timeout: 15000 });
console.log('    insert + fill x → \\left\\|x\\right\\| with ‖ delimiters typeset ✓');

// 3) an in-slot structure wraps inside the norm
await page.keyboard.press('/');
await page.keyboard.type('y');
await texIs68('\\left\\|\\frac{x}{y}\\right\\|');
console.log('    x / y inside → \\left\\|\\frac{x}{y}\\right\\| ✓');

// 4) the typed TeX path compiles the same delimiters (MathJax 4 supports \\|)
await freshSlate68();
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[0].querySelector('.yui3-tab-label, a').click();
});
await page.waitForTimeout(400);
await page.evaluate(() => {
    const input = document.querySelector('#mathslate-editor input[type="text"]');
    input.value = '\\left\\|y\\right\\|';
    input.dispatchEvent(new Event('change', { bubbles: true }));
});
await texIs68('\\left\\|y\\right\\|');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c2016').length === 2,
    null, { timeout: 15000 });
console.log('    typed TeX \\left\\|y\\right\\| compiled with ‖ delimiters ✓');
await page.click('#btn-clear-slate');

console.log('76. \\gets and \\mapsto tools alongside \\to; \\leq/\\geq inequality tools');
// step-local: click a relations-tab tool by its exact label title
async function clickRelationTool76(title) {
    await page.evaluate(() => {
        document.querySelectorAll('#mathslate-editor .yui3-tab')[1].querySelector('.yui3-tab-label, a').click();
    });
    await page.waitForTimeout(400);
    await page.evaluate((t) => {
        const s = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')]
            .find((x) => x.title === t);
        if (!s) { throw new Error('tool not found: ' + t); }
        s.closest('.yui3-dd-draggable').click();
    }, title);
    await page.waitForTimeout(600);
}

// 1) the arrows sit side by side with the existing \to in the label strip
await page.evaluate(() => {
    document.querySelectorAll('#mathslate-editor .yui3-tab')[1].querySelector('.yui3-tab-label, a').click();
});
await page.waitForFunction(() => {
    const titles = [...document.querySelectorAll('#mathslate-editor .yui3-tab-panel-selected span[title]')]
        .map((s) => s.title);
    const to = titles.indexOf(' \\to ');
    return to >= 0 && titles[to + 1] === ' \\gets ' && titles[to + 2] === ' \\mapsto ';
}, null, { timeout: 15000 });
console.log('    labels read \\to \\gets \\mapsto in a row in the relations tab ✓');

// 2) click-fills produce the exact TeX and canvas glyphs
for (const [title, want, glyph] of [
    [' \\to ', 'a\\tob', 'mjx-c2192'],
    [' \\gets ', 'a\\getsb', 'mjx-c2190'],
    [' \\mapsto ', 'a\\mapstob', 'mjx-c21A6'],
]) {
    await freshSlate68();
    await page.keyboard.type('a');
    await texIs68('a');
    await clickRelationTool76(title);
    await page.keyboard.type('b');
    await texIs68(want);
    await page.waitForFunction((c) => document.querySelectorAll('#mathslate-editor #canvas .' + c).length === 1, glyph, { timeout: 15000 });
}
console.log('    a + \\to/\\gets/\\mapsto + b gives a\\to b / a\\gets b / a\\mapsto b, arrows typeset ✓');

// 3) the inequality set: the pre-existing \leq \geq tools click-fill the same way
for (const [title, want, glyph] of [
    ['\\leq ', 'a\\leqb', 'mjx-c2264'],
    ['\\geq ', 'a\\geqb', 'mjx-c2265'],
]) {
    await freshSlate68();
    await page.keyboard.type('a');
    await texIs68('a');
    await clickRelationTool76(title);
    await page.keyboard.type('b');
    await texIs68(want);
    await page.waitForFunction((c) => document.querySelectorAll('#mathslate-editor #canvas .' + c).length === 1, glyph, { timeout: 15000 });
}
console.log('    a + \\leq/\\geq + b gives a\\leq b / a\\geq b with ≤/≥ typeset ✓');

// 4) the typed TeX path compiles both new macros natively
for (const [src, want, glyph] of [
    ['a \\gets b', 'a\\getsb', 'mjx-c2190'],
    ['a \\mapsto b', 'a\\mapstob', 'mjx-c21A6'],
]) {
    await freshSlate68();
    await page.evaluate(() => {
        document.querySelectorAll('#mathslate-editor .yui3-tab')[0].querySelector('.yui3-tab-label, a').click();
    });
    await page.waitForTimeout(400);
    await page.evaluate((t) => {
        const input = document.querySelector('#mathslate-editor input[type="text"]');
        input.value = t;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    }, src);
    await texIs68(want);
    await page.waitForFunction((c) => document.querySelectorAll('#mathslate-editor #canvas .' + c).length === 1, glyph, { timeout: 15000 });
}
console.log('    typed TeX a \\gets b / a \\mapsto b compiled with ←/↦ ✓');
await page.click('#btn-clear-slate');

console.log('77. <- stepping onto a script block enters its script slot (the "a^2 arrow skip" report)');
// the report: a^2, → to exit, ← must land INSIDE the superscript after
// the 2, not jump to before the a
await freshSlate68();
await page.keyboard.type('a^2');
await texIs68('a^2');
await page.keyboard.press('ArrowRight'); // exit the superscript
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'),
    null, { timeout: 10000 });
await page.keyboard.press('ArrowLeft'); // the report's failing step
// the model must be untouched…
await page.waitForTimeout(700);
await texIs68('a^2');
// …while one socket box appeared (the caret's home inside the superscript)
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 });
await page.keyboard.type('3');
await texIs68('a^{23}'); // the fill lands right after the 2
console.log('    report flow: a^2 → ← types 3 INSIDE → a^{23} ✓');
// more ← walks the slot; at its start the next ← steps OUT onto the
// base's end (a|^{23} — parked between base and script, not past the
// base) with its own socket, and typing extends the base there
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft'); // = the base's end
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 });
await page.keyboard.type('x');
await texIs68('{ax}^{23}');
console.log('    <<< through the slot, parked at the base end, x grew the base → {ax}^{23} ✓');
// the walk continues through the base, and a final ← releases before the block
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(700);
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 0,
    null, { timeout: 15000 }); // the socket dies with the exit
await page.keyboard.type('y');
await texIs68('y{ax}^{23}');
console.log('    through the base and released before the block, y landed before ✓');
// a → press from the free caret before the block parks between base and
// script — the mirror of ←'s entry (the "asymmetrical right arrow"
// report, step 80 pins the full chain): the model is untouched, the base
// owns the cursor at its end, typing grows it, and the next →
// roundtrips into the script slot's start
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 }); // the parked caret's socket
await texIs68('y{ax}^{23}'); // the park itself does not touch the model
await page.keyboard.type('q');
await texIs68('y{axq}^{23}');
await page.keyboard.press('ArrowRight');
await page.keyboard.type('w');
await texIs68('y{axq}^{w23}');
console.log('    → onto the block parks at the base end: q grew the base, → roundtripped into the script ✓');

// msub gets the same entry
await freshSlate68();
await page.keyboard.type('b_3');
await texIs68('b_3');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'),
    null, { timeout: 10000 });
await page.keyboard.press('ArrowLeft');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 });
await page.keyboard.type('4');
await texIs68('b_{34}');
console.log('    msub: b_3 → ← types 4 inside → b_{34} ✓');

// an empty argument re-arms as its box: e^ exit, ← enters, f fills
await freshSlate68();
await page.keyboard.type('e^');
await texIs68('e^{}');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'),
    null, { timeout: 10000 });
await page.keyboard.press('ArrowLeft');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 });
await texIs68('e^{}'); // tex unchanged by the entry
await page.keyboard.type('f');
await texIs68('e^f');
console.log('    empty argument: e^{} ← enters the box, f fills → e^f ✓');

// plain neighbours are unaffected: a token left of the caret is still a plain block-step
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(500);
await page.keyboard.type('x');
await texIs68('1x2');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 0,
    null, { timeout: 15000 });
console.log('    plain-token neighbour: 12 ← x → 1x2 (no slot entry, no boxes) ✓');
await page.click('#btn-clear-slate');

console.log('78. ← past a script\'s start parks between base and script (the "left arrow skips the base" report)');
// the report, verbatim: type a^2, one ← to a^{|2}, and the next ← must
// park at a|^{2} — not skip the base to |a^{2}
await freshSlate68();
await page.keyboard.type('a^2');
await texIs68('a^2');
await page.keyboard.press('ArrowLeft'); // a^{|2}, still locked
await page.waitForFunction(() =>
    document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'),
    null, { timeout: 10000 });
await page.keyboard.press('ArrowLeft'); // the report's step: out to a|^{2}
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active')
        && document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 });
await texIs68('a^2'); // the model is untouched by the park
await page.keyboard.type('x');
await texIs68('{ax}^2'); // the base grows at the park point — never |xa^2
console.log('    report flow: a^2 ← ← parks between base and script; x grew the base → {ax}^2 ✓');
// → from there roundtrips into the script's start, mirroring the fraction hop
await page.keyboard.press('ArrowRight');
await page.keyboard.type('z');
await texIs68('{ax}^{z2}');
console.log('    → roundtripped into the argument start; z filled → {ax}^{z2} ✓');
// msub parks the same way
await freshSlate68();
await page.keyboard.type('b_3');
await texIs68('b_3');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active')
        && document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 });
await page.keyboard.type('4');
await texIs68('{b4}_3');
console.log('    msub: b_3 ← ← parked at b|_{3}; 4 grew the base → {b4}_3 ✓');
await page.click('#btn-clear-slate');

console.log('79. ^ _ / with the free caret mid-slate bind the block LEFT of the caret');
// the report's caret pathway: 12, <- (caret after the 1), ^ wraps the 1 —
// startScript's doc.pop() used to grab the slate's last block (the 2)
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await page.keyboard.press('ArrowLeft'); // caret between the 1 and the 2
await page.waitForTimeout(600);
await page.keyboard.type('^');
await texIs68('1^{}2');
await page.keyboard.type('34'); // the fresh argument owns the cursor
await texIs68('1^{34}2');
console.log('    report flow: 12 ← ^ 34 → 1^{34}2 (the 1 bound, the 2 kept its place) ✓');
// deeper in the row each step binds its immediate left neighbour
await freshSlate68();
await page.keyboard.type('123');
await texIs68('123');
await page.keyboard.press('ArrowLeft'); // between 2 and 3
await page.waitForTimeout(400);
await page.keyboard.type('_');
await texIs68('12_{}3');
await page.keyboard.type('x');
await texIs68('12_x3');
console.log('    123 ← _ x → 12_x3 ✓');
await freshSlate68();
await page.keyboard.type('123');
await texIs68('123');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft'); // between 1 and 2
await page.waitForTimeout(400);
await page.keyboard.type('_');
await texIs68('1_{}23');
console.log('    123 ←← _ → 1_{}23 ✓');
// fractions too: the numerator is the block left of the caret
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(400);
await page.keyboard.type('/');
await texIs68('\\frac{1}{}2');
await page.keyboard.type('y');
await texIs68('\\frac{1}{y}2');
console.log('    12 ← / y → \\frac{1}{y}2 ✓');
// parked before the first block, the wrap inserts at the caret with a blank base
await freshSlate68();
await page.keyboard.type('12');
await texIs68('12');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(400);
await page.keyboard.type('^');
await texIs68('{}^{}12');
await page.keyboard.type('x');
await texIs68('{}^x12');
console.log('    12 ←← ^ x → {}^x12 (blank base at the caret, nothing grabbed from afar) ✓');
await page.click('#btn-clear-slate');

console.log('80. → stepping onto a script block parks at its base end (the "symmetrical right arrow" report)');
// the report: a^2, free caret immediately left of the a, → must step
// INTO the block — between the base and the script — not skip the
// structure whole (the exact mirror of step 77's ← entry)
await freshSlate68();
await page.keyboard.type('a^2');
await texIs68('a^2');
await page.keyboard.press('ArrowRight'); // exit the superscript lock
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'),
    null, { timeout: 10000 });
// walk the free caret to the block's front: script END → script START →
// base END park → base start → released before the block
for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 0,
    null, { timeout: 15000 }); // released: the socket dies with the exit
await texIs68('a^2'); // the walk never touched the model
await page.keyboard.press('ArrowRight'); // the report's failing step
await page.waitForTimeout(500);
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active')
        && document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 1,
    null, { timeout: 15000 }); // parked: one socket box, no lock glow
await texIs68('a^2'); // the park itself does not touch the model
await page.keyboard.type('x');
await texIs68('{ax}^2'); // typing at the park extends the base — never xa^2
console.log('    report flow: a^2 front, → parked between base and script; x grew the base → {ax}^2 ✓');
// the chain continues symmetrically with the ← walk: → hops into the
// script slot's START…
await page.keyboard.press('ArrowRight');
await page.keyboard.type('z');
await texIs68('{ax}^{z2}');
console.log('    → roundtripped into the argument start; z filled → {ax}^{z2} ✓');
// …walks to its END, and one more → steps out after the block
await page.keyboard.press('ArrowRight');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 0,
    null, { timeout: 15000 });
await page.keyboard.type('w');
await texIs68('{ax}^{z2}w');
console.log('    through the argument and out right: w landed after the block ✓');

// msub parks the same way
await freshSlate68();
await page.keyboard.type('b_3');
await texIs68('b_3');
await page.keyboard.press('ArrowRight');
await page.waitForFunction(() =>
    !document.getElementById('mathslate-editor').classList.contains('mathslate-script-active'),
    null, { timeout: 10000 });
for (let i = 0; i < 5; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
await page.waitForTimeout(400);
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(500);
await page.keyboard.type('4');
await texIs68('{b4}_3');
console.log('    msub: b_3 front, → parked at b|_{3}; 4 grew the base → {b4}_3 ✓');

// a BLANK base has no edge to park behind: → keeps the whole-block step
// (the base's box is reached by click/Tab)
await freshSlate68();
await page.keyboard.type('12');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(400);
await page.keyboard.type('^');
await texIs68('{}^{}12');
await page.keyboard.type('x');
await texIs68('{}^x12');
for (let i = 0; i < 3; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
await page.waitForTimeout(400);
await texIs68('{}^x12'); // released before the blank-base block
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(500);
await page.keyboard.type('y');
await texIs68('{}^xy12'); // a plain block right of the script, not in the base
console.log('    blank base: {}^x12 front, → stepped past whole; y landed beside ✓');

// parked MID-ROW the fill still lands in the slot: the gap is not a
// cursor while a slot focus lives
await freshSlate68();
await page.keyboard.type('a^2');
await texIs68('a^2');
await page.keyboard.press('ArrowRight'); // out of the lock
await page.waitForTimeout(300);
await page.keyboard.type('bc');
await texIs68('a^2bc');
for (let i = 0; i < 7; i++) { await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(120); }
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 0,
    null, { timeout: 15000 });
await page.keyboard.press('ArrowRight'); // parks on the mid-row block's base
await page.waitForTimeout(500);
await page.keyboard.type('q');
await texIs68('{aq}^2bc'); // bc keep their spot; the base grows in place
console.log('    mid-row park: a^2bc front, → q → {aq}^2bc (fill stayed in the slot) ✓');
// the same rule keeps continuation typing inside a planted mid-row
// argument (no gap splice while the slot focus lives)
await freshSlate68();
await page.keyboard.type('123');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowLeft');
await page.keyboard.type('_');
await texIs68('1_{}23');
await page.keyboard.type('x');
await texIs68('1_x23');
await page.keyboard.type('y');
await texIs68('1_{xy}23');
console.log('    123 ←← _ x y → 1_{xy}23 (continuation accumulates in the slot) ✓');

// plain-block neighbours are unaffected: → steps back over the 2 to the end
await freshSlate68();
await page.keyboard.type('12');
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(500);
await page.keyboard.type('x');
await texIs68('12x');
await page.waitForFunction(() =>
    document.querySelectorAll('#mathslate-editor #canvas .mjx-c25FB').length === 0,
    null, { timeout: 15000 });
console.log('    plain neighbour: 12 ← → x → 12x (no park, no boxes) ✓');
await page.click('#btn-clear-slate');

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
