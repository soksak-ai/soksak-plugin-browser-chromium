// browser 플러그인 i18n — 사람 UI 텍스트(URL 바·즐겨찾기·버튼). 호스트 표시 언어로 해소.
type Dict = Record<string, string>;

const EN: Dict = {
  back: "Back",
  forward: "Forward",
  reload: "Reload",
  urlPlaceholder: "Enter URL or search",
  bookmark: "Add/remove bookmark",
  bookmarks: "Bookmarks",
  addBookmark: "Add bookmark",
  removeBookmark: "Remove bookmark",
  noBookmarks: "No bookmarks",
  inspect: "Inspect (devtools)",
};

const KO: Dict = {
  back: "이전",
  forward: "이후",
  reload: "새로고침",
  urlPlaceholder: "URL 또는 검색어 입력",
  bookmark: "즐겨찾기 추가/제거",
  bookmarks: "즐겨찾기 목록",
  addBookmark: "즐겨찾기 추가",
  removeBookmark: "즐겨찾기 제거",
  noBookmarks: "즐겨찾기가 없습니다",
  inspect: "인스펙트(devtools)",
};

export function t(key: string, lang: string): string {
  const dict = lang === "ko" ? KO : EN;
  return dict[key] ?? EN[key] ?? key;
}
