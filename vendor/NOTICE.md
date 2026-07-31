# Vendored third-party components

Everything under `vendor/` is third-party code, pinned and unmodified except
where noted, so the standalone app runs with no network access.

| Path | Project | Version | License | Notes |
| --- | --- | --- | --- | --- |
| `vendor/mathjax/tex-mml-chtml.js`, `vendor/mathjax/sre/` | [MathJax](https://www.mathjax.org/) (`mathjax` npm package) | 4.1.3 | Apache-2.0 (see `vendor/mathjax/LICENSE`) | |
| `vendor/fonts/mathjax-newcm-font/` | [`@mathjax/mathjax-newcm-font`](https://github.com/mathjax/mathjax-fonts) (New Computer Modern webfont + dynamic font data) | 4.1.3 | Apache-2.0 | |
| `vendor/yui/` | [YUI 3](https://clarle.github.io/yui3/) (`yui` npm package build tree) | 3.18.1 | [BSD-3-Clause](https://github.com/yui/yui3/blob/master/LICENSE.md) | The rollup files the loader requests (`node/`, `event/`, `dom/`, …) are absent from the npm tree and were regenerated as concatenations of their submodules (each carries a header comment saying so). The shared skin sprite `vendor/yui/assets/skins/sam/sprite.png` (absent from npm) was recreated to match the offsets referenced by `tabview-skin.css`. |
