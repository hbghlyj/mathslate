/*
 * app.js — standalone glue for the Mathslate editor.
 *
 * In the TinyMCE plugin, the dialogue page (mathslate.html) reached the host
 * editor through `top.tinymce.activeEditor.windowManager.getParams()` and
 * returned the TeX through that bridge. Here there is no host editor:
 * this script owns the "document" the math is inserted into.
 *
 * Document model: the source of truth is the <textarea id="document-source">
 * (plain text with \( ... \) / \[ ... \] TeX delimiters). The rendered pane
 * (#document-area) is a MathJax-typeset view regenerated from the source.
 *
 * Standalone wrapper: same GPL v3 license as Mathslate itself.
 */
(function () {
    'use strict';

    var editor = null;          // M.tinymce_mathslate.Editor instance
    var typesetTimer = null;    // debounce handle for re-rendering

    function $(id) { return document.getElementById(id); }

    function status(message, sticky) {
        var line = $('status-line');
        line.textContent = message || '';
        line.classList.remove('flash');
        if (message && !sticky) {
            // restart the CSS fade-out animation
            void line.offsetWidth;
            line.classList.add('flash');
        }
    }

    /* ------------------------------------------------------------------ *
     * Boot: wait until YUI, MathJax and the Mathslate modules are ready. *
     * ------------------------------------------------------------------ */

    function boot() {
        if (!window.YUI || !window.MathJax || !MathJax.Hub) {
            return setTimeout(boot, 100);
        }
    YUI().use('moodle-tinymce_mathslate-editor', 'moodle-tinymce_mathslate-textool',
            function (Y) {
                // Initial whole-page typeset, as in the original dialogue page,
                // so the loading notice, toolbar glyphs and toolbox render.
                MathJax.Hub.Queue(['Typeset', MathJax.Hub]);
                // Inline JSON config keeps the app XHR-free (works from file://).
                editor = new M.tinymce_mathslate.Editor('#mathslate-editor',
                    M.tinymce_mathslate.configJSON);
                wireEquationTools();
                wireKeyboard();
            });
    }

    /* ------------------------------------------------------- *
     * Equation → document wiring (the former TinyMCE bridge). *
     * ------------------------------------------------------- */

    // Braces around single-character script arguments AND around standalone
    // single-character bases are both redundant in TeX (only multi-token
    // content needs them): two passes rewrite just the braced one-character
    // shapes the editor emits — script arguments {x}^{2} -> {x}^2, then
    // single-character bases {a}^2 -> a^2, so {a}^{2} + {b}^{2} displays as
    // a^2 + b^2. Multi-token content keeps its braces — {e}^{2x} -> e^{2x}
    // (the argument stays braced) — and ^{}, ^{\\alpha} and ^{\\frac{}{}}
    // are untouched, as is a macro base: {\\alpha}^2 stays braced so the
    // command name can never bleed into a following superscript.
    function prettyTeX(tex) {
        return tex
            .replace(/([_^])\{\s*([^\s{}\\])\s*\}/g, '$1$2')
            .replace(/\{\s*([^\s{}\\])\s*\}\s*([_^])/g, '$1$2');
    }

    function currentTeX() {
        // editor.mje.output() is available right after construction; the
        // Editor.output() alias only appears once the toolbox finishes loading.
        try {
            return (editor && editor.mje) ? prettyTeX(editor.mje.output('tex')) : '';
        } catch (e) {
            return '';
        }
    }

    /* ---------------- Blinking fake caret (the slate's cursor) ----------
     *
     * A simulated visual cursor: while the slate is "focused" (the user is
     * interacting with the editor, not typing into a text control, and the
     * window itself has focus) and NOTHING on the slate is selected, a
     * blinking span marks exactly where the next keystroke lands. Two modes:
     *  - free: parked between two top-level blocks (gap 0..N) or after the
     *    last one — the < and > buttons (and the arrow keys) step it one
     *    block at a time, and typing splices in AT it;
     *  - locked: anchored inside a script block (a^{2|}), right where the
     *    next character of the script goes, until an explicit exit;
     *  - slot: anchored inside the focused structure's slot (\\sqrt{b^{2|}}),
     *    hugging the token/box at the intra-slot caret, until an explicit
     *    exit peels one nesting level out.
     * It vanishes the moment a snippet or box is selected, a macro box owns
     * the cursor, or focus truly moves elsewhere (a fresh box — armed but
     * not yet filled — is itself the selection, and is the cursor).
     * Anchored carets are absolutely positioned beside the live drop-shim
     * of their anchor token, in the shim's own offset space, so they track
     * MathJax re-renders on every poll tick.
     */
    var caretEl = null;         // the blinking span, while attached
    var slateFocused = true;    // app-level focus: false while a form control holds it
    var caret = {gap: 0, scriptGap: 0}; // free: gap between blocks; locked: gap in the slot
    // modelBlocks — the NUMBER of top-level blocks on the slate, tracked
    // authoritatively: updated at every mutation site (inserts, splices,
    // rebuilds, undos). The preview DOM cannot rule this (renders lag, so
    // its row count is frequently stale — fatal to caret/insert ordering
    // under MathJax 4): the DOM is only read back into modelBlocks by the
    // 250 ms poll, and only while the typeset queue is quiet (queueQuiet).
    var modelBlocks = 0;

    // True while no render/typeset task is queued or running: the only
    // moment the preview DOM (rows, shims, selection markers) may be
    // treated as current. See js/mathjax4-shim.js (Hub.isQuiet).
    function queueQuiet() {
        return window.MathJax && MathJax.Hub && typeof MathJax.Hub.isQuiet === 'function'
            ? MathJax.Hub.isQuiet()
            : true;
    }

    function caretWanted() {
        return slateFocused && document.hasFocus()
            && !macroState.active
            && (!script.awaiting || script.locked)
            && !hasSlateSelection();
    }

    // Where the caret should sit right now: null → the classic end-of-slate
    // in-flow position; undefined → unresolvable THIS tick (a render is in
    // flight — hold the last position instead of jumping to the end, which
    // would look exactly like the caret left the structure it lives in);
    // otherwise {shim, trailing} for the drop-shim span it hugs (leading or
    // trailing edge of the anchor token).
    function caretAnchor() {
        if (slotFocus.active) {
            // The focused structure slot always keeps a trailing box, whose
            // canvas element (blankIds() pre-order must match the model
            // scan — bookmarkSlot keeps both sides off the same read) is
            // climbed through its single-child mrow wrappers to the slot's
            // rendered container. There the box's wrapper is the LAST
            // child, so tokens index from the end — immune to any leading
            // wrappers MathJax adds — and the box's own leading edge is
            // the slot's end-of-caret position.
            var bid = blankIds()[slotFocus.boxIdx];
            var bEl = bid && document.querySelector('#mathslate-editor #canvas [id="' + bid + '"]');
            if (bEl) {
                var slotEl = bEl.parentElement;
                while (slotEl && slotEl.children.length === 1) {
                    var sp = slotEl.parentElement;
                    if (!sp || sp.tagName.toLowerCase() !== 'mjx-mrow') { break; }
                    slotEl = sp;
                }
                if (slotEl) {
                    var kids = slotEl.children;
                    var tn = slotFocus.tokCount;
                    if (kids.length > tn) { // tn tokens + the box's wrapper
                        var sk = Math.min(Math.max(slotFocus.caretIdx, 0), tn);
                        return {el: kids[kids.length - 1 - (tn - sk)], trailing: false};
                    }
                }
            }
            return undefined; // render lag: hold the position
        }
        if (script.locked) {
            if (!script.slot.length) { return null; } // armed box is the cursor
            var j = scriptGap();
            var toks = slotTokenSpans();
            if (toks.length !== script.slot.length) { return null; } // render lag
            return j >= toks.length
                ? {el: toks[toks.length - 1], trailing: true}
                : {el: toks[j], trailing: false};
        }
        var ids = blockIds();
        var m = ids.length;
        // Clamp LOCALLY — never write back: the rows come from the preview
        // DOM, which lags the model while renders are in flight; shrinking
        // caret.gap here would corrupt the next keystroke's position.
        var g = Math.max(0, Math.min(caret.gap, m));
        if (!m || g >= m) { return null; }
        var nshim = findShim(ids[g]);
        return nshim ? {el: nshim, trailing: false} : null;
    }

    // (Re)attach or remove the caret to match caretWanted(), and re-anchor
    // it. An end-parked caret stays in-flow as the canvas's last child (new
    // items append to its LEFT). An anchored caret absolutely tracks its
    // anchor shim: positioned in the shim's offsetParent's coordinate space.
    function refreshCaret() {
        var canvas = document.querySelector('#mathslate-editor #canvas');
        if (!canvas) { return; }
        if (!caretWanted()) {
            if (caretEl) {
                if (caretEl.parentNode) { caretEl.parentNode.removeChild(caretEl); }
                caretEl = null;
            }
            return;
        }
        // A re-render rewrote the canvas's contents wholesale (MathJax 4
        // replaces the host's innerHTML): the in-flow caret died with it.
        if (caretEl && !caretEl.parentNode) { caretEl = null; }
        var anchor = caretAnchor();
        if (typeof anchor === 'undefined') { return; } // hold last position
        if (!caretEl) {
            caretEl = document.createElement('span');
            caretEl.className = 'mathslate-caret';
            caretEl.setAttribute('aria-hidden', 'true');
        }
        if (!anchor) {
            caretEl.removeAttribute('style');
            if (caretEl.parentNode !== canvas || canvas.lastElementChild !== caretEl) {
                canvas.appendChild(caretEl);
            }
            return;
        }
        // Rect-based absolute positioning in document space: works for the
        // overlay drop-shims and for the canvas's MathJax output elements
        // alike, and survives MathJax re-renders as the 250 ms poll
        // re-reads the rects.
        var r = anchor.el.getBoundingClientRect();
        if (!r.width && !r.height) { return; } // mid-removal; try next tick
        if (caretEl.parentNode !== document.body) { document.body.appendChild(caretEl); }
        caretEl.style.position = 'absolute';
        caretEl.style.margin = '0';
        caretEl.style.zIndex = '10';
        caretEl.style.left = ((anchor.trailing ? r.right : r.left) - 1 + window.scrollX) + 'px';
        caretEl.style.top = (r.top + window.scrollY) + 'px';
        caretEl.style.height = r.height + 'px';
    }

    // MathJax rewrites the canvas on every render; re-anchor the caret
    // afterwards. Re-appending is guarded, so the observer cannot loop on
    // its own mutation.
    function watchCanvasCaret() {
        var canvas = document.querySelector('#mathslate-editor #canvas');
        if (!canvas || watchCanvasCaret.done) { return; }
        watchCanvasCaret.done = true;
        new MutationObserver(function () {
            // Only the end-parked in-flow caret is re-anchored here (renders
            // rewrite the canvas's child list). Anchored carets live on
            // document.body and are repositioned by the poll tick.
            if (caretEl && caretWanted() && !caretEl.style.position
                && canvas.lastElementChild !== caretEl) {
                canvas.appendChild(caretEl); // re-append even if detached
            }
        }).observe(canvas, {childList: true});
    }

    // Track app-level focus for the caret: any real text control counts as
    // leaving the slate (the document textarea, the TeX tool's input…);
    // buttons, the slate itself and plain areas count as the slate.
    // Take DOM focus back from any form control that is holding it. The
    // workspace's key routing is document-level but deliberately ignores
    // keys aimed at inputs (isFormTarget) — so while a form control holds
    // focus (the TeX field, the document textarea), those keys land
    // THERE, not on the slate. Interacting with the editor must reclaim
    // DOM focus: Chromium blurs a focused input on an outside click, but
    // not every browser does — and none of them does it at launch.
    function blurFormFocus() {
        var ae = document.activeElement;
        if (ae && isFormTarget(ae) && ae.blur) { ae.blur(); }
    }

    // Hand DOM focus to the SLATE element itself (the canvas). Merely
    // blurring every form control leaves document.activeElement on the
    // page body — "the main workspace gains focus at launch", as the
    // report put it; the slate should be the focus owner instead. The
    // canvas gets tabindex="-1" (programmatically focusable, not a new
    // tab stop), and focus() is guarded + preventScroll so boot never
    // jumps the page. Key routing is document-level and accepts any
    // non-form target, so typing is unaffected; browsers without
    // div-focus-on-click (Safari) get the same state via this call.
    function focusSlate() {
        var slateEl = document.querySelector('#mathslate-editor #canvas');
        if (!slateEl) { return; }
        if (!slateEl.hasAttribute('tabindex')) {
            slateEl.setAttribute('tabindex', '-1');
        }
        if (document.activeElement !== slateEl && slateEl.focus) {
            try { slateEl.focus({ preventScroll: true }); }
            catch (e) { slateEl.focus(); }
        }
    }

    function wireCaretFocus() {
        watchCanvasCaret();
        document.addEventListener('focusin', function (e) {
            slateFocused = !isFormTarget(e.target);
            refreshCaret();
        });
        document.addEventListener('mousedown', function (e) {
            if (e.target.closest && e.target.closest('#mathslate-editor')) {
                // A real click or drag inside the editor is the user's own
                // cursor placement: it lets a locked script block go. And
                // it reclaims DOM focus from any form control (the TeX
                // field stays focused across outside clicks on some
                // browsers — and would keep swallowing keystrokes).
                if (script.locked) { exitScript(); }
                if (!isFormTarget(e.target)) { blurFormFocus(); focusSlate(); }
                slateFocused = true;
                refreshCaret();
            }
        });
        // Normalize launch focus: nothing (a restored form field, a
        // browser autofocus quirk, construction-time focusing) should own
        // DOM focus before the user has chosen a target — and the SLATE,
        // not the page body, is that target from the start.
        blurFormFocus();
        focusSlate();
        window.addEventListener('blur', refreshCaret);
        window.addEventListener('focus', refreshCaret);
        window.addEventListener('scroll', refreshCaret);
    }

    // Caret glow while a drag hovers the end-of-slate drop zone (the canvas
    // already appends such drops at the end — the caret's position).
    function wireCaretDropGlow() {
        if (!editor || !editor.mje || !editor.mje.canvas) { return; }
        editor.mje.canvas.on('drop:enter', function () {
            if (caretEl) { caretEl.classList.add('mathslate-caret-hot'); }
        });
        var cool = function () {
            if (caretEl) { caretEl.classList.remove('mathslate-caret-hot'); }
        };
        editor.mje.canvas.on('drop:exit', cool);
        editor.mje.canvas.on('drop:hit', cool);
    }

    function wireEquationTools() {
        var texField = $('current-tex');
        var last = null;

        wireCaretFocus();
        wireCaretDropGlow();
        wireAddMathCounter();
        refreshCaret();
        // Keep the TeX read-out in sync with the slate (and re-evaluate the
        // caret: slate-internal selection changes reach us only by polling).
        setInterval(function () {
            var tex = currentTeX();
            if (tex !== last) {
                last = tex;
                texField.value = tex;
            }
            // An edit we did NOT route through the caret grew the slate at
            // the end (palette drop, TeX tool, macro conversion, undo…):
            // the caret follows there (and a stale script lock gives way).
            // But only reconcile with the DOM once the queue has drained:
            // mid-render the preview rows are OLD news — modelBlocks is
            // the truth (and every app edit maintains it).
            if (!queueQuiet()) { refreshCaret(); return; }
            var m = snippetCount();
            if (m !== modelBlocks) {
                if (script.locked) { cancelScript(); } // external edit took over
                else if (!macroState.active) { caret.gap = m; }
                modelBlocks = m;
            }
            // The programmatic-arm record lives only while the marker it
            // produced is visible; a user re-click anywhere moves the
            // marker to a NEW blank index (insertChar tells them apart).
            if (macroSlotIndex() === -1) { programmaticArmIdx = -1; }
            // The focus dies with its structure (external undo/clear/drops).
            if (slotFocus.active && slotFocus.top >= m) { clearSlotFocus(); }
            refreshCaret();
        }, 250);

        // < and > buttons: step the fake caret one position (the arrow keys
        // enqueue the same events). Clicks are whitelisted in the
        // outside-mousedown listener so they never cancel a script lock.
        $('btn-nav-left').addEventListener('click', function () {
            enqueue({type: 'nav', value: -1});
        });
        $('btn-nav-right').addEventListener('click', function () {
            enqueue({type: 'nav', value: 1});
        });
        $('btn-insert-inline').addEventListener('click', function () {
            insertEquation(false);
        });
        $('btn-insert-display').addEventListener('click', function () {
            insertEquation(true);
        });
        $('btn-copy-tex').addEventListener('click', function () {
            var tex = requireTeX();
            if (!tex) { return; }
            copyText(tex, function (ok) {
                status(ok ? 'TeX copied to the clipboard.'
                          : 'Copy failed — your browser blocked clipboard access.');
            });
        });
        $('btn-clear-slate').addEventListener('click', function () {
            if (editor && editor.mje) {
                cancelScript();
                macroReset();
                inputQueue.length = 0;
                resumeInput();
                editor.mje.clear();
                caret.gap = 0;
                modelBlocks = 0;
                status('Slate cleared.');
            }
        });
    }

    function requireTeX() {
        var tex = currentTeX().trim();
        if (!tex) {
            status('Build an equation on the slate first (click a symbol in the toolbox).');
        }
        return tex;
    }

    /* ------------------------------------------------------- *
     * Direct keyboard entry of the literal character set,     *
     * plus TeX-style ^ (superscript) and _ (subscript)        *
     * triggers. "^" binds to the preceding token and turns    *
     * the slate "x" into a real "msup[x, □]", selects the     *
     * script box and routes the next character into it —      *
     * so x^23 gives x^{2}3, exactly as TeX would.              *
     * ------------------------------------------------------- */

    // Map a printable character to a Mathslate snippet (same shapes as
    // config.json: mi identifiers, mn numbers, mo operators). "-" uses the
    // real minus (U+2212) with a TeX override, exactly like the palette tool.
    // "^", "_", "/" and "\" are deliberately NOT here; they are structural
    // triggers (script / fraction / macro, see startScript and startMacro).
    function charToSnippetJSON(ch) {
        var node = null;
        if (ch >= '0' && ch <= '9') {
            node = ['mn', {}, ch];
        } else if (ch === '.') {
            node = ['mn', {}, ch];
        } else if (/^[a-zA-Z]$/.test(ch)) {
            node = ['mi', {}, ch];
        } else if (ch === '-') {
            node = ['mo', {tex: ['-']}, '−'];
        } else if ('+*=()[],;:!?|<>'.indexOf(ch) !== -1) {
            node = ['mo', {}, ch];
        }
        // Ignored on purpose: space, quotes and TeX-specials { } $ % # & ~ @
        return node ? JSON.stringify(node) : null;
    }

    function hasSlateSelection() {
        return !!document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
    }

    function deselectSlate() {
        // Trigger the editor's own click handler: clears the selection in
        // the model and schedules the re-render. The DOM marker, however,
        // only goes away WITH that render — nowhere near fast enough under
        // MathJax 4, when the render pipeline lags whole keystrokes behind.
        // The class is what the core's insert/clear paths consult, so a
        // stale marker would misroute the very next model edit (as if the
        // ghost selection were still armed): scrub it synchronously.
        var canvas = document.querySelector('#mathslate-editor #canvas');
        if (canvas) { canvas.click(); }
        scrubSelection();
    }

    // Id of the last empty "blank" box (leaf div in the slate's TeX preview
    // panel — blanks render to nothing but a <br>, so their text is empty).
    function lastBlankId() {
        var ids = blankIds();
        return ids.length ? ids[ids.length - 1] : null;
    }

    function blankIds() {
        var divs = document.querySelectorAll('#mathslate-editor .mathslate-preview div');
        var ids = [];
        for (var i = 0; i < divs.length; i++) {
            if (divs[i].id && !divs[i].querySelector('div')
                && divs[i].textContent.trim() === '') {
                ids.push(divs[i].id);
            }
        }
        return ids;
    }

    // The clickable drop-shim carrying a given snippet id (the same id also
    // appears on MathJax output spans inside the canvas; the shim is the
    // absolutely-positioned overlay one).
    function findShim(id) {
        var nodes = document.querySelectorAll('#mathslate-editor span[id="' + id + '"]');
        for (var i = 0; i < nodes.length; i++) {
            if (getComputedStyle(nodes[i]).position === 'absolute') {
                return nodes[i];
            }
        }
        return null;
    }

    function pollUntil(cond, cb, maxTicks, giveUp) {
        var n = 0;
        (function tick() {
            if (n++ >= (maxTicks || 100)) { // default ~5 s
                if (giveUp) { giveUp(); }
                return;
            }
            if (cond()) { cb(); return; }
            setTimeout(tick, 50);
        })();
    }

    /* Script-trigger state + the input queue that feeds it.
     *
     * everything the user types is pushed through a FIFO so that fast and
     * slow keystrokes produce identical slates: a ^/_ trigger is processed
     * asynchronously (rebuild slate → click the script box → arm), and the
     * pump blocks until the box is armed, so characters typed meanwhile
     * still land in the right place in the right order. Classification
     * (macro letter vs terminator vs literal, backspace/escape routing)
     * happens in the pump at dequeue time — never in the keydown handler —
     * so a slow async step (script arming, macro conversion) cannot
     * desync fast typing from the state it belongs to.
     *
     * script.awaiting — a script trigger was pressed; input belongs to it
     * script.armed    — the fresh (still empty) box is selected in the slate
     * script.locked   — the box is filled; the cursor is LOCKED inside the
     *                   block (characters keep accumulating there) until an
     *                   explicit exit: → past the edge, Space, Enter or Esc
     * script.kind     — which trigger owns the lock (^, _ or /)
     * script.gen      — generation counter, invalidated on cancel/timeout so
     *                   stale async callbacks can never resurrect dead state */
    // script.base/script.slot: the CONTENT of the locked block, tracked
    // app-side as parsed snippet arrays — the live model cannot be read
    // without corrupting it, so the app owns this shadow copy.
    var script = {awaiting: false, armed: false, locked: false, kind: null,
        base: null, slot: [], gen: 0};
    var inputQueue = [];
    var inputBusy = false;

    function cancelScript() {
        script.awaiting = false;
        script.armed = false;
        script.locked = false;
        script.kind = null;
        script.base = null;
        script.slot = [];
        script.gen++;
        setScriptActiveClass(false);
        refreshCaret();
    }

    function resumeInput() {
        inputBusy = false;
        pumpInput();
    }

    function enqueue(evt) {
        inputQueue.push(evt);
        pumpInput();
    }

    function pumpInput() {
        if (inputBusy) { return; }
        var evt = inputQueue[0];
        if (!evt) { return; }
        if (evt.type === 'char') {
            if (macroState.active) {
                if (/^[a-zA-Z]$/.test(evt.value)) { // names are letters (as in TeX)
                    inputQueue.shift();
                    macroType(evt.value); // undo+append, always safe
                    pumpInput();
                    return;
                }
                // Any non-letter closes the box first; the character itself
                // is reprocessed afterwards — strictly after the conversion.
                inputQueue.unshift({type: 'macro-end'});
                pumpInput();
                return;
            }
            if (script.awaiting && !script.armed && !script.locked) {
                inputBusy = true; // box not clickable yet; arm callback resumes
                return;
            }
            inputQueue.shift();
            if (charToSnippetJSON(evt.value)) {
                insertChar(evt.value); // selection/caret/script-lock aware
                if (script.awaiting && script.armed) {
                    // First fill of a fresh box: the cursor LOCKS inside the
                    // script block (a^2 → cursor after the 2, inside a^{|}).
                    script.armed = false;
                    script.locked = true;
                    script.slot = [JSON.parse(charToSnippetJSON(evt.value))];
                    caret.scriptGap = Number.MAX_SAFE_INTEGER; // = end of slot
                    setScriptActiveClass(true);
                }
                refreshCaret();
            } // unsupported characters are simply dropped
            pumpInput();
            return;
        }
        if (evt.type === 'macro-start') {
            if (macroState.active) {
                // "\" typed inside an open box: close that box, then open
                // the new one — the pending start stays queued behind.
                inputQueue.unshift({type: 'macro-end'});
                pumpInput();
                return;
            }
            inputQueue.shift();
            // \\ pressed while the caret sits INSIDE a locked script block
            // (e^i, then \\): the command box belongs INSIDE the block's
            // slot (→ e^{i\\pi}), not at the top level. Hand the block's
            // slot to the slot-focus machinery exactly like the ^ _ /
            // mid-slot triggers do.
            if (script.awaiting && script.locked && script.slot.length) {
                var lockGapM = scriptGap(); // cancelScript resets the slot
                cancelScript();
                slotFocus.active = true;
                slotFocus.top = modelBlocks - 1; // a locked block is last
                slotFocus.path = [2, 1, 2]; // [base, mrow{slot}] → content
                slotFocus.caretIdx = lockGapM;
                slotFocus.boxIdx = -1; // socket re-bookmarked by the follow-up
                slotFocus.tokCount = 0;
                startMacroAtFocus();
                pumpInput();
                return;
            }
            if (script.awaiting) { cancelScript(); } // adjacent triggers: newest wins
            startMacro(); // state-machine driven, never blocks the pump
            pumpInput();
            return;
        }
        if (evt.type === 'backspace') {
            inputQueue.shift();
            if (macroState.active) { macroBackspace(); pumpInput(); return; }
            if (script.locked) { scriptBackspace(); pumpInput(); return; }
            cancelScript();
            // The caret lives inside a structure slot: delete there, not
            // the whole block behind it.
            if (slotFocus.active && !hasSlateSelection() && backspaceInSlot()) { pumpInput(); return; }
            // mje.clear() deletes the selected snippet, but empties the
            // whole slate when nothing is selected — use undo there instead
            // (every inserted char is exactly one undo step). On an already
            // empty slate, do nothing: an undo there would "revive"
            // previously cleared content, which nobody expects. With the
            // caret parked mid-slate, Backspace deletes the block to its LEFT.
            if (hasSlateSelection()) {
                editor.mje.clear();
            } else if (caret.gap < modelBlocks) {
                var left = topItems();
                if (caret.gap > 0) {
                    left.splice(caret.gap - 1, 1);
                    rebuildSlate(left); // sets modelBlocks = items.length
                    caret.gap--;
                }
            } else if (modelBlocks > 0) {
                editor.mje.undo();
                modelBlocks--;
                // The deleted block sat left of the caret; the caret stays
                // at the (new) end. Without this it would hover one past
                // the slate (gap > modelBlocks), and the first < press
                // would only waste itself on the clamp.
                caretEnd();
            }
            pumpInput();
            return;
        }
        if (evt.type === 'escape') {
            inputQueue.shift();
            if (macroState.active) {
                inputQueue.unshift({type: 'macro-end'}); // close through the same path
                pumpInput();
                return;
            }
            cancelScript();
            if (hasSlateSelection()) { deselectSlate(); }
            if (slotFocus.active) { // Esc lets the slot go: close its box too
                var escItems = topItems();
                stripSlotAnchorBox(resolveSlotArr(escItems));
                rebuildSlate(escItems);
            }
            clearSlotFocus();
            pumpInput();
            return;
        }
        if (evt.type === 'macro-end') {
            inputQueue.shift();
            if (!macroState.active) { pumpInput(); return; } // no box open: no-op
            // finishMacro converts the name through the TeX tool (async):
            // it resumes the pump only once the converted node is in place,
            // so a queued terminator (digit, ^, …) always lands behind the
            // finished macro node, never before it.
            inputBusy = true;
            finishMacro();
            return;
        }
        if (evt.type === 'script-exit') { // Space/Enter let the cursor out
            inputQueue.shift();
            exitScript();
            pumpInput();
            return;
        }
        if (evt.type === 'nav') { // < > buttons and ←/→ arrow keys
            inputQueue.shift();
            if (!macroState.active) {
                if (slotFocus.active) {
                    // An arrow first moves the caret INSIDE the slot (between
                    // its tokens); only at an edge does the press step out —
                    // and even then it peels exactly ONE nesting level: a
                    // focused slot buried inside another structure's slot
                    // hands the focus to that enclosing slot, parked beside
                    // the structure it just left (\\sqrt{b^{2|}} → \\sqrt{b^2|}
                    // keeps typing INSIDE the radical: \\sqrt{b^2-}). Only a
                    // slot hanging directly off a top-level block releases
                    // the caret to the slate beside that block.
                    var navItems = topItems();
                    var navArr = resolveSlotArr(navItems);
                    var navTok = navArr ? slotTokenIndices(navArr) : [];
                    var navCi = Math.min(Math.max(slotFocus.caretIdx, 0), navTok.length);
                    if (navArr && ((evt.value === -1 && navCi > 0)
                        || (evt.value === 1 && navCi < navTok.length))) {
                        slotFocus.caretIdx = navCi + evt.value;
                        rebuildSlate(navItems); // heal the destructive read
                    } else {
                        var parent = navArr ? parentSlotOf(navItems, navArr) : null;
                        if (parent) {
                            stripSlotAnchorBox(navArr); // close the exited slot
                            ensureSlotBox(parent.arr);
                            slotFocus.path = parent.path;
                            slotFocus.caretIdx = parent.before + (evt.value === 1 ? 1 : 0);
                            bookmarkSlot(navItems, parent.arr);
                            rebuildSlate(navItems); // heal the destructive read
                        } else {
                            var at = slotFocus.top;
                            stripSlotAnchorBox(navArr); // close the exited slot
                            clearSlotFocus();
                            rebuildSlate(navItems); // heal the destructive read
                            caret.gap = Math.max(0, Math.min(evt.value === -1 ? at : at + 1, modelBlocks));
                        }
                    }
                    refreshCaret();
                } else {
                    moveCaret(evt.value);
                }
            } // macro lock wins
            pumpInput();
            return;
        }
        // 'script' trigger (^, _ or /)
        inputQueue.shift();
        // ^ _ / pressed while the caret sits MID-SLOT inside a locked
        // script block, behind one of its tokens (1^23, ←, ^): the
        // structure belongs INSIDE the block, wrapped around the token
        // left of the internal caret (→ 1^{2^{}3}) — never a new block
        // around the whole expression (the {{1}^{23}}^{} mis-wrap). Hand
        // the block's slot to the slot-focus machinery at the lock's caret
        // position and let its in-slot trigger path do the wrap and re-arm
        // the argument. A caret at the slot's END keeps the classic
        // newest-wins wrap (1/2/3 → \frac{\frac{1}{2}}{3}).
        if (script.awaiting && script.locked && script.slot.length
            && scriptGap() > 0 && scriptGap() < script.slot.length) {
            var lockGap = scriptGap(); // cancelScript resets the lock's slot
            cancelScript();
            slotFocus.active = true;
            slotFocus.top = modelBlocks - 1; // a locked block is the last one
            slotFocus.path = [2, 1, 2]; // [base, mrow{slot}] → slot content
            slotFocus.caretIdx = lockGap;
            slotFocus.boxIdx = -1; // socket re-bookmarked by startStructureAtFocus
            slotFocus.tokCount = 0;
            inputBusy = true; // arming the fresh argument box resumes the pump
            startStructureAtFocus(evt.value);
            return;
        }
        if (script.awaiting) { cancelScript(); } // adjacent triggers: newest wins
        if (macroState.active) {
            // A script arriving while the box is open closes it first, then
            // re-runs: the converted macro node becomes the script's base.
            inputQueue.unshift({type: 'script', value: evt.value});
            inputQueue.unshift({type: 'macro-end'});
            pumpInput();
            return;
        }
        if (slotFocus.active && !hasSlateSelection()) { // ^ _ / with a caret inside a structure slot
            inputBusy = true; // arming the fresh argument box resumes the pump
            startStructureAtFocus(evt.value);
            return;
        }
        inputBusy = true; // startScript's async arming resumes the pump
        startScript(evt.value);
    }

    // TeX-style binding triggers: `^` → msup, `_` → msub, `/` → mfrac. The
    // preceding token becomes base/numerator, then the cursor LOCKS inside
    // the block: characters keep accumulating (a^23 → a^{23}) until an
    // explicit navigation command — → (arrow key or > button), Space, Enter
    // or Esc — lets it out. Templates from the toolbox config.
    var JOBS = {
        '^': {tag: 'msup',  tex: [' { ', 0, ' }^{ ', 1, ' } '], marker: '^{}'},
        '_': {tag: 'msub',  tex: [' { ', 0, ' }_{ ', 1, ' } '], marker: '_{}'},
        '/': {tag: 'mfrac', tex: ['\\frac{', 0, '}{', 1, '}'],  marker: '}{}'}
    };

    function startScript(kind) {
        var job = JOBS[kind];
        if (!job) { resumeInput(); return; }
        var mje = editor.mje;
        if (hasSlateSelection()) { deselectSlate(); }
        // Clean top-level snippets ('[]' marks blanks, ids stripped; the
        // editor re-issues ids and blanks when we feed the snippets back).
        var doc;
        try {
            doc = JSON.parse(mje.output('JSON'));
        } catch (err) {
                doc = [];
        }
        if (!Array.isArray(doc)) { doc = []; }
        var base = doc.pop();
        if (typeof base === 'undefined') { base = '[]'; } // empty slate: blank base
        var node = [job.tag, {tex: job.tex}, [base, '[]']];
        // Rebuild: wipe (this also pushes an undo state), re-add the prefix,
        // then the script node. Each addMath is one normal undo step.
        // Snapshot blanks present before the rebuild (e.g. the decoy
        // placeholder of a just-cleared slate): they linger in the DOM
        // until MathJax re-renders and must never be clicked as the box.
        var staleBlanks = blankIds();
        mje.clear();
        doc.forEach(function (item) { mje.addMath(JSON.stringify(item)); });
        mje.addMath(JSON.stringify(node));
        modelBlocks = doc.length + 1; // base popped, node pushed: net zero
        script.awaiting = true;
        script.armed = false;
        script.locked = false; // the lock only begins when the box is filled
        script.kind = kind;
        script.base = base;
        script.slot = [];
        caretEnd(); // the rebuilt script node sits at the slate's end
        var gen = ++script.gen;
        refreshCaret();
        // After MathJax re-renders, click the new script box so the next
        // character is inserted inside it (insert-before-blank is how the
        // editor fills boxes); arm once the selection is visible.
        // Arm only when the slate's TeX shows the finished script node AND
        // the box shim exists: intermediate renders (right after the slate
        // was wiped) briefly show a placeholder box that would swallow a
        // fast typist's next character.
        pollUntil(function () {
            var tex = currentTeX().replace(/\s+/g, '');
            if (tex.slice(-job.marker.length) !== job.marker) { return false; }
            var id = lastBlankId();
            return !!(id && staleBlanks.indexOf(id) === -1 && findShim(id));
        }, function () {
            if (script.gen !== gen) { return; }
            var shim = findShim(lastBlankId());
            armProgrammatic++;
            programmaticArmIdx = blankIds().length - 1; // armed the LAST box
            if (shim) { shim.click(); }
            pollUntil(hasSlateSelection, function () {
                armProgrammatic--;
                if (script.gen !== gen) { resumeInput(); return; }
                script.armed = true;
                resumeInput();
            }, 200, function () {
                armProgrammatic--;
                if (script.gen === gen) { cancelScript(); }
                resumeInput();
            });
        }, 300, resumeInput); // arming failed → just continue at top level
    }

    // Is the currently selected slate node a fill-box (blank), not content?
    function selectedNodeIsBlank() {
        var sel = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
        if (!sel || !sel.id) { return false; }
        return blankIds().indexOf(sel.id) !== -1;
    }

    // Insert one character at the cursor, everywhere it can be:
    //  * the cursor is locked inside a script block: the character goes
    //    into the block at the internal caret (scriptType);
    //  * a fill-box (blank) is selected (a fresh, still empty script box):
    //    the character fills the box (insert-before-blank, the editor's
    //    native box fill);
    //  * a real snippet is selected: the character REPLACES it entirely,
    //    then the selection is dropped and the caret parks at the end;
    //  * the caret is parked between blocks: the character is spliced in at
    //    the caret, which moves right past it;
    //  * caret at the end (the default): plain append, left of the caret.
    function insertChar(ch) {
        var json = charToSnippetJSON(ch);
        if (!json) { return; }
        if (script.locked && !script.armed) {
            scriptType(ch);
            status('', true);
            return;
        }
        var replace = hasSlateSelection() && !selectedNodeIsBlank();
        if (replace) {
            // Replace the selected top-level block with the typed token,
            // spliced in BY POSITION (the same heal pattern as the macro
            // paths). The obvious core pair — addMath (insert before the
            // selection) followed by clear (delete the selected snippet) —
            // resolves the selection through the live DOM marker, but
            // addMath's own render() re-keys every model id synchronously
            // while the marker refresh waits on the MathJax queue. That
            // raced even the near-synchronous MathJax 2 queue; under
            // MathJax 4's asynchronous typeset the clear half ALWAYS reads
            // a stale id and silently no-ops (leaving "zab" instead of
            // "zb"). The preview rows line up with topItems() exactly (one
            // row per top-level block — mid-slate blanks never outlive a
            // render), so the selected row's index is the splice point.
            var rows = document.querySelectorAll('#mathslate-editor .mathslate-preview > div');
            var ridx = -1;
            for (var ri = 0; ri < rows.length; ri++) {
                if (rows[ri].id && rows[ri].classList.contains('mathslate-selected')) { ridx = ri; break; }
            }
            deselectSlate(); // before any heal: core clear() eats selections
            var ritems = topItems();
            if (ridx >= 0 && ridx < ritems.length) {
                ritems.splice(ridx, 1, json);
                rebuildSlate(ritems); // sets modelBlocks = items.length
            } else {
                editor.mje.addMath(json); // marker vanished — plain append
                modelBlocks++;
            }
            caretEnd();
        } else if (!hasSlateSelection() && caret.gap < modelBlocks) {
            var items = topItems();
            items.splice(caret.gap, 0, json);
            rebuildSlate(items); // sets modelBlocks = items.length
            caret.gap++;
        } else {
            // gate: an armed fill-box is a NATIVE slot fill (no top-level
            // growth); everything else here appends a new top-level block.
            var intoBox = hasSlateSelection() && selectedNodeIsBlank();
            // A USER-clicked box is different from an app-armed one (the
            // app knows the blank INDEX it armed: the marker's index equals
            // programmaticArmIdx exactly while that arm's marker lives):
            // filling it must plant the durable slot focus, or the cursor
            // context vanishes with the box (the "\\ after a variable"
            // bug). Surgery, not DOM — synchronous and watcher-free, so an
            // immediate keystroke cannot fall through to the native path.
            var fillSi = macroSlotIndex();
            if (intoBox && fillSi !== -1 && fillSi !== programmaticArmIdx && armProgrammatic === 0) {
                if (fillClickedSlot(json, fillSi)) { status('', true); refreshCaret(); return; }
            }
            // Continuation typing while a slot focus lives: the token is
            // spliced at the intra-slot caret (the "+" bug — works with or
            // without the re-armed box marker ever having appeared).
            if (!intoBox && slotFocus.active) {
                insertCharInSlot(json);
                status('', true);
                refreshCaret();
                return;
            }
            editor.mje.addMath(json); // into the armed box, or appended at end
            if (intoBox) {
                // The fill consumed the box: the render-time rekey removed
                // the blank from the now multi-item slot — synchronously,
                // inside mje.addMath's own render() call — but the DOM
                // marker only dies when MathJax 4's asynchronous typeset
                // finishes. Scrub the stale marker and drop the core's
                // dangling selection NOW: the next keystroke must go after
                // the block (one token per box), never before a
                // no-longer-existent blank id (a silent no-op insert).
                scrubSelection();
                deselectSlate();
                programmaticArmIdx = -1; // the armed box's marker died just now
                // The app arms boxes only as the focused slot's own
                // continuation (conversion/trailing re-arms) while a slot
                // focus lives — top-level arms happen with the focus off by
                // pump routing. So this native fill landed right before the
                // focused slot's trailing box: the slot's END. The intra-slot
                // caret (a pure closure counter) must follow the fill there,
                // or the next continuation keystroke would splice mid-slot
                // (y ending up before +). The filled blank itself is already
                // rekeyed away, so count AFTER the fill.
                if (slotFocus.active) {
                    var fitems = topItems(); // destructive read, healed below
                    var fArr = resolveSlotArr(fitems);
                    if (fArr) {
                        ensureSlotBox(fArr); // the fill consumed it
                        slotFocus.caretIdx = slotTokenIndices(fArr).length;
                        bookmarkSlot(fitems, fArr);
                    }
                    rebuildSlate(fitems); // heal regardless
                } else if (fillSi !== -1 && !script.awaiting) {
                    // An app-armed box outside a script lock is a
                    // macro-converted or toolbox-inserted STRUCTURE slot
                    // (\\sqrt's radicand, \\frac's numerator): the user
                    // is clearly inside a structure — plant the durable
                    // slot focus there, or the very next digit would drop
                    // out after the block (\\sqrt 1 2 came out as
                    // \\sqrt{1}2 instead of \\sqrt{12}). The filled box
                    // itself is rekeyed away, so the slot is located by
                    // the token just appended to it; plain end-of-slate
                    // appends match nothing and keep the classic release.
                    var pitems = topItems(); // destructive read, healed below
                    var loc = locateSlotEndingWith(pitems, JSON.parse(json));
                    if (loc) {
                        ensureSlotBox(loc.arr); // the fill consumed it
                        slotFocus.active = true;
                        slotFocus.top = loc.top;
                        slotFocus.path = loc.path;
                        slotFocus.caretIdx = slotTokenIndices(loc.arr).length;
                        bookmarkSlot(pitems, loc.arr);
                    }
                    rebuildSlate(pitems); // heal regardless
                }
            } else {
                modelBlocks++;
            }
            caretEnd();
        }
        status('', true);
        refreshCaret();
    }

    // Remove the selection marker from the DOM right away: the editor's
    // insert path checks that class, but MathJax re-renders (and rebuilds
    // the shim that carries it) are asynchronous — a stale marker would
    // swallow the next keystroke into a no-longer-existent slot.
    function scrubSelection() {
        var sel = document.querySelectorAll('#mathslate-editor .mathslate-selected');
        for (var i = 0; i < sel.length; i++) { sel[i].classList.remove('mathslate-selected'); }
    }

    // The "active script wrapper" for a locked script block (see app.css):
    // #mathslate-editor carries this marker class for the whole retention
    // phase; CSS draws the lock glow. Removed again on exit.
    function setScriptActiveClass(on) {
        var host = document.getElementById('mathslate-editor');
        if (host) { host.classList.toggle('mathslate-script-active', !!on); }
        refreshCaret();
    }

    // Explicit block exit — the ONLY way out of a locked script block: →
    // past the block's edge (arrow key or > button), Space, Enter, Esc, or
    // a click/drag anywhere else on the slate. The caret parks at the end
    // (the block sits at the end while it is locked).
    function exitScript() {
        if (!script.awaiting && !script.locked) { return; }
        cancelScript();
        scrubSelection();
        deselectSlate(); // clear the selection in the model too (canvas click)
        caretEnd();
        refreshCaret();
    }

    // Top-level snippets as JSON strings (the slate's "blocks"). Trailing
    // '[]' placeholder blanks are dropped: they carry no content.
    // WARNING: output('JSON') is DESTRUCTIVE to the live model — it deletes
    // ids and stringifies blanks. Only ever call this when a rebuildSlate()
    // follows immediately (re-adding the cleaned strings heals the model:
    // createItem re-mints ids and re-creates blanks).
    function topItems() {
        try {
            var doc = JSON.parse(editor.mje.output('JSON'));
            return Array.isArray(doc) ? doc.filter(function (s) { return s !== '[]'; }) : [];
        } catch (e) { return []; }
    }

    // Rebuild the slate from top-level snippet strings. clear() pushes one
    // undo state and each addMath one more — the same churn the macro box
    // already creates — so caret edits leave plenty of undo history.
    function rebuildSlate(items) {
        var stale = blankIds();
        appRebuild++;
        editor.mje.clear();
        items.forEach(function (s) {
            editor.mje.addMath(typeof s === 'string' ? s : JSON.stringify(s));
        });
        appRebuild--;
        modelBlocks = items.length;
        return stale;
    }

    function caretEnd() {
        caret.gap = modelBlocks;
    }

    // The locked block's node as a JSON string, rebuilt purely from the
    // tracked content: [tag, tex template, [base, mrow-over-slot or blank]].
    // The slot is wrapped in an mrow exactly the way createItem.findBlank
    // wraps blank-filled slots (the core's slot convention — a bare items
    // array is no snippet and renders as nothing). Slot tokens stay IDLESS,
    // like every converted TeX-tool node: ids on non-registered nested
    // items crash the core's drop-shim builder (getItemByID only knows the
    // registered slots). A blank '[]' slot still renders as the empty
    // cursor box (createItem re-blanks it).
    function scriptNodeString() {
        return JSON.stringify([JOBS[script.kind].tag, {tex: JOBS[script.kind].tex},
            [script.base, script.slot.length ? ['mrow', {}, script.slot] : '[]']]);
    }

    // Rebuild the slate with the tracked slot spliced into the script node.
    // The output('JSON') read inside topItems() corrupts the model, but the
    // whole slate is re-added right away — createItem heals it.
    function rebuildLocked() {
        var items = topItems();
        items[items.length - 1] = scriptNodeString();
        return rebuildSlate(items);
    }

    // The locked slot's token elements, live from the CANVAS DOM: the
    // slate's last block renders as the mjx-msup / mjx-mfrac custom
    // element carrying the top-level item id (MathJax 4 CHTML keeps MathML
    // ids and classes on its output); inside it the slot's tokens are the
    // trailing single-token elements (mjx-mn/mi/mo), the base/numerator
    // always preceding the slot in document order.
    function slotTokenSpans() {
        if (!script.slot.length) { return []; }
        var ids = blockIds();
        if (!ids.length) { return []; }
        var root = document.querySelector('#mathslate-editor #canvas [id="' + ids[ids.length - 1] + '"]');
        if (!root) { return []; }
        var tokenSel = 'mjx-mn, mjx-mi, mjx-mo';
        var toks = [];
        var all = root.querySelectorAll(tokenSel);
        for (var i = 0; i < all.length; i++) {
            // outermost only: a token nested inside another token's span
            // (e.g. the glyph wrapper) is not a separate slot item
            var a = all[i].parentElement;
            while (a && a !== root) {
                if (a.matches && a.matches(tokenSel)) { break; }
                a = a.parentElement;
            }
            if (a === root || !a) { toks.push(all[i]); }
        }
        return toks.slice(Math.max(0, toks.length - script.slot.length));
    }

    // The cursor's position inside the locked block, clamped to the tracked
    // slot length (gaps 0..N between the block's tokens, N = after the last).
    function scriptGap() {
        var n = script.slot.length;
        if (caret.scriptGap > n) { caret.scriptGap = n; }
        if (caret.scriptGap < 0) { caret.scriptGap = 0; }
        return caret.scriptGap;
    }

    // Insert a character into the locked block at the internal caret. Model
    // surgery (splice + rebuild): the core's insert-before-blank path cannot
    // append past a filled slot (its rekey drops multi-item blanks — that is
    // where the old one-token rule came from), so we own slot growth here.
    function scriptType(ch) {
        var j = scriptGap();
        script.slot.splice(j, 0, JSON.parse(charToSnippetJSON(ch)));
        var stale = rebuildLocked(); // rebuildSlate maintains modelBlocks
        caret.scriptGap = j + 1;
        refreshCaret();
    }

    // Backspace inside the locked block: delete the slot token LEFT of the
    // internal caret. An emptied block is re-armed as a fresh box; Backspace
    // on an empty block collapses the script back to its bare base.
    function scriptBackspace() {
        if (!script.slot.length) { // empty block: collapse to the bare base
            var items = topItems(); // destructive read, healed by the rebuild
            if (script.base === '[]') { items.pop(); }
            else { items[items.length - 1] = script.base; }
            rebuildSlate(items);
            cancelScript();
            caretEnd();
            return;
        }
        var j = scriptGap();
        if (j === 0) { return; } // nothing left of the caret inside the block
        script.slot.splice(j - 1, 1);
        var stale = rebuildLocked(); // rebuildSlate maintains modelBlocks
        caret.scriptGap = j - 1;
        if (!script.slot.length) { attemptScriptArm(stale); }
        refreshCaret();
    }

    // Re-select the block's blank box after a rebuild left it empty, so the
    // slate shows the cursor box and the next fill is native again.
    function attemptScriptArm(stale) {
        var gen = script.gen;
        pollUntil(function () {
            var id = lastBlankId();
            return !!(id && stale.indexOf(id) === -1 && findShim(id));
        }, function () {
            if (script.gen !== gen || !script.locked) { return; }
            var shim = findShim(lastBlankId());
            armProgrammatic++;
            programmaticArmIdx = blankIds().length - 1; // armed the LAST box
            if (shim) { shim.click(); }
            pollUntil(hasSlateSelection, function () {
                armProgrammatic--;
                if (script.gen === gen) { script.armed = true; refreshCaret(); }
            }, 200, function () { armProgrammatic--; /* cosmetic failure is fine */ });
        }, 300, function () { /* cosmetic failure is fine */ });
    }

    // < and > (the UI buttons and ←/→): step the fake caret one position.
    // A real selection collapses to the end first. Inside a locked script
    // block the caret steps between the block's tokens; only a step PAST an
    // edge lets the cursor out — the block never loses it otherwise.
    function moveCaret(dir) {
        scrubSelection();
        if (script.awaiting && !script.locked) {
            // The fresh script box is armed (or still arming) but never
            // filled — e.g. e^ then →: the press steps OUT of the empty
            // block. exitScript cancels the pending script state too —
            // without that the state stayed "awaiting" after the armed
            // box lost its selection, and since an awaiting-unlocked
            // script suppresses the caret (the glowing box stands in for
            // it), the caret vanished for the rest of the session even
            // though typing kept appending at the top level.
            exitScript();
            if (dir < 0) { // …before the block, if stepping out on the left
                caret.gap = Math.max(0, modelBlocks - 1);
                refreshCaret();
            }
            return;
        }
        if (hasSlateSelection()) {
            deselectSlate();
            caretEnd();
            refreshCaret();
            return;
        }
        if (script.locked) {
            if (!script.slot.length) { exitScript(); return; }
            var j = scriptGap() + dir;
            if (j < 0 || j > script.slot.length) { // stepped past the edge: leave
                exitScript();
                if (j < 0) { // …before the block, if stepping out on the left
                    caret.gap = Math.max(0, modelBlocks - 1);
                    refreshCaret();
                }
                return;
            }
            caret.scriptGap = j;
            refreshCaret();
            return;
        }
        caret.gap = Math.max(0, Math.min(caret.gap + dir, modelBlocks));
        refreshCaret();
    }

    /* ---------------- TeX-command macro mode (the backslash key) ---------
     *
     * "\\" inserts an active placeholder: an mrow showing "\\" in monospace
     * followed by a blank box (the "cursor"). Each letter typed extends the
     * macro name: the keystroke swaps in a fresh node (undo + append — a
     * cheap operation driven purely by the order of the input queue, so a
     * fast typist's keys can never be swallowed by arming machinery).
     * Selecting the fresh box after each swap is a best-effort visual
     * nicety (attemptArm): selection is NOT load-bearing here, unlike the
     * script triggers where filling the box depends on it.
     *
     * Any non-letter terminates the macro; the name is then handed to the
     * same TeX-to-slate pipeline the toolbox TeX tool uses (parseTeXNode),
     * so it becomes a proper parsed math node on the slate, and the
     * terminating character is processed only after that conversion is in
     * place. Unparseable names degrade to a literal monospace token.
     */

    var macroState = {active: false, armed: false, name: '', gen: 0,
        inSlot: false, slotIndex: -1};

    // "Active/selected" visual wrapper for the open box (see app.css):
    // #mathslate-editor carries this marker class for the whole
    // accumulation phase; CSS draws the slate-lock glow and the dashed
    // cursor outline, and macroNode highlights the macro token itself via
    // mathbackground. Removed again when the box closes.
    function setMacroActiveClass(on) {
        var host = document.getElementById('mathslate-editor');
        if (host) { host.classList.toggle('mathslate-macro-active', !!on); }
        refreshCaret();
    }

    // The tex template "['\\name', 1]" also references child slot 1 (the
    // blank box): it contributes nothing to the TeX (a blank's tex is ''),
    // but templates that don't reference a child also hide it from the
    // slate's preview panel — and the box must render there to be
    // findable, clickable and selectable.
    // The mtext's mathbackground is the placeholder highlight: it only
    // exists on the open box — the finished macro (finishMacro) drops it.
    function macroNode(name) {
        return ['mrow', {tex: ['\\' + name, 1]},
            [['mtext', {mathvariant: 'monospace', mathbackground: '#1f3a5f'}, '\\' + name], '[]']];
    }

    function startMacro() {
        var slotIndex = macroSlotIndex();
        if (slotIndex !== -1) { startMacroInSlot(slotIndex); return; }
        if (hasSlateSelection()) { deselectSlate(); }
        if (slotFocus.active) { startMacroAtFocus(); return; }
        caretEnd(); // the placeholder (and its conversion) land at the end
        var staleBlanks = blankIds(); // see attemptArm: decoys must be ignored
        macroState.active = true;
        macroState.armed = false;
        macroState.name = '';
        macroState.gen++;
        setMacroActiveClass(true);
        editor.mje.addMath(JSON.stringify(macroNode('')));
        modelBlocks++; // the box itself is a top-level block (undone later)
        attemptArm(staleBlanks);
    }

    /* ---- TeX-command box INSIDE a selected fill-box (slot) ------------ *
     * Pressing \\ while a fill-box (blank) inside a structure — e.g. the
     * denominator of a \\frac — is selected opens the macro box inside
     * that slot: the fraction is not left behind. The DOM selection
     * marker cannot route the follow-up edits (re-renders lag the model
     * and insert-at-selection decides through that stale DOM), so the
     * in-slot lifecycle bypasses selection entirely: the app performs
     * model surgery on the cleaned snippet tree (the same healed
     * read+splice+rebuild pattern as scriptType), addressing the slot by
     * the blank's PRE-ORDER INDEX captured once at the start. The box,
     * its name growth, the conversion and the fallback are all slot-local
     * node swaps; only the final re-arm reaches back into the DOM. */

    // Index of the selected fill-box in blankIds()' pre-order, or -1 when
    // the current selection is a real snippet (or nothing at all).
    function macroSlotIndex() {
        var sel = document.querySelector('#mathslate-editor .mathslate-workspace .mathslate-selected');
        return (sel && sel.id) ? blankIds().indexOf(sel.id) : -1;
    }

    // Visit the target-th blank ('[]') of the cleaned snippet tree in
    // pre-order — the same order blankIds() lists the preview boxes — and
    // run cb on the child array that holds it. Returns true when found.
    function visitBlank(items, target, cb) {
        var seen = 0;
        function scan(arr) {
            for (var i = 0; i < arr.length; i++) {
                var node = arr[i];
                if (node === '[]') {
                    if (seen === target) { cb(arr, i); return true; }
                    seen++;
                } else if (Array.isArray(node) && Array.isArray(node[2]) && scan(node[2])) {
                    return true;
                }
            }
            return false;
        }
        return scan(items);
    }

    // Locate the open macro box by its accumulated name in the cleaned
    // snippet tree: the placeholder is an mrow whose tex template starts
    // with the control word (fallen-back literals are plain mtexts and
    // converted nodes carry a trailing space — neither can collide).
    function findPlaceholder(items, name) {
        var hit = null;
        (function scan(arr) {
            for (var i = 0; i < arr.length && !hit; i++) {
                var node = arr[i];
                if (!Array.isArray(node)) { continue; }
                if (node[0] === 'mrow' && node[1] && node[1].tex
                    && node[1].tex[0] === '\\' + name) {
                    hit = {arr: arr, i: i};
                } else if (Array.isArray(node[2])) {
                    scan(node[2]);
                }
            }
        })(items);
        return hit;
    }

    // Replace the macro box inside its slot: the placeholder goes, the
    // given replacement node(s) take its place, and a fresh empty box
    // ('[]') is parked behind them so the slot can keep accepting input
    // (it survives renders because it re-keyed solo in its own slot).
    function swapPlaceholderInSlot(items, hit, replNodes) {
        hit.arr.splice(hit.i, 1);
        replNodes.forEach(function (n) { hit.arr.push(n); });
        // The splice point is where the cursor conceptually sits: (re)anchor
        // the persistent slot focus on the slot that just received content.
        setSlotFocusFromItems(items, hit.arr);
        rebuildSlate(items);
    }

    function startMacroInSlot(slotIndex) {
        // Deselect FIRST: with a selection still live, the clear() inside
        // rebuildSlate turns into the core's "remove the selected snippet"
        // (which would rip the armed box out of its slot and duplicate the
        // fraction) instead of wiping the slate.
        deselectSlate();
        var items = topItems(); // destructive read, healed by the rebuild below
        var placed = visitBlank(items, slotIndex, function (arr, i) {
            // The slot keeps its mrow slot-wrap convention; the box is
            // its content (with its own cursor box, exactly as top-level).
            arr[i] = ['mrow', {}, [macroNode('')]];
        });
        if (!placed) { // index drifted (external edit): classic behaviour
            deselectSlate();
            caretEnd();
            var stale = blankIds();
            macroState.active = true;
            macroState.armed = false;
            macroState.name = '';
            macroState.gen++;
            setMacroActiveClass(true);
            editor.mje.addMath(JSON.stringify(macroNode('')));
            attemptArm(stale);
            return;
        }
        rebuildSlate(items);
        macroState.active = true;
        macroState.armed = false;
        macroState.name = '';
        macroState.inSlot = true;
        macroState.slotIndex = slotIndex;
        macroState.gen++;
        setMacroActiveClass(true);
        refreshCaret();
    }

    // Re-select the box at the captured slot position after a conversion
    // landed, so the next keystroke continues inside the structure (the
    // pump resumes once the box shows selected or the arm attempt ends).
    function armSlotBox(slotIndex, gen) {
        pollUntil(function () {
            if (macroState.gen !== gen) { return true; }
            // The preview DOM is only meaningful once MathJax 4's queue has
            // fully drained: mid-render it still shows the PRE-splice slate
            // (whose placeholder box sits at this very index), and clicking
            // that stale shim is a silent no-op — the one-shot arm is lost.
            if (!queueQuiet()) { return false; }
            var id = blankIds()[slotIndex];
            return !!(id && findShim(id));
        }, function () {
            if (macroState.gen !== gen) { return; }
            var id = blankIds()[slotIndex];
            var shim = id ? findShim(id) : null;
            armProgrammatic++;
            programmaticArmIdx = slotIndex;
            if (shim) { shim.click(); }
            pollUntil(hasSlateSelection, function () {
                armProgrammatic--;
                refreshCaret();
                resumeInput();
            }, 200, function () { armProgrammatic--; refreshCaret(); resumeInput(); });
        }, 300, resumeInput);
    }

    /* ---- Persistent SLOT FOCUS ---------------------------------------- *
     * The hotfix-era model dropped the cursor context the moment a box was
     * filled ("release to top level"): the slate had no record of WHERE
     * the user's caret conceptually was, so the next character — or worse,
     * a delimiter like \\, +, ^, _ or / — acted on the top-level slate and
     * the cursor visibly JUMPED OUT of the fraction (the "+" and "\\ after
     * a variable" bugs). The durable fix tracks the focus slot as a pure
     * closure address —
     *
     *   slotFocus  {active, top, path, caretIdx, boxIdx, tokCount} —
     *                        durable: top = the owning structure's index
     *                        among the top-level blocks, path = child-index
     *                        path down its JSON tree to the slot's CONTENT
     *                        array, caretIdx = the intra-slot caret (a
     *                        token count; 0 sits before the first token),
     *                        boxIdx = the slot's trailing box in blankIds()
     *                        pre-order and tokCount = the slot's token tally
     *                        (the caret's live-DOM socket — refreshed by
     *                        bookmarkSlot at every surgery, so the 250 ms
     *                        caret never needs a model read). It is planted the
     *                        moment a USER-clicked box is filled (app-armed
     *                        boxes are told apart by programmaticArmIdx,
     *                        synchronously — no timing assumptions) and
     *                        re-anchored after every in-slot mutation.
     *
     * While the focus lives, EVERY input unit (letters, digits, symbols,
     * \\, ^ _ / and Backspace) is routed into the slot by pure model
     * surgery (the healed topItems+splice+rebuildSlate pattern), never
     * through the selection DOM — MathJax 4 may lag whole keystrokes with
     * its async typeset + font fetches without ever stranding the cursor.
     * Chars insert AT caretIdx, Backspace deletes the token to its left,
     * ^ _ / wrap the token to its left, and arrows first step caretIdx —
     * only a step past an edge exits (parking the caret right beside the
     * structure). The other explicit exits are Esc, a click on top-level
     * content, or the owning structure vanishing (watcher-validated). A
     * NATIVE fill of an app-armed box while the focus lives is always that
     * slot's own continuation (the conversion/trailing re-arms): the caret
     * is resynced to the slot end right after such a fill. */
    var slotFocus = {active: false, top: -1, path: null, caretIdx: 0,
        boxIdx: -1, tokCount: 0};
    // Programmatic shim clicks (structure/script/macro re-arms) must never
    // masquerade as user intent: they arm boxes for ONE native fill, whose
    // release semantics stay untouched (typed-after-an-auto-armed-box still
    // continues after the block).
    var armProgrammatic = 0;
    // Index of the blank the APP armed most recently (index space is the
    // one macroSlotIndex()/blankIds() share); -1 while no app-arm marker
    // is live. This is how a user click is told apart from the app's own
    // arming clicks without any timing assumptions.
    var programmaticArmIdx = -1;

    function clearSlotFocus() {
        slotFocus.active = false;
        slotFocus.top = -1;
        slotFocus.path = null;
        slotFocus.caretIdx = 0;
        slotFocus.boxIdx = -1;
        slotFocus.tokCount = 0;
    }

    // Identity search: child-index path from a JSON node to the exact
    // content array (arrays are re-created by rebuildSlate, but positions
    // in the JSON tree are stable, so a path survives every re-render).
    function pathOfArray(node, target, prefix) {
        for (var i = 0; i < node.length; i++) {
            var child = node[i];
            if (child === target) { return prefix.concat([i]); }
            if (Array.isArray(child)) {
                var hit = pathOfArray(child, target, prefix.concat([i]));
                if (hit) { return hit; }
            }
        }
        return null;
    }

    // {top, path} of the content array, or null when it is not in the tree.
    function locateArrayInItems(items, arr) {
        for (var t = 0; t < items.length; t++) {
            var node = items[t];
            if (typeof node === 'string') { node = JSON.parse(node); }
            if (!Array.isArray(node)) { continue; }
            var hit = pathOfArray(node, arr, []);
            if (hit) { return {top: t, path: hit}; }
        }
        return null;
    }

    function setSlotFocusFromItems(items, arr) {
        var loc = locateArrayInItems(items, arr);
        if (loc) {
            slotFocus.active = true;
            slotFocus.top = loc.top;
            slotFocus.path = loc.path;
            slotFocus.caretIdx = slotTokenIndices(arr).length; // end of slot
            bookmarkSlot(items, arr);
        }
    }

    // Every slot the app maintains ends in an empty box: the next input
    // unit's home (a click target), and the caret's DOM socket. A NATIVE
    // fill always consumes it (the core's rekey drops the filled blank),
    // so the fill paths restore it here.
    function ensureSlotBox(arr) {
        if (!arr.length || !isBlankNode(arr[arr.length - 1])) { arr.push('[]'); }
    }

    // …and the trailing box dies with the focus. It only ever was the
    // caret's socket + next fill's click target; left behind after an
    // exit it renders as a stray placeholder behind the slot's content
    // (the "b^{2□}" the report showed after → out of the superscript).
    // A slot holding NOTHING but the box is the structure's own empty
    // argument affordance (\sqrt{}, e^{}) — that one stays.
    function stripSlotAnchorBox(arr) {
        if (arr && arr.length > 1 && isBlankNode(arr[arr.length - 1])) { arr.pop(); }
    }

    // Pre-order index (blankIds() order) of the LAST blank that lives
    // inside the content array found by identity — the slot's own
    // trailing box under the trailing-box convention (-1 when there is
    // none, e.g. right between a structure wrap and its argument's fill,
    // when the pending argument box is itself the cursor).
    function blankIndexInArrayEnd(items, target) {
        var seen = 0, result = -1;
        (function scan(arr, inside) {
            var in2 = inside || arr === target;
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i];
                if (c === '[]') { if (in2) { result = seen; } seen++; }
                else if (Array.isArray(c) && Array.isArray(c[2])) { scan(c[2], in2); }
            }
        })(items, false);
        return result;
    }

    // Refresh the caret's socket (boxIdx + tokCount) from the same items
    // read the surgery already holds — the blinking caret then never has
    // to touch the (destructive) model to find its DOM anchor.
    function bookmarkSlot(items, arr) {
        if (arr) {
            slotFocus.tokCount = slotTokenIndices(arr).length;
            slotFocus.boxIdx = blankIndexInArrayEnd(items, arr);
        } else {
            slotFocus.tokCount = 0;
            slotFocus.boxIdx = -1;
        }
    }

    // A slot keeps its tokens FLAT with one trailing box, so the intra-slot
    // caret can be a plain token index: slotTokenIndices lists the content
    // positions (everything but boxes), and caretIdx counts them — typing
    // lands exactly where the caret sits, not only at the end.
    function slotTokenIndices(arr) {
        var idx = [];
        for (var i = 0; i < arr.length; i++) {
            if (!isBlankNode(arr[i])) { idx.push(i); }
        }
        return idx;
    }

    // The focused slot's content array in a fresh topItems() read, or null.
    function resolveSlotArr(items) {
        if (!slotFocus.active) { return null; }
        var node = items[slotFocus.top];
        if (typeof node === 'string') { node = JSON.parse(node); }
        if (!Array.isArray(node)) { return null; }
        for (var k = 0; k < slotFocus.path.length; k++) {
            node = node[slotFocus.path[k]];
            if (!Array.isArray(node)) { return null; }
        }
        return node;
    }

    // Pre-order index (blankIds() order) of the FIRST blank that lives
    // inside the content array found by identity — or -1.
    function blankIndexInArray(items, target) {
        var result = -1, seen = 0;
        (function scan(arr) {
            if (result !== -1) { return; }
            if (arr === target) { result = seen; return; }
            for (var i = 0; i < arr.length; i++) {
                var c = arr[i];
                if (c === '[]') { seen++; }
                else if (Array.isArray(c) && Array.isArray(c[2])) { scan(c[2]); }
            }
        })(items);
        return result;
    }

    // {top, path, arr} of the LAST content array (document order) whose
    // final element deep-equals node — i.e. the slot a token was just
    // appended to. Top-level rows are not slots, so a plain end-of-slate
    // fill never matches.
    function locateSlotEndingWith(items, node) {
        var want = JSON.stringify(node), found = null;
        items.forEach(function (root, t) {
            if (typeof root === 'string' || !Array.isArray(root)) { return; }
            (function scan(arr, path) {
                for (var i = 0; i < arr.length; i++) {
                    var c = arr[i];
                    if (Array.isArray(c)) {
                        if (c.length && JSON.stringify(c[c.length - 1]) === want) {
                            found = {top: t, path: path.concat([i]), arr: c};
                        }
                        scan(c, path.concat([i]));
                    }
                }
            })(root, []);
        });
        return found;
    }

    // A slot's trailing box shows up in cleaned JSON in two forms: the bare
    // '[]' placeholder (pre-registration) and, once createItem has taken it
    // through a render, the slot-wrapped ['mrow', {}, ['[]']]. Both are the
    // same bookkeeping — never content.
    function isBlankNode(n) {
        // Unwrap single-child mrow chains: every registration pass wraps the
        // box one level deeper (createItem.findBlank), so the same box can
        // sit under several mrow layers by the time the next surgery runs.
        while (Array.isArray(n) && n[0] === 'mrow'
            && Array.isArray(n[2]) && n[2].length === 1) {
            n = n[2][0];
        }
        return n === '[]';
    }

    function insertAtSlotEnd(arr, node) {
        // Keep the slot's trailing-box shape — a bare, single-level box —
        // an empty box always trails the content, so the next input unit
        // (or a click) still has a home; whatever wrapper depth it had
        // accumulated is collapsed back to one level on the way in.
        if (arr.length && isBlankNode(arr[arr.length - 1])) {
            arr.splice(arr.length - 1, 1, node, '[]');
        } else {
            arr.push(node);
            arr.push('[]');
        }
    }

    // The user clicked a sub-slot box and typed: fill it by surgery and
    // convert the transient intent into the durable slot focus. (The DOM
    // insert-before-blank route would work today, but it leaves NO record
    // of the slot — the very next keystroke could not be kept inside.)
    function fillClickedSlot(json, si) {
        var filled = null;
        deselectSlate(); // heal rule: clear selections before clear()s
        programmaticArmIdx = -1; // its marker died with the deselect above
        var items = topItems(); // destructive read, healed below
        var oldSlotArr = slotFocus.active ? resolveSlotArr(items) : null;
        visitBlank(items, si, function (arr, i) {
            arr[i] = JSON.parse(json);
            filled = arr;
        });
        if (!filled) { rebuildSlate(items); return false; } // heal the read
        if (oldSlotArr && oldSlotArr !== filled) {
            stripSlotAnchorBox(oldSlotArr); // the focus moved: close the old socket
        }
        ensureSlotBox(filled); // the caret's socket (and next fill's home)
        setSlotFocusFromItems(items, filled);
        rebuildSlate(items);
        caretEnd();
        return true;
    }

    // Continuation typing while the slot focus lives: splice the token at
    // the intra-slot caret (before the trailing box at the end), all by
    // JSON surgery.
    function insertCharInSlot(json) {
        var items = topItems();
        var arr = resolveSlotArr(items);
        if (!arr) {
            rebuildSlate(items); // heal the destructive read first
            clearSlotFocus();
            editor.mje.addMath(json); // slot vanished: plain end-append
            modelBlocks++;
            caretEnd();
            return;
        }
        var tokIdx = slotTokenIndices(arr);
        var ci = Math.min(Math.max(slotFocus.caretIdx, 0), tokIdx.length);
        if (ci >= tokIdx.length) {
            insertAtSlotEnd(arr, JSON.parse(json));
        } else {
            arr.splice(tokIdx[ci], 0, JSON.parse(json));
        }
        slotFocus.caretIdx = ci + 1;
        bookmarkSlot(items, arr);
        rebuildSlate(items);
        caretEnd();
    }

    // Backspace while the slot focus lives: delete INSIDE the slot. When
    // the slot runs empty, the keystroke is consumed while the cursor
    // steps out to the top level (the structure itself is deleted only by
    // the NEXT Backspace — never as a side effect of slot editing).
    function backspaceInSlot() {
        var items = topItems();
        var arr = resolveSlotArr(items);
        if (!arr) { clearSlotFocus(); return false; }
        var tokIdx = slotTokenIndices(arr);
        var ci = Math.min(Math.max(slotFocus.caretIdx, 0), tokIdx.length);
        if (!tokIdx.length || ci === 0) {
            rebuildSlate(items); // heal the read; nothing was deleted
            clearSlotFocus();
            caretEnd();
            return true;
        }
        slotFocus.caretIdx = ci - 1;
        arr.splice(tokIdx[ci - 1], 1);
        // Canonical empty slot: reduce any leftover bookkeeping (mrow-layer
        // wrapper chains around the box) to the one bare '[]' the model
        // renders as the empty box.
        if (!arr.length || arr.every(isBlankNode)) {
            arr.length = 0;
            arr.push('[]');
        }
        bookmarkSlot(items, arr);
        rebuildSlate(items);
        caretEnd();
        return true;
    }

    // \\ pressed while the slot focus lives (e.g. right after filling the
    // box with a variable): open the macro box at the END of that slot.
    function startMacroAtFocus() {
        var items = topItems();
        var arr = resolveSlotArr(items);
        if (!arr) { rebuildSlate(items); clearSlotFocus(); startMacro(); return; }
        if (!arr.length || !isBlankNode(arr[arr.length - 1])) { arr.push('[]'); }
        var si = blankIndexInArray(items, arr); // the trailing box
        if (si === -1) { rebuildSlate(items); clearSlotFocus(); startMacro(); return; }
        rebuildSlate(items); // heal: startMacroInSlot re-reads the model
        startMacroInSlot(si);
    }

    // The slot ENCLOSING the focused one, read off the focus path's tail
    // […, i, 2, k, 2]: the structure at index i of the parent slot carries
    // the focused slot as its k-th child slot. Verified by identity
    // against the live tree (a mismatch degrades to the classic top-level
    // exit). Returns {path, arr, before} where before counts the parent
    // slot's tokens left of that structure; null when the focused slot
    // hangs directly off its top-level block (path [2, n, 2]).
    function parentSlotOf(items, navArr) {
        var P = slotFocus.path;
        if (!P || P.length < 4) { return null; }
        var i = P[P.length - 4], k = P[P.length - 2];
        if (P[P.length - 3] !== 2 || P[P.length - 1] !== 2) { return null; }
        var node = items[slotFocus.top];
        if (typeof node === 'string') { node = JSON.parse(node); }
        if (!Array.isArray(node)) { return null; }
        var PP = P.slice(0, P.length - 4);
        for (var s = 0; s < PP.length; s++) {
            node = node[PP[s]];
            if (!Array.isArray(node)) { return null; }
        }
        var structure = node[i];
        if (!Array.isArray(structure) || !Array.isArray(structure[2])) { return null; }
        var wrap = structure[2][k];
        if (!Array.isArray(wrap) || wrap[2] !== navArr) { return null; }
        var before = 0;
        for (var t = 0; t < i && t < node.length; t++) {
            if (!isBlankNode(node[t])) { before++; }
        }
        return {path: PP, arr: node, before: before};
    }

    // ^ _ / while the slot focus lives: wrap the slot's LAST token into
    // the structure (exactly the top-level trigger's template), then arm
    // the fresh argument box — clicked-open, so filling it re-anchors the
    // focus inside the argument and characters keep accumulating there.
    function startStructureAtFocus(kind) {
        var job = JOBS[kind];
        if (!job) { resumeInput(); return; }
        var items = topItems();
        var arr = resolveSlotArr(items);
        var tokIdx = arr ? slotTokenIndices(arr) : [];
        var bi = Math.min(Math.max(slotFocus.caretIdx, 0), tokIdx.length) - 1;
        if (!arr || bi < 0) { // no base left of the caret: leave it, top-level
            if (arr) { stripSlotAnchorBox(arr); } // the focus leaves the slot
            rebuildSlate(items); // heal the destructive read first
            clearSlotFocus();
            startScript(kind); // resumes the pump itself
            return;
        }
        var base = arr[tokIdx[bi]];
        var node = [job.tag, {tex: job.tex}, [base, '[]']];
        arr.splice(tokIdx[bi], 1, node);
        // The fresh argument box is the cursor now (the trailing-box
        // convention's own wording): the slot's old socket closes, so the
        // only visible box while the argument fills is the argument's.
        stripSlotAnchorBox(arr);
        slotFocus.caretIdx = bi + 1; // caret sits right after the structure
        bookmarkSlot(items, arr); // the fresh argument box shifted blanks
        var si = blankIndexInArray(items, node[2]); // the fresh argument box
        var stale = blankIds();
        rebuildSlate(items);
        pollUntil(function () {
            if (!queueQuiet()) { return false; }
            var id = blankIds()[si];
            return !!(id && stale.indexOf(id) === -1 && findShim(id));
        }, function () {
            var id = blankIds()[si];
            var shim = id ? findShim(id) : null;
            if (shim) { shim.click(); } /* the fresh argument box is now
                user-facing: NOT a programmatic arm (no record entry), so
                filling it takes the surgical path and re-anchors the slot
                focus inside the argument — characters keep accumulating */
            // The click's selection marker only lands with the NEXT async
            // typeset; hold the pump's queued keystrokes until it does, or
            // a fast typist's fill arrives while macroSlotIndex() still
            // reads -1 and the token splices into the outer slot instead
            // (\sqrt{b^{}2} — the race behind the report's missing caret).
            pollUntil(hasSlateSelection, resumeInput, 200, resumeInput);
        }, 300, resumeInput);
    }

    // Best effort: after MathJax re-renders the slate, click the macro's own
    // blank box so it shows up selected as the cursor. Failure (e.g. MathJax
    // stalled on a font fetch) is harmless — typing works regardless.
    function attemptArm(staleBlanks) {
        var gen = macroState.gen;
        pollUntil(function () {
            var tex = currentTeX().replace(/\s+/g, '');
            if (tex.slice(-(macroState.name.length + 1)) !== '\\' + macroState.name) {
                return false;
            }
            var id = lastBlankId();
            return !!(id && staleBlanks.indexOf(id) === -1 && findShim(id));
        }, function () {
            if (macroState.gen !== gen) { return; }
            var shim = findShim(lastBlankId());
            armProgrammatic++;
            programmaticArmIdx = blankIds().length - 1; // armed the LAST box
            if (shim) { shim.click(); } // select the box: cursor inside the placeholder
            pollUntil(hasSlateSelection, function () {
                armProgrammatic--;
                if (macroState.gen !== gen) { return; }
                macroState.armed = true;
            }, 200, function () { armProgrammatic--; /* cosmetic failure is fine */ });
        }, 300, function () { /* cosmetic failure is fine */ });
    }

    function macroType(ch) {
        if (macroState.inSlot) {
            var old = macroState.name;
            macroState.name = old + ch;
            macroState.armed = false;
            macroState.gen++;
            var items = topItems(); // destructive read, healed by the rebuild
            var hit = findPlaceholder(items, old);
            if (hit) { hit.arr[hit.i] = macroNode(macroState.name); }
            rebuildSlate(items);
            refreshCaret();
            return;
        }
        macroState.name += ch;
        macroState.armed = false;
        macroState.gen++;
        // Swap the placeholder for one with the longer name (keeps the run a
        // single monospace token and the TeX a single macro string). The old
        // box's id goes stale with the undo, so it must be ignored by arming.
        var staleBlanks = blankIds();
        scrubSelection(); // the old box vanishes; don't let its marker linger
        editor.mje.undo();
        editor.mje.addMath(JSON.stringify(macroNode(macroState.name)));
        // undo + addMath cancel each other out: modelBlocks unchanged
        attemptArm(staleBlanks);
    }

    // Close the box: drop the active wrapper, undo the placeholder, then
    // convert the accumulated name into REAL math through the very pipeline
    // the toolbox's TeX tool uses (textool.js: MathJax "Text" ->
    // jax.root.toMathML -> Mathslate's MathML-to-snippet parser — the
    // function behind the TeX tab), so a macro becomes proper parsed math
    // on the slate instead of staying a literal monospace text token. The
    // parse completes asynchronously, so finishMacro is only ever run by
    // the input pump, which it blocks: the terminator that closed the box
    // (digit, ^, …) executes strictly after the converted math is in place.
    function finishMacro() {
        if (!macroState.active) { return; }
        var name = macroState.name;
        var inSlot = macroState.inSlot;
        var slotIndex = macroState.slotIndex;
        macroState.active = false;
        macroState.armed = false;
        macroState.inSlot = false;
        macroState.slotIndex = -1;
        var gen = ++macroState.gen; // invalidate stale async completions
        setMacroActiveClass(false);
        if (inSlot) { finishMacroInSlot(name, gen, slotIndex); return; }
        scrubSelection();
        editor.mje.undo(); // remove the placeholder
        modelBlocks--;
        deselectSlate();
        status('', true);
        if (!name) { resumeInput(); return; }
        if (ARG_MACROS[name]) { insertStructure(ARG_MACROS[name], gen); return; }
        parseTeXNode(name, gen);
    }

    // Close a slot-local macro box: no undo (the box was built by surgery,
    // not appends) and nothing ever leaves the slot. The empty-name case
    // restores the bare empty box; argument commands swap in the live
    // structure block; everything else compiles through the TeX tool with
    // its addMath diverted back into the slot (see macroCapture).
    function finishMacroInSlot(name, gen, slotIndex) {
        status('', true);
        if (!name) {
            var items = topItems(); // destructive read, healed by the rebuild
            var hit = findPlaceholder(items, '');
            if (hit) { hit.arr[hit.i] = '[]'; setSlotFocusFromItems(items, hit.arr); rebuildSlate(items); }
            refreshCaret();
            resumeInput();
            return;
        }
        if (ARG_MACROS[name]) { insertStructureInSlot(name, ARG_MACROS[name], gen, slotIndex); return; }
        parseTeXNodeInSlot(name, gen, slotIndex);
    }

    // The live structure block (\\frac, \\sqrt, …) inside the slot: swap
    // out the box, then arm the block's FIRST empty box — it inherits the
    // placeholder's slot index, so armSlotBox's addressing still works.
    function insertStructureInSlot(name, job, gen, slotIndex) {
        var items = topItems(); // destructive read, healed by the rebuild
        var hit = findPlaceholder(items, name);
        if (hit) { swapPlaceholderInSlot(items, hit, [job.json, '[]']); }
        status(job.status, true);
        armSlotBox(slotIndex, gen);
    }

    // Compile the macro name through the toolbox TeX tool exactly like
    // parseTeXNode does — but macroCapture diverts the tool's addMath so
    // the converted node is spliced into the slot where the box was,
    // never appended to the slate's end.
    function parseTeXNodeInSlot(name, gen, slotIndex) {
        var input = document.querySelector('#mathslate-editor input[type="text"]');
        if (!input) { macroFallbackInSlot(name, gen, slotIndex); return; }
        var before = addsCount();
        macroCapture = {name: name}; // consumed by the wrapped addMath
        var restore = input.value;
        input.value = '\\' + name + ' ';
        input.dispatchEvent(new Event('change', {bubbles: true}));
        input.value = restore;
        pollUntil(function () {
            return macroState.gen !== gen || addsCount() > before;
        }, function () {
            if (macroState.gen !== gen) { return; }
            if (macroCapture) { // the tool never wrote: degrade instead
                macroCapture = null;
                macroFallbackInSlot(name, gen, slotIndex);
                return;
            }
            status('', true);
            armSlotBox(slotIndex, gen); // typing continues inside the slot
        }, 300, function () {
            if (macroState.gen !== gen) { return; }
            if (addsCount() > before && !macroCapture) { // landed on the deadline
                status('', true);
                armSlotBox(slotIndex, gen);
                return;
            }
            macroCapture = null;
            macroFallbackInSlot(name, gen, slotIndex);
        });
    }

    // TeX could not parse the name: keep the old literal behaviour —
    // inside the slot, where the box was.
    function macroFallbackInSlot(name, gen, slotIndex) {
        var items = topItems(); // destructive read, healed by the rebuild
        var hit = findPlaceholder(items, name);
        if (hit) {
            swapPlaceholderInSlot(items, hit, [
                ['mtext', {mathvariant: 'monospace', tex: ['\\' + name + ' ']}, '\\' + name],
                '[]'
            ]);
        }
        status('TeX could not parse "\\' + name + '" — kept as literal text.');
        armSlotBox(slotIndex, gen);
    }

    /* Commands that REQUIRE arguments (\\frac, \\sqrt, …) parse to
     * nothing on their own — MathJax reports a TeX error and the tool drops
     * it. Map them instead onto the same live templates the toolbox drags
     * in (the tex template references the child slots, so the TeX read-out
     * keeps updating as the boxes are filled), and select the first empty
     * box as the cursor before the pump resumes. Table entry format:
     *   json   — the structure snippet (blank '[]' slots for the arguments)
     *   marker — spaceless TeX suffix proving the block has rendered
     *   status — hint shown once the first box is armed
     */
    var ARG_MACROS = {
        frac:  {json: ['mfrac', {tex: ['\\frac{', 0, '}{', 1, '}'], am: ['(', 0, ')/(', 1, ')']}, ['[]', '[]']],
                marker: '}{}', status: '\\frac inserted — the numerator box is selected; type to fill it.'},
        dfrac: {json: ['mfrac', {tex: ['\\dfrac{', 0, '}{', 1, '}']}, ['[]', '[]']],
                marker: '}{}', status: '\\dfrac inserted — the numerator box is selected; type to fill it.'},
        tfrac: {json: ['mfrac', {tex: ['\\tfrac{', 0, '}{', 1, '}']}, ['[]', '[]']],
                marker: '}{}', status: '\\tfrac inserted — the numerator box is selected; type to fill it.'},
        binom: {json: ['mfrac', {linethickness: '0', tex: ['\\binom{', 0, '}{', 1, '}']}, ['[]', '[]']],
                marker: '}{}', status: '\\binom inserted — the top box is selected; type to fill it.'},
        sqrt:  {json: ['msqrt', {tex: ['\\sqrt{', 0, '}']}, ['[]']],
                marker: 't{}', status: '\\sqrt inserted — the radicand box is selected; type to fill it.'}
    };

    // Insert a structure block, then (blocking the pump) select the block's
    // first empty box — the FIRST fresh blank, not the last: blanks are
    // previewed in document order, so the numerator precedes the
    // denominator. Freshness filtering ignores pre-existing empty boxes
    // elsewhere on the slate. Typed characters then fill the selected box,
    // exactly as if the tool had been dragged in and clicked.
    function insertStructure(job, gen) {
        var staleBlanks = blankIds();
        editor.mje.addMath(JSON.stringify(job.json));
        modelBlocks++;
        pollUntil(function () {
            if (macroState.gen !== gen) { return true; } // slate wiped meanwhile
            var tex = currentTeX().replace(/\s+/g, '');
            if (tex.slice(-job.marker.length) !== job.marker) { return false; }
            var ids = blankIds().filter(function (id) {
                return staleBlanks.indexOf(id) === -1 && findShim(id);
            });
            return ids.length > 0;
        }, function () {
            if (macroState.gen !== gen) { return; }
            var ids = blankIds().filter(function (id) {
                return staleBlanks.indexOf(id) === -1 && findShim(id);
            });
            var shim = ids.length ? findShim(ids[0]) : null;
            armProgrammatic++;
            programmaticArmIdx = ids.length ? blankIds().indexOf(ids[0]) : -1;
            if (shim) { shim.click(); } // select the first box as the cursor
            pollUntil(hasSlateSelection, function () {
                armProgrammatic--;
                if (macroState.gen === gen) { status(job.status, true); }
                caretEnd();
                resumeInput();
            }, 200, function () { armProgrammatic--; caretEnd(); resumeInput(); }); // arm failure is harmless
        }, 300, resumeInput);
    }

    // Number of top-level blocks on the slate, counted from the PREVIEW
    // DOM (one row per top-level snippet; a lone placeholder row has empty
    // text and is not content). Deliberately NOT output('JSON'): the core's
    // JSON export mutates the live model (cleanSnippet deletes ids and
    // stringifies blanks) — safe only in read+splice+rebuild pairs.
    function snippetCount() {
        var rows = document.querySelectorAll('#mathslate-editor .mathslate-preview > div');
        var n = 0;
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].textContent.trim() !== '') { n++; }
        }
        return n;
    }

    // App-side model-write counter: editor.mje.addMath is wrapped once at
    // boot (the core file stays untouched). This is the ONLY non-destructive
    // way to observe model growth — output('JSON') mutates the live model
    // and preview-row counts lag renders. rebuildSlate() suppresses its own
    // bursts via appRebuild so only genuine writes count.
    var mjeAddCount = 0;
    var appRebuild = 0;

    // In-slot macro conversion: parseTeXNodeInSlot sets {name} before
    // driving the TeX tool; the tool's resulting addMath call is then
    // intercepted and spliced into the slot in place of the macro box,
    // followed by a fresh empty box. The counter still bumps, so the
    // conversion detection in parseTeXNodeInSlot works unchanged.
    var macroCapture = null;

    function wireAddMathCounter() {
        var mje = editor && editor.mje;
        if (!mje || mje.addMath.__counted) { return; }
        var origAdd = mje.addMath;
        var wrapped = function (json) {
            if (!appRebuild) { mjeAddCount++; }
            if (macroCapture) {
                var capName = macroCapture.name;
                macroCapture = null;
                var node = null;
                try { node = JSON.parse(json); } catch (e) { node = null; }
                if (node) {
                    var items = topItems(); // destructive read, healed below
                    var hit = findPlaceholder(items, capName);
                    if (hit) { swapPlaceholderInSlot(items, hit, [node, '[]']); }
                }
                return; // NOT routed through the core: it belongs in the slot
            }
            return origAdd.apply(this, arguments);
        };
        wrapped.__counted = true;
        mje.addMath = wrapped;
    }

    function addsCount() {
        return mjeAddCount;
    }

    // Ids of the top-level blocks, in order (live preview-row ids — the
    // same ids the drop-shims carry, so findShim() can anchor on them).
    function blockIds() {
        var rows = document.querySelectorAll('#mathslate-editor .mathslate-preview > div');
        var ids = [];
        for (var i = 0; i < rows.length; i++) {
            if (rows[i].textContent.trim() !== '') { ids.push(rows[i].id); }
        }
        return ids;
    }

    // Feed the macro to the toolbox TeX tool exactly as if typed into its
    // input field: a programmatic 'change' event runs its own handler,
    // which converts and addMath()es the parsed node. The name is fed with
    // one trailing space: the tool wraps its verbatim input as the node's
    // tex template, and a control-word space (inert in TeX) keeps the macro
    // from ever merging with a following letter in the document export. If
    // the slate still has not grown after ~5 s, the parse produced nothing
    // (unknown command: the tool silently drops MathJax merror/red output)
    // — degrade to the literal token so the typed name is never lost.
    function parseTeXNode(name, gen) {
        var input = document.querySelector('#mathslate-editor input[type="text"]');
        if (!input) { macroFallback(name, gen); return; }
        var before = addsCount(); // model-exact: survives any render stall
        var restore = input.value;
        input.value = '\\' + name + ' ';
        input.dispatchEvent(new Event('change', {bubbles: true}));
        input.value = restore; // leave the tool's field as it was
        pollUntil(function () {
            return macroState.gen !== gen || addsCount() > before;
        }, function () {
            if (macroState.gen !== gen) { return; } // slate was wiped meanwhile
            deselectSlate();
            modelBlocks++; // the converted node grew the slate
            caretEnd(); // the terminator must append AFTER the converted node
            status('', true);
            resumeInput(); // terminator events queued behind us now run
        }, 300, function () {
            if (macroState.gen !== gen) { return; }
            // If the conversion lands exactly at the deadline, keep it.
            if (addsCount() > before) {
                deselectSlate();
                modelBlocks++;
                caretEnd();
                status('', true);
                resumeInput();
                return;
            }
            macroFallback(name, gen);
        });
    }

    // The TeX tool could not parse the name: keep the old literal behaviour
    // (single monospace mtext whose TeX is the control word), and say so.
    function macroFallback(name, gen) {
        if (macroState.gen !== gen) { return; }
        editor.mje.addMath(JSON.stringify(
            ['mtext', {mathvariant: 'monospace', tex: ['\\' + name + ' ']}, '\\' + name]));
        modelBlocks++;
        deselectSlate();
        caretEnd();
        status('TeX could not parse "\\' + name + '" — kept as literal text.');
        resumeInput();
    }

    function macroReset() { // clear-slate / insert / external wipes
        macroState.active = false;
        macroState.armed = false;
        macroState.inSlot = false;
        macroState.slotIndex = -1;
        macroState.gen++;
        clearSlotFocus();
        programmaticArmIdx = -1;
        setMacroActiveClass(false);
    }

    function macroBackspace() {
        if (macroState.inSlot) {
            var old = macroState.name;
            macroState.armed = false;
            macroState.gen++;
            if (!old) { // only "\\" was there: back out, restore the bare slot box
                macroState.active = false;
                macroState.inSlot = false;
                macroState.slotIndex = -1;
                setMacroActiveClass(false);
                var items0 = topItems(); // destructive read, healed below
                var hit0 = findPlaceholder(items0, '');
                if (hit0) { hit0.arr[hit0.i] = '[]'; setSlotFocusFromItems(items0, hit0.arr); rebuildSlate(items0); }
                refreshCaret();
                resumeInput();
                return;
            }
            macroState.name = old.slice(0, -1);
            var items1 = topItems(); // destructive read, healed below
            var hit1 = findPlaceholder(items1, old);
            if (hit1) { hit1.arr[hit1.i] = macroNode(macroState.name); }
            rebuildSlate(items1);
            refreshCaret();
            return;
        }
        macroState.armed = false;
        macroState.gen++;
        scrubSelection();
        if (!macroState.name) { // only "\" was there: back out entirely
            macroState.active = false;
            setMacroActiveClass(false);
            editor.mje.undo();
            modelBlocks--;
            deselectSlate();
            resumeInput();
            return;
        }
        macroState.name = macroState.name.slice(0, -1);
        var staleBlanks = blankIds();
        editor.mje.undo();
        editor.mje.addMath(JSON.stringify(macroNode(macroState.name)));
        // undo + addMath cancel each other out: modelBlocks unchanged
        attemptArm(staleBlanks);
    }

    function isFormTarget(t) {
        if (!t || !t.tagName) { return false; }
        var tag = t.tagName;
        return t.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA'
            || tag === 'SELECT' || tag === 'IFRAME';
    }

    function wireKeyboard() {
        document.addEventListener('keydown', function (e) {
            if (!editor || !editor.mje) { return; }
            if (e.ctrlKey || e.metaKey || e.altKey) { return; } // leave shortcuts alone
            if (isFormTarget(e.target)) { return; } // typing in inputs stays there

            var mje = editor.mje;

            if (e.key === 'Backspace' || e.key === 'Delete') {
                e.preventDefault();
                enqueue({type: 'backspace'}); // pump decides macro vs top-level
                return;
            }
            if (e.key === 'Escape') {
                enqueue({type: 'escape'}); // pump decides close vs deselect
                return;
            }
            if (e.key === 'Enter') {
                // Enter renders no glyph: it lets the cursor out of a script
                // block, or closes an open TeX-command box like any other
                // terminator.
                e.preventDefault();
                enqueue(script.awaiting ? {type: 'script-exit'} : {type: 'macro-end'});
                return;
            }
            // Cursor lock: while the TeX-command box is open, navigation keys
            // are captured so the "text cursor" cannot leave the box (and the
            // page cannot scroll) until a closing condition is met.
            if (macroState.active
                && /^(ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(e.key)) {
                e.preventDefault();
                return;
            }
            // Cursor navigation: ←/→ step the fake caret (the < and > UI
            // buttons enqueue the same events); stepping past a script
            // block's edge also lets the cursor out.
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                enqueue({type: 'nav', value: e.key === 'ArrowLeft' ? -1 : 1});
                return;
            }
            if (!e.key || e.key.length !== 1) { return; } // F-keys, dead keys, …
            if (e.key === ' ') {
                // Space renders nothing in math, but it lets the cursor out
                // of a script block (or closes an open TeX-command box).
                e.preventDefault();
                enqueue(script.awaiting ? {type: 'script-exit'} : {type: 'macro-end'});
                return;
            }
            if (e.key === '\\') { // TeX command placeholder trigger
                e.preventDefault();
                enqueue({type: 'macro-start'});
                return;
            }
            if (e.key === '^' || e.key === '_') { // TeX script trigger
                e.preventDefault();
                enqueue({type: 'script', value: e.key});
                return;
            }
            if (e.key === '/') { // fraction trigger
                e.preventDefault();
                enqueue({type: 'script', value: '/'});
                return;
            }
            // Every other printable character is queued as a plain 'char':
            // the PUMP — holding a consistent view of macro/script state at
            // dequeue time — routes it: letter accumulates while the box is
            // open, non-letter closes it, otherwise a literal insertion (or a
            // silent drop for unsupported characters, just let it be).
            if (charToSnippetJSON(e.key)) { e.preventDefault(); }
            enqueue({type: 'char', value: e.key});
        });

        // Clicking outside the editor ends a pending trigger: an open macro
        // box is closed (the event is a no-op when none is open), a
        // script/fraction blank box simply remains for point-and-click.
        document.addEventListener('mousedown', function (e) {
            // < and > are caret commands, not "outside" clicks: never let
            // them close a macro box or break a script lock.
            if (e.target.closest && e.target.closest('.caret-nav')) { return; }
            if (!e.target.closest('#mathslate-editor')) {
                enqueue({type: 'macro-end'});
            }
            if (script.awaiting && !e.target.closest('#mathslate-editor')) {
                cancelScript();
                resumeInput();
            }
        });

        /* Upstream crash guard (the core modules are kept verbatim): the
         * preview panel's click delegate in mathjaxeditor.js calls
         * ddnodes.one('#' + this.getAttribute('id')).handleClick(e) with no
         * null check, so clicking the bare preview background — or any inner
         * div whose id has no drag node yet (mid re-render drift) — throws.
         * Swallow exactly those clicks in the capture phase, before the
         * delegate runs; clicks on real preview entries are untouched
         * (their ids always have a shim — the delegate's ddnodes IS the set
         * of absolutely-positioned shim spans findShim() locates). */
        var editorHost = document.getElementById('mathslate-editor');
        editorHost.addEventListener('click', function (e) {
            var t = e.target;
            if (!t || !t.closest) { return; }
            var panel = t.closest('.mathslate-preview');
            if (!panel) { return; }
            var d = t.closest('div');
            if (!d || !panel.contains(d)) { d = panel; }
            var id = d.getAttribute('id');
            if (!id || !findShim(id)) { e.stopImmediatePropagation(); }
        }, true);
    }

    /* ------------------------- *
     * Two-pane document editor. *
     * ------------------------- */

    function insertEquation(display) {
        var tex = requireTeX();
        if (!tex) { return; }
        var wrapped = display ? '\n\\[' + tex + '\\]\n' : '\\(' + tex + '\\)';
        var src = $('document-source');
        // Insert at the caret in the source textarea (replaces any selection).
        if (src.setRangeText) {
            src.setRangeText(wrapped, src.selectionStart, src.selectionEnd, 'end');
        } else {
            src.value += wrapped;
        }
        renderDocument();
        // Commit semantics: the slate is reset so the keyboard flow
        // type → insert → type → insert … never needs a click in between.
        // (Not focusing the source textarea keeps keystrokes going to the
        // slate; click the document if you want to continue prose there.
        // The editor's own undo restores the cleared slate.)
        cancelScript();
        macroReset();
        if (editor && editor.mje) { editor.mje.clear(); }
        caret.gap = 0;
        modelBlocks = 0;
        resumeInput();
        status('Inserted into the document; slate reset for the next equation.');
    }

    // Escape everything, keep newlines as <br>, let MathJax find \( \[ delimiters.
    function renderDocument() {
        var src = $('document-source').value;
        var view = src
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        var area = $('document-area');
        area.innerHTML = view ||
            '<span class="doc-placeholder">The rendered document appears here.</span>';
        queueTypeset(area);
    }

    function queueTypeset(el) {
        if (!window.MathJax || !MathJax.Hub) { return; }
        clearTimeout(typesetTimer);
        typesetTimer = setTimeout(function () {
            MathJax.Hub.Queue(['Typeset', MathJax.Hub, el]);
        }, 250);
    }

    function wireDocumentTools() {
        $('document-source').addEventListener('input', renderDocument);

        $('btn-clear-doc').addEventListener('click', function () {
            $('document-source').value = '';
            renderDocument();
            $('document-source').focus();
            status('Document cleared.');
        });

        $('btn-export').addEventListener('click', function () {
            var src = $('document-source').value;
            if (!src.trim()) {
                status('The document is empty — nothing to export.');
                return;
            }
            var html = '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="utf-8">\n'
                + '<title>Mathslate document</title>\n'
                + '<script src="https://cdn.jsdelivr.net/npm/mathjax@4.1.3/tex-mml-chtml.js"'
                + '><\/script>\n'
                + '<style>body{max-width:42em;margin:2em auto;font-family:Georgia,serif;'
                + 'line-height:1.6}</style>\n</head>\n<body>\n'
                + src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                   .split(/\n{2,}/).map(function (p) {
                       return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
                   }).join('\n')
                + '\n</body>\n</html>\n';
            download(html, 'mathslate-document.html', 'text/html');
            status('Document exported as mathslate-document.html.');
        });
    }

    /* -------------------- *
     * Small DOM utilities. *
     * -------------------- */

    function copyText(text, done) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function () { done(true); },
                function () { legacyCopy(text, done); });
        } else {
            legacyCopy(text, done);
        }
    }

    function legacyCopy(text, done) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = document.execCommand('copy'); } catch (e) { /* ignore */ }
        document.body.removeChild(ta);
        done(ok);
    }

    function download(content, filename, mime) {
        var blob = new Blob([content], {type: mime});
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
    }

    // Seed the document with a worked example, then boot the editor.
    window.addEventListener('load', function () {
        $('document-source').value =
            'Mathslate standalone demo\n'
            + '~~~~~~~~~~~~~~~~~~~~~~~~~\n'
            + 'Use the toolbox above to build an equation on the slate, then press '
            + '"Insert inline" or "Insert display". Try the TeX tab to type TeX by hand, '
            + 'e.g. \\(\\int_0^1 x^2\\,dx = \\tfrac{1}{3}\\).\n\n'
            + 'Display math is centred on its own line:\n'
            + '\\[e^{i\\pi} + 1 = 0\\]';
        renderDocument();
        wireDocumentTools();
        boot();
    });
})();
