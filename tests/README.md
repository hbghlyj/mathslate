# Headless end-to-end test (optional dev tooling)

Loads the app in headless Chromium (via `playwright-core`), lets the toolbox render,
clicks tools, exercises Insert/Copy/Clear, the TeX input tab, help, undo, export and
the `file://` boot path. Keyboard coverage includes the literal character set, the
`^` / `_` / `/` TeX triggers, and the `\` TeX-command placeholder's three states:
activation with cursor lock (arrow keys captured), the active wrapper visuals
(marker class, highlighted monospace token, dashed cursor outline), and closing by
any non-letter (`Space`, `Enter`, symbols) — upon which the name is parsed into
real math through the toolbox TeX tool's own pipeline (unknown names degrade to a
literal token, covered too) — plus the in-structure regression: with a fraction's
denominator box selected, `\` opens the command box **inside** the denominator and
conversion re-arms in place (`\frac{1}{\beta+}` never leaves the fraction) — plus
a check that clicking the bare preview background cannot crash the upstream click
delegate. It also checks the blinking caret (presence at the end of the slate, blink
animation, hiding on selection/over-focus, reappearing on Esc), the `<`/`>`
navigation buttons and arrow-key caret stepping (mid-slate anchoring, edits landing
at the caret), script-block retention (multi-character super/subscripts with the
cursor locked inside, released only by `→`/`Space`/`Enter`/`Esc`), replace-on-selection
typing, the Backspace-does-not-navigate audit, and single-char script unbracing.
It also covers the slot-focus behaviour end to end: a `+` typed immediately after an
in-slot macro conversion stays inside the fraction; `\` after a slot-variable opens
the box inside the slot; characters/`\`/`+` keep accumulating inside a focused slot;
`^`, `_` and `/` wrap and fill inside it; in-slot Backspace semantics (delete in the
slot, step out at empty); and the explicit focus exits (Esc → top-level typing).
It also covers the intra-slot caret: arrows walk between a focused/locked slot's
tokens (chars insert at the caret, Backspace deletes left of it), and a `^` pressed
mid-slot inside a locked script block hatches ON the token left of the caret
(`1^23` `←` `^` → `1^{2^{}3}`, typing keeps accumulating in the fresh inner
argument) while a trigger at the slot's end keeps the newest-wins whole-block
nesting (`1/2/3` → `\frac{\frac{1}{2}}{3}`).
and a `\` pressed while a
script block is locked opens the command box **inside** the block's slot
(`e^i` `\` `pi` `Enter` → `e^{i\pi}`, typing continues inside), and filling
a macro/toolbox structure's app-armed box (`\sqrt` `Enter` `12`) keeps the
focus inside so digits accumulate (`\sqrt{12}`, `\frac{12}{}`) until an
explicit exit. The last two steps pin the slot caret and nested
navigation directly: after `\sqrt` `Space` `b^2` the blinking caret stays
alive and anchored inside the superscript slot (typing continues in the
exponent: `\sqrt{b^{24}}`), and `→` peels exactly one slot level out
(`\sqrt{b^{24}}` parks the caret after `b^{24}` *inside* the radical, so
`-` yields `\sqrt{b^{24}-}`; the next `→` leaves to the slate — `←` peels
leftwards the same way).
Step 60 reloads the page and checks launch behaviour: the TeX
tool's input must not hold DOM focus, the bare page body must not either —
the slate CANVAS itself is `document.activeElement` from launch
(`tabindex="-1"`, focused at boot) — and the launch caret hugs the decoy
box inside `#canvas` (absolute anchor; the empty slate's MathJax
container is block-level, so an in-flow caret would wrap down into the
preview panel). `\sqrt` `Space` `b` typed with no
click lands on the slate with the caret anchored inside the radical, and a
slate mousedown hands DOM focus back to the slate canvas from the field.
Step 61 checks that an arrow out of an ARMED-BUT-EMPTY script
block (`e^` then `→`/←, before any fill) cancels the pending script and
re-anchors the caret at the top level — after the block for `→` (`x`
continues as `e^{}x`), before the block for `←` (`x` lands as `xe^{}`) —
where the caret used to vanish for the rest of the session.
The final step replays the `\sqrt{b^2}` report: while the superscript
slot is focused it shows exactly one placeholder box (the caret's
socket), `→` out of it CLOSES that box (no stray box behind the 2; the
radicand keeps the live focus), releasing to the slate leaves zero
placeholder boxes, and Esc with a focused slot closes its socket too.
62 numbered steps, green under MathJax 4.1 (CHTML) with no console/page errors.

    cd tests
    npm install            # installs playwright-core + @sparticuz/chromium
    npx playwright-core install chromium --with-deps
    cd .. && python3 -m http.server 8123 &
    cd tests && BASE=http://127.0.0.1:8123 node e2e.mjs

`launch.mjs` (shared by `e2e.mjs`, `shot2.mjs`, `shot3.mjs`) launches a
Playwright-managed chromium when present and otherwise falls back to the
`@sparticuz/chromium` npm binary — with its bundled Amazon-Linux shared
libs extracted on demand — for sandboxes where the Playwright browser CDN
is unreachable. The app itself is fully self-contained (everything under
`vendor/`), so no other network access is required to run the suite.

## MathJax 4 timing notes

MathJax 4 typesets asynchronously (Promise-based, fonts fetched as on-demand
CHTML chunks), so the suite never assumes a render is visible right after a
mutation: it waits on the TeX read-out (`#current-tex`, driven by the app's
250 ms poll) and on DOM markers. In particular, after clicking a drop-shim to
select a slate box, the `.mathslate-selected` marker only appears once the
post-click typeset finishes — steps poll for it before typing (a fast script
that types immediately would race the marker). Glyph assertions accept both
the literal codepoint (v2, e.g. `α` U+03B1) and the math-italic codepoint v4
CHTML renders (`𝛼` U+1D6FC; `𝛽` U+1D6FD, `𝛾` U+1D6FE).

`shot3.mjs` regenerates `../docs/screenshot.png` (keyboard-only demo ending on
an active `\` placeholder); `shot1.png` is the diagnostic frame the e2e run
drops at the end.
