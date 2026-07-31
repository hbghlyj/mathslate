/*
 * mathjax4-shim.js — MathJax v2 API facade over MathJax v4.
 *
 * The Mathslate editor modules (mathjaxeditor.js, editor.js, textool.js)
 * date from the MathJax 2.7 era and drive it through the v2 runtime API:
 *
 *    MathJax.Hub.Queue(['Typeset', MathJax.Hub, node], function () {}, ...)
 *    MathJax.Hub.Register.StartupHook('TeX Jax Config' | 'End', fn)
 *    MathJax.Hub.getAllJax(node)[0]  ->  jax.Text(tex) / jax.root.toMathML('')
 *    MathJax.Ajax.Require('[MathJax]/extensions/toMathML.js')
 *    MathJax.HTML.addElement(parent, 'math', {display: 'block'}, struct)
 *    MathJax.Callback(fn)(args)
 *
 * MathJax v4 (v3 line) has no Hub, no Callback-restarts and no Ajax loader:
 * typesetting is promise-based. Rather than editing the upstream modules,
 * this file implements the sliver of v2 API they need on top of the v4
 * component build, so v4 drops in underneath them. Semantics preserved:
 *
 *  - Queue() runs tasks strictly in order, awaiting promise returns —
 *    the render -> makeDraggable sequencing the editor relies on.
 *  - StartupHook('TeX Jax Config') fires after MathJax is up but before
 *    'End', which fires once the initially queued work has drained —
 *    matching v2's startup, where queued callbacks ran before the End
 *    signal.
 *  - getAllJax() returns shims around v4 MathItems: Text() re-typesets
 *    the host element's contents (MathML markup as-is, TeX with display
 *    delimiters — ElementJax.Text kept them), root.toMathML() serializes
 *    the internal MathML tree with v4's data-semantic/data-latex
 *    attributes stripped (the v2-era MathML parser in textool.js only
 *    understands plain [a-z] attribute names).
 *  - Typeset also converts legacy <script type="math/tex"> markers to
 *    \( \) / \[ \] delimiters (v4 no longer finds them) and sweeps
 *    detached MathItems out of the MathDocument.
 *
 * MathJax 4 component build: tex-mml-chtml (TeX + MathML input, CHTML
 * output), pinned version, fonts resolved from the configured CDN path.
 * The window.MathJax v4 CONFIGURATION object lives in index.html (it must
 * be set before the component loads); this file is loaded right after the
 * component, before the Mathslate modules.
 *
 * Standalone wrapper: same GPL v3 license as Mathslate itself.
 */
