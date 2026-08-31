/**
 * Wrap the four delivered archify maps in one tabbed page.
 *
 * Each map is a complete standalone document with its own stylesheet, its own
 * global `Archify`, and its own element ids. Concatenating them into one DOM
 * would have them overwrite each other, so each one keeps its own document
 * inside a same-origin iframe and the shell only decides which is on screen.
 *
 * Run with `node build.mjs` from this directory. Inputs are maps/*.html (each
 * one delivered by archify from the matching src/*.archify.json); the output
 * is kuber-system-maps.html, the single page published as the Artifact.
 *
 * The documents are carried as base64 rather than inline markup: an archify
 * document contains `</script>` sequences that would end the carrier element,
 * and base64 has no character the HTML parser treats as markup.
 */
import fs from "node:fs";

const MAPS = [
  {
    id: "system",
    file: "maps/architecture.html",
    n: "01",
    label: "System map",
    blurb: "Every moving part, and which of them costs money",
  },
  {
    id: "pipeline",
    file: "maps/dataflow.html",
    n: "02",
    label: "Lead pipeline",
    blurb: "How a name becomes an email, stage by stage",
  },
  {
    id: "lifecycle",
    file: "maps/lifecycle.html",
    n: "03",
    label: "Lead lifecycle",
    blurb: "Every state a lead passes through, and how it ends",
  },
  {
    id: "drafting",
    file: "maps/workflow.html",
    n: "04",
    label: "Writing an email",
    blurb: "The prompt, the two guards, and the fallback ladder",
  },
];

/**
 * Every archify export (PNG / JPEG / WebP / SVG / WebM) funnels through one
 * `download()` helper that builds an `<a download>`. That anchor is inert in
 * the artifact viewer, and inside an iframe `window.claude` does not exist at
 * all — the host injects it into the top frame only. So the helper is rewritten
 * to walk up to the top window's capability, and to keep the plain anchor for
 * the standalone copies in the repo.
 */
const DOWNLOAD_ANCHOR = "function download(blob, filename) {";
const DOWNLOAD_PATCH = `function download(blob, filename) {
        var viaAnchor = function () {
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        };
        var host = null;
        try {
          if (window.claude && typeof window.claude.use === 'function') host = window.claude;
          else if (window.top && window.top.claude && typeof window.top.claude.use === 'function') host = window.top.claude;
        } catch (e) { host = null; }
        if (!host) { viaAnchor(); return; }
        host.use('downloads').then(function (d) {
          if (!d) { viaAnchor(); return null; }
          return d.save({ filename: filename, data: blob });
        }).catch(function () { /* declined, rate limited, or unavailable */ });
        return;
      }
      function downloadUnused(blob, filename) {`;

