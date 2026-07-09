# soksak-plugin-browser-chromium

A web browser for soksak backed by a bundled Chromium (CEF) engine, not the
operating system web view. It opens a browser — address bar, back/forward/reload,
bookmarks, developer tools — as a content tab and adds a **Browser (Chromium)**
item to the new-tab (+) menu.

The engine runs as the `browser-chromium` sidecar (`soksak-sidecar-browser-spec`),
an in-process module that owns a native child view composited into a DOM hole. This
plugin drives that engine over the sidecar protocol and provides the surrounding
browser interface and settings. Rendering is windowed (the engine paints its own
view); the same engine also offers an offscreen mode consumed by
`soksak-plugin-browser-osr`.

## Usage

From the + menu (**Browser (Chromium)**), or:

```bash
sok view.open '{"program":"browser-chromium"}'
sok plugin.soksak-plugin-browser-chromium.navigate '{"url":"https://example.com"}'
```

A new tab opens at `homeUrl`.

## Settings

| key | default | description |
|---|---|---|
| `homeUrl` | `about:blank` | address a new tab opens to |
| `browserNewWindow` | `tab` | open `target=_blank` / `window.open` links in a new tab or a new window |
| `devtoolsScreencast` | `false` | show the inspected page preview inside DevTools |
| `devtoolsOpenMode` | `tab` | open DevTools as an independent tab or split inside the browser view |

## Commands

- Navigation: `navigate`, `back`, `forward`, `reload`, `open`
- DevTools: `devtools`, `devtools-tab`, `devtools-inline`
- Diagnostics: `ping`, `stats` (live engine child ids), `gc` (reap unreferenced engine children)

```bash
sok plugin.soksak-plugin-browser-chromium.navigate '{"url":"https://example.com"}'
sok plugin.soksak-plugin-browser-chromium.stats
```

Each acts on the active browser; pass `viewId` to target a specific one.

## Permissions

| permission | for |
|---|---|
| `ui` | the content view |
| `commands` / `commands:destructive` | the commands above (`gc` is destructive) |
| `programs` | the + menu entry |
| `sidecar` | driving the `browser-chromium` engine |
| `webview` | the DOM-hole host cell the engine view composites into |
| `data` | storing bookmarks |
