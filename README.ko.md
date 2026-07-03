# soksak-plugin-browser

운영체제의 네이티브 웹뷰로 동작하는 soksak 웹 브라우저 플러그인. 주소창·뒤로/앞으로/
새로고침·즐겨찾기·개발자 도구를 갖춘 브라우저를 콘텐츠 탭으로 열고, 새 탭(+) 메뉴에
**브라우저** 항목을 추가한다.

웹뷰는 soksak 코어가 제공한다(`app.webview.*`) — 플러그인은 직접 만들 수 없다. 이 플러그인은
그 웹뷰를 구동하고, 주소창·버튼·즐겨찾기 등 브라우저 UI와 설정을 제공한다.

## 사용

새 탭(+) 메뉴의 **브라우저**, 또는:

```bash
sok view.open '{"program":"browser"}'
sok plugin.soksak-plugin-browser.navigate '{"url":"https://example.com"}'
```

새 탭은 `homeUrl`로 열린다.

## 설정

| 키 | 기본값 | 설명 |
|---|---|---|
| `homeUrl` | `about:blank` | 새 탭이 처음 여는 주소 |
| `browserNewWindow` | `tab` | `target=_blank` / `window.open` 새 링크를 새 탭 또는 새 창으로 |

## 명령

- 내비게이션: `navigate`, `back`, `forward`, `reload`, `open`, `devtools`, `list`
- 페이지 자동화: `eval`, `dom.text` / `dom.html` / `dom.query` / `dom.click` / `dom.fill` / `dom.submit` / `dom.wait-for`, `media.sniff` / `media.extract`

```bash
sok plugin.soksak-plugin-browser.navigate '{"url":"https://example.com"}'
sok plugin.soksak-plugin-browser.dom.text  '{"selector":"h1"}'
```

각 명령은 활성 브라우저에 적용된다. `viewId`로 특정 브라우저를 지정할 수 있다.

## 권한

| 권한 | 용도 |
|---|---|
| `ui` | 콘텐츠 뷰 |
| `commands` | 위 명령 |
| `programs` | + 메뉴 항목 |
| `webview` | 웹뷰 구동(`app.webview.*`) |
| `network` | 페이지 로드 |
| `data` | 즐겨찾기 저장 |
