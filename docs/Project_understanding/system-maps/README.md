# System maps

Four interactive diagrams of Kuber, in one tabbed page.

| Tab | Answers |
|---|---|
| 01 System map | Every moving part, and which of them cost money |
| 02 Lead pipeline | Import → Scrape → Extract → Draft → Deliver |
| 03 Lead lifecycle | Every state a lead passes through, and how it ends |
| 04 Writing an email | The prompt, the two guards, the fallback ladder |

Built with [archify](https://github.com/tt-a1i/archify). Every map passes its
`showcase` profile: 9/9 artifact checks, 0 errors, 0 warnings.

---

## What is in here

```
kuber-system-maps.html    ← THE FILE. Standalone, 3.9 MB, opens offline.
build.mjs                 ← rebuilds the above from maps/
maps/*.html               ← the four maps, each standalone on its own
src/*.archify.json        ← the sources. Edit these, not the HTML.
```

`kuber-system-maps.html` needs no server, no internet (bar the webfont) and no
build step. Double-click it and it works. That is the whole point of it.

---

## Sharing it — three ways, pick by how permanent you need it

### 1. Just send the file  ·  *fastest, works forever*

Attach `kuber-system-maps.html` to an email, WhatsApp, Slack or Drive. It is one
self-contained file. Whoever opens it gets every tab, pan/zoom, search, both
themes and export, with no login and no link that can expire.

**Use this to show your senior today.**

### 2. The Artifact link  ·  *zero deploy, stays in sync*

Already published. Open it, press **Share**, send the link.

Caveat worth knowing: the link is tied to the Claude account that published it.
When the signed-in account changed mid-session, the first link died and a new
one had to be published. So it is great for a quick review, and the wrong
choice for a link you want to still work in six months.

### 3. Serve it from the app  ·  *a permanent URL*

The app already deploys to Vercel, so this costs no new infrastructure:

```bash
mkdir -p public
cp docs/Project_understanding/system-maps/kuber-system-maps.html public/system-maps.html
git add public/system-maps.html && git commit -m "Publish the system maps"
git push
```

Next.js serves anything in `public/` as-is, so it lands at:

```
https://<your-vercel-domain>/system-maps.html
```

**Read this before you do it.** `public/` is world-readable — anyone with the
URL sees it, with no login. These maps carry no keys, no customer data and no
lead data, but they do describe internals: table names, route paths, which
providers we use and where credits are spent. That is fine for a link you pass
around the team, and not something to post publicly.

If it needs to be behind the login, don't use `public/` — add it as a route
under `app/(app)/` instead, which puts it behind the same auth as the rest of
the app.

---

## Changing a map

Edit the JSON in `src/`, never the HTML. Then, from the archify checkout:

```bash
node bin/archify.mjs validate  <type> <src.json> --quality showcase --json
node bin/archify.mjs deliver   <type> <src.json> <out.html> --quality showcase --json
node bin/archify.mjs visual-check <out.html> --json
```

`<type>` is `architecture`, `dataflow`, `lifecycle` or `workflow` — matching the
filename. Then rebuild the tabbed page:

```bash
node build.mjs
```

### Two constraints that are not obvious

The validator is strict and its errors are precise — read the evidence it
prints rather than guessing. Two rules cost the most iterations:

- **viewBox width caps around 1085px.** Wider, and node sub-labels project below
  the 6px readable floor at a 1440px viewport. Shorter sub-labels buy back room,
  because the renderer shrinks text to fit the box.
- **The panel wants roughly 3:1.** Taller, and the page overflows a 900px
  screen. These two pull against each other; that tension is why the pipeline
  map is one row rather than three.

Tab 04 (workflow) is the one known miss: it runs ~84px past a 900px-tall screen
and fits from 1920 up. Workflow diagrams compute geometry from lane count, so
there is no viewBox to flatten. Inside a scrolling tab it reads fine.

---

## Why the maps sit in iframes

Each map is a complete document with its own stylesheet, its own global
`Archify` and its own element ids. Concatenated into one DOM they would
overwrite each other, so each keeps its own document in a same-origin iframe and
the shell only decides which is on screen. They are carried as base64 because an
archify document contains `</script>`, which would end the carrier element.

`build.mjs` also rewrites each map's `download()` helper. Every export path
funnels through that one function, and it builds an `<a download>` — which is
inert inside the Artifact viewer, where `window.claude` exists only in the top
frame. The patched version walks up to the host capability and keeps the plain
anchor for the standalone copies here.