(function () {
    'use strict';

    var MJ = window.MathJax;
    if (!MJ || !MJ.startup) {
        // The component failed to load: leave window.MathJax half-shimmed
        // so the app's boot guard keeps waiting instead of crashing.
        window.MathJax = window.MathJax || {};
        window.MathJax.Hub = window.MathJax.Hub || {Queue: function () {}};
        return;
    }

    var chain = [];             // FIFO of queued task specs
    var draining = false;
    var readyPromise = null;

    var configHooks = [];       // 'TeX Jax Config' hooks
    var endHooks = [];          // 'End' hooks
    var hooksFired = {config: false, end: false};

    function ready() {
        if (!readyPromise) {
            readyPromise = new Promise(function (resolve) {
                (function check() {
                    if (MJ.startup && MJ.startup.promise) {
                        MJ.startup.promise.then(function () { resolve(); });
                    } else {
                        setTimeout(check, 25);
                    }
                })();
            });
        }
        return readyPromise;
    }

    function elResolve(arg) {
        if (!arg) { return document.body; }
        if (typeof arg === 'string') { return document.getElementById(arg); }
        if (arg && arg.getDOMNode) { return arg.getDOMNode(); } // YUI node
        return arg;
    }

    /* v4 stopped treating <script type="math/tex"> as math. The toolbox's
     * initial placeholder still uses that v2 idiom, so convert such script
     * nodes to delimiter text before typesetting a container. */
    function legacyScripts(el) {
        var scripts = el.querySelectorAll('script[type="math/tex"], script[type="math/tex; mode=display"]');
        for (var i = 0; i < scripts.length; i++) {
            var display = /mode\s*=\s*display/.test(scripts[i].type || '');
            var tex = scripts[i].textContent || '';
            var text = display ? '\\[' + tex + '\\]' : '\\(' + tex + '\\)';
            scripts[i].parentNode.replaceChild(document.createTextNode(text), scripts[i]);
        }
    }

    /* Containers that re-render (the canvas, the toolbox, the TeX-tool
     * preview, the document pane) orphan their old MathItems. Gently drop
     * items whose output is gone from the document so the list cannot grow
     * without bound. */
    function sweep() {
        var doc = MJ.startup.document;
        if (!doc || typeof doc.getMathItemsWithin !== 'function'
            || typeof doc.removeMath !== 'function') {
            return;
        }
        var gone = [];
        try {
            var items = doc.getMathItemsWithin(document.documentElement);
            for (var i = 0; i < items.length; i++) {
                var root = items[i].typesetRoot;
                if (root && !document.contains(root)) { gone.push(items[i]); }
            }
        } catch (e) {
            return;
        }
        gone.forEach(function (item) {
            try { doc.removeMath(item); } catch (e) { /* best effort */ }
        });
    }

    function typesetTask(arg) {
        var el = elResolve(arg);
        if (!el) { return null; }
        if (el.querySelectorAll) { legacyScripts(el); }
        sweep();
        return MJ.typesetPromise([el]).catch(function (err) {
            console.error('MathJax 4 typeset failed:', err);
        });
    }

    /* The serialized internal MathML of v4 carries annotation attributes
     * (data-semantic-*, data-latex, xmlns on the root). The v2-era parser
     * in textool.js only tolerates plain [a-z] attribute names, so strip
     * the annotations: what remains matches what v2's toMathML emitted. */
    function sanitizeMML(mml) {
        return mml.replace(/\s+data-[A-Za-z-]+="[^"]*"/g, '');
    }

    function stampSourceScript(host, markup) {
        if (!host || !/^\s*<math/i.test(markup)) { return; }
        var old = host.querySelectorAll(':scope > script[type="math/mml"]');
        for (var i = 0; i < old.length; i++) { host.removeChild(old[i]); }
        var s = document.createElement('script');
        s.type = 'math/mml';
        s.style.display = 'none';
        s.textContent = markup;
        host.appendChild(s);
    }

    /* ElementJax.Text: re-typeset the host's contents with new source.
     * MathML markup is inserted as-is (the canvas's serialized slate);
     * anything else is raw TeX typed into the TeX tool's preview span,
     * which v2 typeset with the original display delimiters. */
    function textTask(item, host, text) {
        if (!host || !host.isConnected) { return null; }
        var doc = MJ.startup.document;
        if (doc && typeof doc.removeMath === 'function') {
            try { doc.removeMath(item); } catch (e) { /* best effort */ }
        }
        if (/^\s*<math/i.test(text)) {
            host.innerHTML = text;
        } else {
            host.textContent = '\\[' + text + '\\]';
        }
        var done = typesetTask(host);
        return Promise.resolve(done).then(function () {
            stampSourceScript(host, text);
        });
    }

    function wrapJax(item, host) {
        return {
            __v4: true,
            __host: host,
            root: {
                toMathML: function () {
                    return sanitizeMML(MJ.startup.toMML(item.root));
                }
            },
            Text: function (text) { return textTask(item, host, text); }
        };
    }

    /* A canvas render spec: ['Text', jax, '<math>…</math>'] — a pure view
     * refresh. (The TeX tool's ['Text', jax, rawTex] is NOT one: each of
     * those feeds a MathML parse that must run.) Fast typing queues a whole
     * staircase of such renders; with v4 typesetting being asynchronous the
     * queue falls behind and interim render callbacks (makeDraggable) start
     * working against snapshots their later rekeys already invalidated —
     * plus every skipped frame is typesetting time saved. */
    function isRenderText(spec) {
        return Array.isArray(spec) && spec.length === 3 && spec[0] === 'Text'
            && spec[1] && spec[1].__v4 === true
            && typeof spec[2] === 'string' && /^\s*<math/i.test(spec[2]);
    }
    function obsoleteRender(spec) {
        for (var i = 0; i < chain.length; i++) {
            var later = chain[i];
            if (isRenderText(later) && later[1].__host === spec[1].__host) {
                return true;
            }
        }
        return false;
    }

    function getAllJax(node) {
        var el = elResolve(node);
        if (!el) { return []; }
        var doc = MJ.startup.document;
        if (!doc || typeof doc.getMathItemsWithin !== 'function') { return []; }
        var items = [];
        try { items = doc.getMathItemsWithin(el); } catch (e) { return []; }
        return items.map(function (item) { return wrapJax(item, el); });
    }

    /* v2 MathJax.HTML.addElement(parent, 'math', {display: 'block'}, math)
     * builds a DOM subtree from the editor's [tag, attrs, content] model
     * triples — exactly the shape the model itself uses. */
    function buildStruct(struct) {
        var tag = struct[0];
        var def = struct[1] || {};
        var content = struct[2];
        var el = document.createElement(tag);
        for (var attr in def) {
            if (typeof def[attr] !== 'object') { el.setAttribute(attr, def[attr]); }
        }
        appendContent(el, content);
        return el;
    }

    function appendContent(el, content) {
        if (content === null || typeof content === 'undefined') { return; }
        if (typeof content === 'string') {
            el.appendChild(document.createTextNode(content));
            return;
        }
        if (Array.isArray(content)) {
            content.forEach(function (c) {
                if (typeof c === 'string') {
                    el.appendChild(document.createTextNode(c));
                } else if (Array.isArray(c)) {
                    el.appendChild(buildStruct(c));
                }
            });
        }
    }

    function Callback(spec) {
        if (typeof spec === 'function') {
            return function () { return spec.apply(null, arguments); };
        }
        if (Array.isArray(spec)) {
            var obj = spec[1] || window;
            var args = spec.slice(2);
            return function () { return obj[spec[0]].apply(obj, args); };
        }
        return function () {};
    }
    Callback.After = function (spec, after) {
        // v2 used this for async restarts, which v4 never raises.
        if (after && typeof after.call === 'function') { after.call(window); }
        return Callback(spec)();
    };

    function runSpec(spec) {
        if (typeof spec === 'function') { return spec(); }
        if (Array.isArray(spec)) {
            var name = spec[0];
            if (name === 'Typeset') {       // ['Typeset', Hub, nodeOrId?]
                return typesetTask(spec.length > 2 ? spec[2] : null);
            }
            var obj = spec[1];
            return obj[name].apply(obj, spec.slice(2));
        }
        return null;
    }

    /* Fire the deferred startup hooks once the queue goes quiet: 'TeX Jax
     * Config' after MathJax is up, then 'End' — which typically enqueues
     * more work (the toolbox build), so the drain loop keeps going until
     * nothing remains and every hook has fired. */
    function fireHooks() {
        if (!hooksFired.config) {
            if (!configHooks.length && !endHooks.length) { return false; }
            hooksFired.config = true;
            configHooks.forEach(function (f) {
                try { f.call(window, MJ.startup.signal ? MJ.startup.signal : null); }
                catch (e) { try { f(); } catch (e2) { console.error(e2); } }
            });
            return true;
        }
        if (!hooksFired.end && endHooks.length) {
            hooksFired.end = true;
            endHooks.forEach(function (f) {
                try { f(); } catch (e) { console.error(e); }
            });
            return true;
        }
        return false;
    }

    function drain() {
        if (draining) { return; }
        draining = true;
        ready().then(function loop() {
            if (chain.length) {
                var spec = chain.shift();
                if (isRenderText(spec) && obsoleteRender(spec)) {
                    // Outdated view refresh: skip it AND the post-render
                    // callback the core queued with it (makeDraggable), so
                    // it never runs against the stale snapshot.
                    if (chain.length && typeof chain[0] === 'function') { chain.shift(); }
                    return loop();
                }
                var out;
                try { out = runSpec(spec); }
                catch (e) { console.error('Mathslate queue task failed:', e); out = null; }
                return Promise.resolve(out)
                    .catch(function (e) { console.error('Mathslate queue task failed:', e); })
                    .then(loop);
            }
            if (fireHooks()) { return loop(); }
            draining = false;
            return null;
        }).catch(function (e) {
            draining = false;
            console.error('Mathslate queue failed:', e);
        });
    }

    MJ.Hub = {
        Queue: function () {
            for (var i = 0; i < arguments.length; i++) { chain.push(arguments[i]); }
            drain();
        },
        // True only when every queued task's promise has settled: the sole
        // moment the DOM is guaranteed to reflect the current model.
        isQuiet: function () { return !draining && chain.length === 0; },
        getAllJax: getAllJax,
        Typeset: function (arg) { return typesetTask(arg); },
        Register: {
            StartupHook: function (phase, f) {
                if (phase === 'TeX Jax Config') { configHooks.push(f); }
                else if (phase === 'End') { endHooks.push(f); }
            },
            MessageHook: function () {}
        },
        processSectionDelay: 0,
        processUpdateTime: 0
    };
    MJ.Callback = Callback;
    MJ.Ajax = {
        Require: function () {},          // v4: toMathML is built in
        Load: function () {},
        loadComplete: function () {}
    };
    MJ.HTML = {
        addElement: function (parent, type, def, content) {
            var el = buildStruct([type, def, content]);
            parent.appendChild(el);
            return el;
        },
        useMathJaxSpacing: false
    };
})();
