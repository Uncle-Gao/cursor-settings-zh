# Live Translator Hub

> GUI full-scene real-time localization engine covering Cursor and Claude desktop applications, supporting Webview plugin penetration and AI asynchronous translation.

[日本語](docs/readme/ja-JP.md) | [한국어](docs/readme/ko-KR.md) | [Français](docs/readme/fr-FR.md) | [Deutsch](docs/readme/de-DE.md) | [Español](docs/readme/es-ES.md) | [Italiano](docs/readme/it-IT.md) | [Português](docs/readme/pt-BR.md) | [Português](docs/readme/pt-PT.md) | [Nederlands](docs/readme/nl-NL.md) | [Polski](docs/readme/pl-PL.md) | [Svenska](docs/readme/sv-SE.md) | [Dansk](docs/readme/da-DK.md) | [Suomi](docs/readme/fi-FI.md) | [Norsk](docs/readme/nb-NO.md) | [Čeština](docs/readme/cs-CZ.md) | [Slovenčina](docs/readme/sk-SK.md) | [Română](docs/readme/ro-RO.md) | [Magyar](docs/readme/hu-HU.md) | [Ελληνικά](docs/readme/el-GR.md) | [Български](docs/readme/bg-BG.md) | [Українська](docs/readme/uk-UA.md) | [Русский](docs/readme/ru-RU.md) | [Lietuvių](docs/readme/lt-LT.md) | [Latviešu](docs/readme/lv-LV.md) | [Eesti](docs/readme/et-EE.md) | [Türkçe](docs/readme/tr-TR.md) | [Tiếng Việt](docs/readme/vi-VN.md) | [ไทย](docs/readme/th-TH.md) | [Bahasa Indonesia](docs/readme/id-ID.md) | [Bahasa Melayu](docs/readme/ms-MY.md) | [हिन्दी](docs/readme/hi-IN.md) | [中文](docs/readme/zh-CN.md)

## Project Overview

Live Translator Hub is an **Electron + React GUI desktop application** that provides one-click Chinese localization for two AI programming tools: Cursor and Claude. Through a unified translation runtime kernel, it manages engine deployment, API key configuration, and dictionary generation for both target applications from a single interface.

This project is an architectural upgrade of [Live-Translator-Hub](https://github.com/Uncle-Gao/Live-Translator-Hub) — evolving from a CLI script into a GUI with a status panel and real-time logs, merging the localization capabilities for Cursor and Claude into one unified platform.

![Screenshot](image.png)
![Screenshot](image-1.png)

## Architecture

```
live-translator-ecosystem/          # npm workspaces monorepo
├── packages/
│   ├── desktop-app/                # Electron + React GUI (Live Translator Hub)
│   │   ├── electron/main.js        # Main process, IPC channels & config persistence
│   │   ├── electron/preload.js     # Renderer process communication bridge
│   │   └── src/                    # React 19 + Tailwind v4 + Zustand
│   ├── core/                       # Translation runtime kernel (translator-engine.js)
│   ├── patcher-cursor/             # Cursor application Patcher
│   ├── patcher-claude/             # Claude application Patcher
│   └── dict-generator/             # AI dictionary generator
```

### Translation Runtime

`packages/core/src/translator-engine.js` is the only runtime injected into the target applications — pure browser JS, no module dependencies. Responsibilities include:

- **Dictionary Matching**: Static entries + regex patterns
- **AI Translation Proxy Bridge**: In Webview environments, forwards translation requests to the main window via `postMessage`, bypassing CSP network restrictions
- **Translation Cache**: Persistent cache based on `localStorage`, keyed as `live_i18n_cache_<entity_name>`
- **Nested Dictionary Lookup**: Supports `enableNestedDict` mode

## Feature Highlights

### Unified Dual Engine Management

Manage the localization deployment status, dictionary versions, and blocking rules for Cursor and Claude respectively from the same interface, without switching tools.

### Full-Scene Webview Penetration

Through the Translation Bridge architecture, AI translation capabilities can penetrate from the main window to all levels of Webview plugins (e.g., Claude Code), solving network interception issues under strict CSP policies.

### Four-Panel Functional Layout

| Panel | Function |
| :--- | :--- |
| **Cursor Engine** | Deploy/restore Cursor localization, manage domain-specific blocking rules for the main window and Webview plugins |
| **Claude Engine** | Deploy/restore Claude localization, configure skip rules |
| **API Keys** | Manage API keys for multiple AI translation engines (supports OpenAI, Anthropic, Google Gemini, DeepL), keys encrypted via Electron `safeStorage` |
| **Dict Generator** | Extract UI strings from target application source code, batch generate translation dictionaries via AI |

### Interactive Debugging

- `Cmd + Option + Shift + B` (Mac) / `Ctrl + Alt + Shift + B` (Win) to toggle blue dashed highlight borders
- In highlight mode, hold `Option` (Mac) / `Alt` (Win) and hover over Chinese text to view the original text

### Domain-Specific Blocking Rules

Each entity (main window and individual plugins) has completely independent blocking rule sets (CSS selectors, URL matching, title matching), ensuring code areas and core interaction zones remain unaffected by translation.

### Auto Update

Built-in `electron-updater`, supports in-app automatic checking, downloading, and installation of updates on macOS.

## Quick Start

```bash
# Install dependencies
npm install

# Start GUI development mode
npm run dev

# Build macOS distributable version
npm run build -w desktop-app
```

### Usage Flow

1. Configure AI engine keys in the **API Keys** panel
2. Switch to the **Cursor Engine** or **Claude Engine** panel
3. Click **Deploy** for one-click localization deployment
4. Restart the target application for changes to take effect

### System Requirements

- macOS 13+ (Recommended)
- Node.js 18+
- Cursor or Claude desktop application installed

## Support

If this project helps you, you can support its maintenance through WeChat Reward.

![WeChat Reward QR Code](.github/funding/wechat-reward.jpg)

## Security

- **Encrypted API Key Storage**: Saved encrypted via Electron `safeStorage` to `~/.live_translator_hub/api_keys.enc`, not written to configuration files
- **Direct Communication**: Translation requests go directly to AI vendor APIs, no intermediary servers
- **Domain Isolation**: Blocking rules do not touch source code files

---

*This project is for learning and communication purposes only. Translation quality is affected by the selected AI model.*
