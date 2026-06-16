# Live Translator Hub

> 覆盖 Cursor 与 Claude 桌面应用的 GUI 全场景实时汉化引擎，支持 Webview 插件穿透与 AI 异步翻译。

[English](../../README.md) | [日本語](ja-JP.md) | [한국어](ko-KR.md) | [Français](fr-FR.md) | [Deutsch](de-DE.md) | [Español](es-ES.md) | [Italiano](it-IT.md) | [Português](pt-BR.md) | [Nederlands](nl-NL.md) | [Polski](pl-PL.md) | [Svenska](sv-SE.md) | [Dansk](da-DK.md) | [Suomi](fi-FI.md) | [Norsk](nb-NO.md) | [Čeština](cs-CZ.md) | [Slovenčina](sk-SK.md) | [Română](ro-RO.md) | [Magyar](hu-HU.md) | [Ελληνικά](el-GR.md) | [Български](bg-BG.md) | [Українська](uk-UA.md) | [Русский](ru-RU.md) | [Lietuvių](lt-LT.md) | [Latviešu](lv-LV.md) | [Eesti](et-EE.md) | [Türkçe](tr-TR.md) | [Tiếng Việt](vi-VN.md) | [ไทย](th-TH.md) | [Bahasa Indonesia](id-ID.md) | [Bahasa Melayu](ms-MY.md) | [हिन्दी](hi-IN.md)

## 项目概述

Live Translator Hub 是一个 **Electron + React GUI 桌面应用**，为 Cursor 和 Claude 两款 AI 编程工具提供一键汉化。通过统一的翻译运行时内核，在一个界面中管理两个目标应用的引擎部署、API 密钥配置与词典生成。

本项目是 [Live-Translator-Hub](https://github.com/Uncle-Gao/Live-Translator-Hub) 的架构升级版——从 CLI 脚本进化为带状态面板与实时日志的 GUI，并将 Cursor 与 Claude 的汉化能力合并为同一个统一平台。


![截图](../../image.png)
![截图](../../image-1.png)
## 架构

```
live-translator-ecosystem/          # npm workspaces monorepo
├── packages/
│   ├── desktop-app/                # Electron + React GUI (Live Translator Hub)
│   │   ├── electron/main.js        # 主进程，IPC 通道与配置持久化
│   │   ├── electron/preload.js     # 渲染进程通信桥
│   │   └── src/                    # React 19 + Tailwind v4 + Zustand
│   ├── core/                       # 翻译运行时内核 (translator-engine.js)
│   ├── patcher-cursor/             # Cursor 应用 Patcher
│   ├── patcher-claude/             # Claude 应用 Patcher
│   └── dict-generator/             # AI 词典生成器
```

### 翻译运行时

`packages/core/src/translator-engine.js` 是注入到目标应用中的唯一运行时——纯浏览器 JS，无模块依赖。职责包括：

- **词典匹配**：静态词条 + 正则模式
- **AI 翻译代理桥**：Webview 环境中通过 `postMessage` 将翻译请求转发至主窗口，绕过 CSP 联网限制
- **翻译缓存**：基于 `localStorage` 的持久化缓存，键名为 `live_i18n_cache_<entity_name>`
- **嵌套词典查找**：支持 `enableNestedDict` 模式

## 功能亮点

### 双引擎统一管理

在同一界面中分别管理 Cursor 和 Claude 的汉化部署状态、词典版本与屏蔽规则，无需切换工具。

### 全场景 Webview 穿透

通过 Translation Bridge 架构，AI 翻译能力可以从主窗口穿透至所有层级的 Webview 插件（如 Claude Code），解决严苛 CSP 策略下的联网拦截问题。

### 四面板功能布局

| 面板 | 功能 |
| :--- | :--- |
| **Cursor Engine** | 部署/恢复 Cursor 汉化，管理主窗口与 Webview 插件的分域屏蔽规则 |
| **Claude Engine** | 部署/恢复 Claude 汉化，配置跳过规则 |
| **API Keys** | 管理多个 AI 翻译引擎的 API 密钥（支持 OpenAI、Anthropic、Google Gemini、DeepL），密钥经 Electron `safeStorage` 加密存储 |
| **Dict Generator** | 从目标应用源码提取 UI 字符串，通过 AI 批量生成翻译词典 |

### 交互式调试

- `Cmd + Option + Shift + B` (Mac) / `Ctrl + Alt + Shift + B` (Win) 切换蓝色虚线高亮边框
- 高亮模式下按住 `Option` (Mac) / `Alt` (Win) 并悬停中文可查看原文

### 分域屏蔽规则

每个实体（主窗口与各个插件）拥有完全独立的屏蔽规则集（CSS 选择器、URL 匹配、标题匹配），确保代码区与核心交互区不受翻译影响。

### 自动更新

内置 `electron-updater`，支持 macOS 应用内自动检查、下载与安装更新。

## 快速开始

```bash
# 安装依赖
npm install

# 启动 GUI 开发模式
npm run dev

# 构建 macOS 可分发版本
npm run build -w desktop-app
```

### 使用流程

1. 在 **API Keys** 面板配置 AI 引擎密钥
2. 切换到 **Cursor Engine** 或 **Claude Engine** 面板
3. 点击 **Deploy** 一键部署汉化
4. 重启目标应用即可生效

### 系统要求

- macOS 13+（推荐）
- Node.js 18+
- Cursor 或 Claude 桌面应用已安装

## 支持项目

如果这个项目对你有帮助，可以通过微信赞赏支持维护。

<p align="center">
  <img src="../../.github/funding/wechat-reward.jpg" alt="微信赞赏码" width="50%">
</p>

## 安全性

- **API 密钥加密存储**：通过 Electron `safeStorage` 加密保存至 `~/.live_translator_hub/api_keys.enc`，不写入配置文件
- **直连通信**：翻译请求直达 AI 厂商 API，无中转服务器
- **分域隔离**：屏蔽规则不触碰源码文件

---

*本项目仅供交流学习使用。翻译质量受所选 AI 模型影响。*
