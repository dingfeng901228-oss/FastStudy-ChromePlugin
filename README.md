# FastStudy Chrome Plugin

> Japanese vocabulary collector Chrome extension for [FastStudy](https://jp.frank2025.com/).
> Spec: see [spec.md](./spec.md) · Status: **MVP scaffold ready (v1.0.0)**

Save Japanese words from any webpage to your FastStudy vocabulary with a single right-click. No account creation, no copy-paste — just select → right-click → "收藏为生词".

## What it does

- Right-click any selected Japanese text on any webpage → "收藏为生词" (Save as vocabulary)
- The selected word, source URL, and page title are sent to your [FastStudy](https://jp.frank2025.com/) account
- Offline-safe: failed saves queue locally and retry automatically when the network is back
- Popup shows connection status, today's count, this week's count, and pending sync queue

## Stack

- **Chrome MV3** — current standard, MV2 is deprecated
- **TypeScript + Vite + @crxjs/vite-plugin** — HMR + extension build out of the box
- **React + lucide-react** — popup UI
- **chrome.i18n** with `en` / `zh_CN` / `zh_TW` / `ja` locales
- **chrome.storage.local** — token + settings + offline queue (no IndexedDB needed for MVP)
- **Backend** — POSTs to `https://jp.frank2025.com/api/vocabulary` with Bearer token auth

## Development

```bash
npm install
npm run dev          # load unpacked from /dist into Chrome
npm run build        # production bundle
npm run type-check   # TS validation
npm test             # vitest
```

### Load in Chrome

1. `npm run build`
2. Visit `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** → select `dist/`

### Connect to FastStudy

1. Sign in at [jp.frank2025.com](https://jp.frank2025.com/)
2. Open **Settings → Browser Extension**
3. Click **Generate connection code** — copy the 8-character code
4. Click the FastStudy toolbar icon in Chrome → **Connect to FastStudy** → paste the code
5. Done — start right-clicking Japanese words to save them

## Architecture

See [spec.md §4](./spec.md#4-架构) for the full layout.

```
FastStudy-ChromePlugin/
├── src/
│   ├── background/background.ts  ← service worker (contextMenus + fetch POST)
│   ├── popup/                    ← Extension popup UI (React)
│   ├── lib/                      ← chrome.storage.local + types + (V2) srs / phraseExtractor
│   └── _locales/{en,zh_CN,zh_TW,ja}/messages.json
├── public/icons/                 ← 16/32/48/128 px rasterized from icon.svg
└── scripts/rasterize-icons.mjs   ← one-off SVG → PNG (sharp)
```

## Backend

This extension is paired with the FastStudy web app (`jp.frank2025.com`). It expects:

- **POST /api/vocabulary** — body `{word, source: "chrome-extension", sourceUrl, sourceTitle, sourceDomain?}` with `Authorization: Bearer <extensionToken>`. Returns 201 / 200 / 401 / 403 / 422 / 429 / 5xx per [spec.md §5](./spec.md#5-关键数据流).
- **Settings page** at `/settings/browser-extension` for the user to mint + revoke extension tokens.

The backend code lives in `F:\WebSite\Japanese-learning-compare\` (separate repo).

## Privacy

- host_permissions is **only** `https://jp.frank2025.com/*` — no `<all_urls>`, no `tabs`, no `cookies`
- The extension only reads `info.selectionText` from a right-click event; it does not scan pages
- No analytics, no telemetry, no third-party CDNs

## License

MIT