function patchExports(src, file) {
  const hits = (src.match(/function download\(/g) || []).length;
  if (hits !== 1) throw new Error(`${file}: expected 1 download() helper, found ${hits}`);
  return src.replace(DOWNLOAD_ANCHOR, DOWNLOAD_PATCH);
}

const payload = MAPS.map((m) => {
  const src = patchExports(fs.readFileSync(new URL(`./${m.file}`, import.meta.url), "utf8"), m.file);
  return { id: m.id, b64: Buffer.from(src, "utf8").toString("base64") };
});

const tabs = MAPS.map((m, i) => `
      <button class="tab" role="tab" id="tab-${m.id}" data-map="${m.id}"
              aria-controls="panel-${m.id}" aria-selected="${i === 0 ? "true" : "false"}"
              tabindex="${i === 0 ? "0" : "-1"}">
        <span class="tab-n">${m.n}</span>
        <span class="tab-text">
          <span class="tab-label">${m.label}</span>
          <span class="tab-blurb">${m.blurb}</span>
        </span>
      </button>`).join("");

const html = `<title>Kuber System Maps</title>
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap">
<style>
  /* The maps themselves are monospace and near-black; the shell is deliberately
     the same material so the tab rail reads as part of the instrument rather
     than a wrapper bolted around it. Light palette on bare :root, redefined for
     the un-stamped system-dark case and again for an explicit dark choice. */
  :root {
    --ground: #eef1f4;
    --rail: #f7f9fb;
    --line: #d3dae1;
    --ink: #10151b;
    --ink-dim: #5b6975;
    --accent: #0b7fa8;
    --accent-soft: rgba(11, 127, 168, 0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #080b0f;
      --rail: #0e1319;
      --line: #1e2731;
      --ink: #e6edf3;
      --ink-dim: #8298aa;
      --accent: #38bdf8;
      --accent-soft: rgba(56, 189, 248, 0.12);
    }
  }
  :root[data-theme="dark"] {
    --ground: #080b0f;
    --rail: #0e1319;
    --line: #1e2731;
    --ink: #e6edf3;
    --ink-dim: #8298aa;
    --accent: #38bdf8;
    --accent-soft: rgba(56, 189, 248, 0.12);
  }

  body {
    margin: 0;
    background: var(--ground);
    color: var(--ink);
    font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    -webkit-font-smoothing: antialiased;
  }

  /* Flex column instead of calc(100dvh - <magic number>): the blurbs wrap to
     two lines at some widths, so any hardcoded rail height is wrong somewhere. */
  .shell { height: 100dvh; display: flex; flex-direction: column; }

  .rail {
    flex: 0 0 auto; z-index: 10;
    display: flex; gap: 0;
    background: var(--rail);
    border-bottom: 1px solid var(--line);
    overflow-x: auto;
  }
  .tab {
    flex: 1 1 0; min-width: 210px;
    display: flex; align-items: flex-start; gap: 10px;
    padding: 13px 16px;
    background: none; border: 0; border-right: 1px solid var(--line);
    color: var(--ink-dim);
    font: inherit; text-align: left; cursor: pointer;
    position: relative;
    transition: color .12s, background .12s;
  }
  .tab:last-child { border-right: 0; }
  .tab:hover { color: var(--ink); background: var(--accent-soft); }
  /* The rule sits inside the button so it cannot shift the rail's height. */
  .tab::after {
    content: ""; position: absolute; left: 0; right: 0; bottom: -1px;
    height: 2px; background: transparent;
  }
  .tab[aria-selected="true"] { color: var(--ink); background: var(--accent-soft); }
  .tab[aria-selected="true"]::after { background: var(--accent); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  /* 01..04 is a reading order, not decoration: the maps zoom from the whole
     system down to a single email. */
  .tab-n {
    font-size: 10px; font-weight: 700; letter-spacing: .08em;
    color: var(--accent); padding-top: 3px; font-variant-numeric: tabular-nums;
  }
  .tab-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .tab-label { font-size: 13px; font-weight: 500; }
  .tab-blurb { font-size: 10.5px; line-height: 1.45; color: var(--ink-dim); }

  .stage { flex: 1 1 auto; min-height: 0; }
  .panel { display: none; height: 100%; }
  .panel.on { display: block; }
  .panel iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--ground); }

  .loading {
    display: grid; place-items: center; height: 100%;
    color: var(--ink-dim); font-size: 12px; letter-spacing: .04em;
  }

  @media (max-width: 720px) {
    .rail { flex-wrap: nowrap; }
    .tab { min-width: 172px; }
    .tab-blurb { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .tab { transition: none; } }
</style>

<div class="shell">
<div class="rail" role="tablist" aria-label="Kuber system maps">${tabs}
</div>
<div class="stage">
${MAPS.map((m, i) => `  <div class="panel${i === 0 ? " on" : ""}" id="panel-${m.id}" role="tabpanel" aria-labelledby="tab-${m.id}"><div class="loading">loading ${m.label.toLowerCase()}…</div></div>`).join("\n")}
</div>

<script id="maps" type="application/json">${JSON.stringify(payload)}</script>
<script>
(function () {
  var MAPS = JSON.parse(document.getElementById("maps").textContent);
  var byId = {};
  MAPS.forEach(function (m) { byId[m.id] = m; });
  var order = MAPS.map(function (m) { return m.id; });

  /* base64 holds UTF-8 bytes; atob gives one char per byte, so the bytes have
     to be rebuilt before decoding or every em dash and middot breaks. */
  function decode(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  function shellTheme() {
    var explicit = document.documentElement.getAttribute("data-theme");
    if (explicit === "dark" || explicit === "light") return explicit;
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  /* Each map resolves its own theme from the OS, which would drift from an
     explicit choice made on the host. Same-origin srcdoc lets the shell keep
     them in step. */
  function syncTheme(frame) {
    try {
      var d = frame.contentDocument;
      if (d && d.documentElement) d.documentElement.setAttribute("data-theme", shellTheme());
    } catch (e) { /* not ready yet, or blocked — the map still renders */ }
  }

  var frames = {};
  function mount(id) {
    if (frames[id]) { syncTheme(frames[id]); return; }
    var panel = document.getElementById("panel-" + id);
    var frame = document.createElement("iframe");
    frame.title = document.getElementById("tab-" + id).querySelector(".tab-label").textContent;
    frame.addEventListener("load", function () { syncTheme(frame); });
    frame.srcdoc = decode(byId[id].b64);
    panel.textContent = "";
    panel.appendChild(frame);
    frames[id] = frame;
  }

  function show(id, focusTab) {
    if (!byId[id]) id = order[0];
    order.forEach(function (other) {
      var tab = document.getElementById("tab-" + other);
      var on = other === id;
      tab.setAttribute("aria-selected", on ? "true" : "false");
      tab.tabIndex = on ? 0 : -1;
      document.getElementById("panel-" + other).classList.toggle("on", on);
    });
    mount(id);
    if (focusTab) document.getElementById("tab-" + id).focus();
    if (location.hash.slice(1) !== id) history.replaceState(null, "", "#" + id);
  }

  order.forEach(function (id) {
    document.getElementById("tab-" + id).addEventListener("click", function () { show(id); });
  });

  document.querySelector(".rail").addEventListener("keydown", function (e) {
    var i = order.indexOf(document.activeElement.dataset.map);
    if (i < 0) return;
    if (e.key === "ArrowRight") { e.preventDefault(); show(order[(i + 1) % order.length], true); }
    if (e.key === "ArrowLeft") { e.preventDefault(); show(order[(i - 1 + order.length) % order.length], true); }
    if (e.key === "Home") { e.preventDefault(); show(order[0], true); }
    if (e.key === "End") { e.preventDefault(); show(order[order.length - 1], true); }
  });

  window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });

  var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  if (mq && mq.addEventListener) mq.addEventListener("change", function () {
    order.forEach(function (id) { if (frames[id]) syncTheme(frames[id]); });
  });
  new MutationObserver(function () {
    order.forEach(function (id) { if (frames[id]) syncTheme(frames[id]); });
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  show(location.hash.slice(1) || order[0]);
})();
</script>
`;

fs.writeFileSync(new URL("./kuber-system-maps.html", import.meta.url), html);
console.log("built kuber-system-maps.html:", (html.length / 1e6).toFixed(2), "MB");
