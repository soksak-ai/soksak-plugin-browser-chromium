# soksak-plugin-browser

A web browser for soksak, backed by the operating system's native web view. It opens a
browser — address bar, back/forward/reload, bookmarks, developer tools — as a content tab
and adds a **Browser** item to the new-tab (+) menu.

The web view is provided by soksak's core (`app.webview.*`); a plugin cannot create one. This
plugin drives the web view and provides the surrounding browser interface and settings.

## Usage

From the + menu (**Browser**), or:

```bash
sok view.open '{"program":"browser"}'
sok plugin.soksak-plugin-browser.navigate '{"url":"https://example.com"}'
```

A new tab opens at `homeUrl`.

## Settings

| key | default | description |
|---|---|---|
| `homeUrl` | `about:blank` | address a new tab opens to |
| `browserNewWindow` | `tab` | open `target=_blank` / `window.open` links in a new tab or a new window |

## Commands

- Navigation: `navigate`, `back`, `forward`, `reload`, `open`, `devtools`, `list`
- Page automation: `eval`, `dom.text` / `dom.html` / `dom.query` / `dom.click` / `dom.fill` / `dom.submit` / `dom.wait-for`, `media.sniff` / `media.extract`

```bash
sok plugin.soksak-plugin-browser.navigate '{"url":"https://example.com"}'
sok plugin.soksak-plugin-browser.dom.text  '{"selector":"h1"}'
```

Each acts on the active browser; pass `viewId` to target a specific one.

## Permissions

| permission | for |
|---|---|
| `ui` | the content view |
| `commands` | the commands above |
| `programs` | the + menu entry |
| `webview` | driving the web view (`app.webview.*`) |
| `network` | loading pages |
| `data` | storing bookmarks |
