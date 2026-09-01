const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const protectionDefaults = require('@live-translator/core/src/protection-defaults.json');

const DEFAULT_SKIPS = [
    ".monaco-breadcrumbs", ".view-lines.monaco-mouse-cursor-text", ".monaco-list-row",
    ".pane-header.expanded", ".xterm-link-layer", ".conversations",
    ".aislash-editor-input", ".composer-file-list-item", ".agent-sidebar-cell-content-wrapper"
];

function activeSkipItems(rule = {}, field) {
    const values = Array.isArray(rule[field]) ? rule[field] : [];
    const disabled = new Set(Array.isArray(rule[`disabled${field[0].toUpperCase()}${field.slice(1)}`]) ? rule[`disabled${field[0].toUpperCase()}${field.slice(1)}`] : []);
    return values.filter(item => !disabled.has(item));
}

function mergeDefaultList(saved, defaults) {
    return Array.from(new Set([
        ...(Array.isArray(saved) ? saved : []),
        ...defaults
    ]));
}

function compareVersions(a = '', b = '') {
    if (a === 'unknown' && b !== 'unknown') return -1;
    if (b === 'unknown' && a !== 'unknown') return 1;

    const parse = (version) => String(version)
        .split(/[.-]/)
        .map(part => {
            const number = Number(part);
            return Number.isNaN(number) ? part : number;
        });
    const left = parse(a);
    const right = parse(b);
    const length = Math.max(left.length, right.length);

    for (let i = 0; i < length; i++) {
        const l = left[i] ?? 0;
        const r = right[i] ?? 0;
        if (l === r) continue;
        if (typeof l === 'number' && typeof r === 'number') return l - r;
        return String(l).localeCompare(String(r), undefined, { numeric: true, sensitivity: 'base' });
    }

    return 0;
}

function getPluginPaths() {
    const extDir = path.join(os.homedir(), '.cursor', 'extensions');
    if (!fs.existsSync(extDir)) return [];

    const pluginsById = new Map();
    const dirs = fs.readdirSync(extDir);
    for (const dir of dirs) {
        const webviewJs = path.join(extDir, dir, 'webview', 'index.js');
        if (fs.existsSync(webviewJs)) {
            const packageJsonPath = path.join(extDir, dir, 'package.json');
            let version = 'unknown';
            let name = dir;
            let displayName = dir;
            let publisher = '';
            if (fs.existsSync(packageJsonPath)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                    version = pkg.version || version;
                    name = pkg.name || dir;
                    displayName = pkg.displayName || pkg.name || dir;
                    publisher = pkg.publisher || '';
                } catch (e) {}
            }
            const fallbackName = dir.replace(/-\d+(?:\.\d+)+(?:[-.].*)?$/, '');
            const extensionId = publisher && name ? `${publisher}.${name}` : (name === dir ? fallbackName : name);
            const plugin = {
                id: extensionId,
                dirId: dir,
                legacyIds: [dir],
                name: name,
                displayName: displayName,
                version: version,
                webviewJs: webviewJs,
                dir: path.join(extDir, dir)
            };

            const existing = pluginsById.get(extensionId);
            if (!existing || compareVersions(existing.version, version) < 0) {
                pluginsById.set(extensionId, {
                    ...plugin,
                    legacyIds: Array.from(new Set([...(existing?.legacyIds || []), dir]))
                });
            } else if (existing) {
                existing.legacyIds = Array.from(new Set([...(existing.legacyIds || []), dir]));
            }
        }
    }
    return Array.from(pluginsById.values());
}

function getPaths(customRoot = null) {
    let appRoot = customRoot;
    if (appRoot && !fs.existsSync(path.join(appRoot, 'product.json'))) {
        const platform = process.platform;
        // 第一步：尝试常见的子路径（用户可能选了 .app bundle 或安装目录）
        // macOS .app bundle → Contents/Resources/app
        // Windows/Linux install dir → resources/app
        const subCandidates = [
            platform === 'darwin' ? path.join(appRoot, 'Contents', 'Resources', 'app') : null,
            path.join(appRoot, 'resources', 'app'),
        ].filter(Boolean);
        const matched = subCandidates.find(p => fs.existsSync(path.join(p, 'product.json')));
        if (matched) {
            appRoot = matched;
        } else if (fs.statSync(appRoot).isDirectory()) {
            // 第二步：兜底——用户可能选了父目录（如 /Volumes/外置/Applications/），
            // 扫描一层子目录找带 "cursor" 关键字的 .app 或安装目录
            try {
                const scanResult = fs.readdirSync(appRoot)
                    .map(name => path.join(appRoot, name))
                    .filter(p => {
                        try { return fs.statSync(p).isDirectory(); } catch { return false; }
                    })
                    .filter(p => {
                        const base = path.basename(p).toLowerCase();
                        return base.includes('cursor');
                    })
                    .map(p => {
                        // 对每个候选子目录，尝试多种 app 内部结构
                        const app = platform === 'darwin'
                            ? path.join(p, 'Contents', 'Resources', 'app')
                            : path.join(p, 'resources', 'app');
                        return fs.existsSync(path.join(app, 'product.json')) ? app : null;
                    })
                    .find(Boolean);
                if (scanResult) appRoot = scanResult;
            } catch {}
        }
    }
    if (!appRoot) {
        const platform = process.platform;
        if (platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
            const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
            const possibleWinPaths = [
                // Squirrel installer: %LOCALAPPDATA%\cursor\app-<version>\resources\app
                ...(() => {
                    const squirrelDir = path.join(localAppData, 'cursor');
                    try {
                        return fs.readdirSync(squirrelDir)
                            .filter(d => d.startsWith('app-'))
                            .sort().reverse()
                            .map(d => path.join(squirrelDir, d, 'resources', 'app'));
                    } catch { return []; }
                })(),
                // NSIS installer
                path.join(localAppData, 'Programs', 'cursor', 'resources', 'app'),
                path.join(programFiles, 'Cursor', 'resources', 'app'),
            ];
            appRoot = possibleWinPaths.find(p => fs.existsSync(path.join(p, 'product.json'))) || '';
        } else if (platform === 'darwin') {
            const home = os.homedir();
            const possibleDarwinPaths = [
                '/Applications/Cursor.app/Contents/Resources/app',
                path.join(home, 'Applications/Cursor.app/Contents/Resources/app'),
                '/Applications/Cursor Beta.app/Contents/Resources/app',
            ];
            appRoot = possibleDarwinPaths.find(p => fs.existsSync(path.join(p, 'product.json'))) || '';
        } else {
            const possibleLinuxPaths = [
                '/usr/lib/cursor/resources/app',
                '/opt/cursor/resources/app',
                path.join(process.env.HOME || '', '.local', 'lib', 'cursor', 'resources', 'app')
            ];
            appRoot = possibleLinuxPaths.find(p => fs.existsSync(path.join(p, 'product.json'))) || '';
        }
    }

    if (!appRoot || !fs.existsSync(appRoot) || !fs.existsSync(path.join(appRoot, 'product.json'))) {
        return null;
    }

    const workbenchDir = path.join(appRoot, 'out', 'vs', 'code', 'electron-sandbox', 'workbench');
    const webviewDir = path.join(appRoot, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre');
    return {
        root: appRoot,
        workbenchDir,
        workbenchHtml: path.join(workbenchDir, 'workbench.html'),
        workbenchJs: path.join(workbenchDir, 'workbench.js'),
        webviewHtml: path.join(webviewDir, 'index.html'),
        productJson: path.join(appRoot, 'product.json')
    };
}

function loadI18n(lang) {
    let resultDict = {};
    try {
        const userDir = path.join(os.homedir(), '.live_translator_hub', 'dicts', 'cursor');
        const candidates = [
            path.join(userDir, `dictionary.${lang}.json`),
            path.join(userDir, 'dictionary.json'),
            path.join(__dirname, 'i18n', `dictionary.${lang}.json`),
            path.join(__dirname, 'i18n', 'dictionary.json'),
        ];
        for (const dictPath of candidates) {
            if (fs.existsSync(dictPath)) {
                resultDict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
                break;
            }
        }
    } catch (err) {
        console.error('❌ 加载 i18n 数据失败:', err.message);
    }
    return resultDict;
}

class CursorPatcher {
    async detectStatus(customRoot = null) {
        const paths = getPaths(customRoot);
        if (!paths) return { installed: false };

        let version = 'unknown';
        try {
            const currentProduct = JSON.parse(fs.readFileSync(paths.productJson, 'utf8'));
            version = currentProduct.version;
        } catch (e) {}

        // -- Backup detection (format: workbench.js.{version}.bak) --
        const versionedBakJs   = path.join(paths.workbenchDir, `workbench.js.${version}.bak`);
        const versionedBakHtml = path.join(paths.workbenchDir, `workbench.html.${version}.bak`);
        const hasBackup = fs.existsSync(versionedBakJs) && fs.existsSync(versionedBakHtml);

        // Check if any backup exists (version mismatch scan)
        let backupVersion = null;
        let versionMismatch = false;
        try {
            const allFiles = fs.readdirSync(paths.workbenchDir);
            const bakFile = allFiles.find(f => f.match(/^workbench\.js\.(.+)\.bak$/));
            if (bakFile) {
                backupVersion = bakFile.replace(/^workbench\.js\.(.+)\.bak$/, '$1');
                versionMismatch = backupVersion !== version;
            }
        } catch (e) {}

        // -- Patch detection: workbench.js contains our injection marker --
        let isPatched = false;
        try {
            const jsContent = fs.readFileSync(paths.workbenchJs, 'utf8');
            isPatched = jsContent.includes('=== 安装期编译内联组装 ===');
        } catch (e) {}

        // -- Webview backup detection --
        let hasWebviewBackup = false;
        try {
            const plugins = getPluginPaths();
            hasWebviewBackup = plugins.some(p => fs.existsSync(`${p.webviewJs}.${p.version}.bak`));
        } catch (e) {}

        return {
            installed: true,
            version,
            paths,
            isPatched,
            hasBackup,
            backupVersion,
            versionMismatch,
            hasWebviewBackup
        };
    }

    async createBackup(config = {}, hooks = {}) {
        // Support legacy signature: createBackup(hooks)
        if (typeof config === 'object' && (config.onProgress || config.onRequestSudo) && !hooks.onProgress) {
            hooks = config;
            config = {};
        }
        const onProgress = hooks.onProgress || (() => {});
        const status = await this.detectStatus(config.appPath || null);
        if (!status.installed) throw new Error('Cursor not found');
        const { version, paths } = status;

        const versionedBakJs = path.join(paths.workbenchDir, `workbench.js.${version}.bak`);
        const versionedBakHtml = path.join(paths.workbenchDir, `workbench.html.${version}.bak`);

        if (fs.existsSync(versionedBakJs) && fs.existsSync(versionedBakHtml)) {
            return { ok: true, skipped: true, reason: 'backup already exists' };
        }

        onProgress(`正在为版本 ${version} 创建主程序备份...`);

        if (!fs.existsSync(versionedBakJs)) {
            fs.copyFileSync(paths.workbenchJs, versionedBakJs);
        }
        if (!fs.existsSync(versionedBakHtml)) {
            fs.copyFileSync(paths.workbenchHtml, versionedBakHtml);
        }

        onProgress('主程序备份完成。');
        return { ok: true, skipped: false };
    }

    async getInstalledExtensions() {
        const plugins = getPluginPaths();
        return plugins.map(p => {
            const bakFile = `${p.webviewJs}.${p.version}.bak`;
            let isPatched = false;
            try {
                const content = fs.readFileSync(p.webviewJs, 'utf8');
                isPatched = content.includes('// === 安装期编译内联组装 ===');
            } catch (e) {}

            return {
                ...p,
                isPatched,
                hasBackup: fs.existsSync(bakFile)
            };
        });
    }


    async install(config, hooks = {}) {
        const status = await this.detectStatus(config.appPath || null);
        if (!status.installed) throw new Error('Cursor is not installed or detected.');
        const paths = status.paths;
        const version = status.version;

        const onProgress = hooks.onProgress || (() => {});
        onProgress('正在检查工作环境...');

        const versionedBakJs   = path.join(paths.workbenchDir, `workbench.js.${version}.bak`);
        const versionedBakHtml = path.join(paths.workbenchDir, `workbench.html.${version}.bak`);

        let jsContentSync = fs.readFileSync(paths.workbenchJs, 'utf8');

        const isAlreadyLocalized = jsContentSync.includes('=== 安装期编译内联组装 ===');

        if (!fs.existsSync(versionedBakJs)) {
            if (!isAlreadyLocalized) {
                onProgress('创建原生隔离备份...');
                fs.copyFileSync(paths.workbenchHtml, versionedBakHtml);
                fs.copyFileSync(paths.workbenchJs,   versionedBakJs);
                onProgress(`备份已创建: workbench.js.${version}.bak`);
            }
        }

        onProgress('编译并组装引擎代码...');
        let enginePath;
        try { enginePath = require.resolve('@live-translator/core/src/translator-engine.js'); }
        catch { enginePath = path.join(__dirname, '../core/src/translator-engine.js'); }
        if (!fs.existsSync(enginePath)) throw new Error(`找不到翻译引擎核心: ${enginePath}`);
        let engineCode = fs.readFileSync(enginePath, 'utf8');

        const activeEngine = config.engines?.[config.activeId];
        const apiType = (config.activeId === 'none' || !config.activeId) ? 'none' : config.activeId;
        const targetLang = config.targetLanguage || 'zh-CN';

        const { languageName, languageCode } = require('@live-translator/core/src/language-names');

        const cursorSkip = config.skip?._cursor_ || {};
        const customSkips = activeSkipItems(cursorSkip, 'selectors');
        const disabledCursorSkips = new Set(Array.isArray(cursorSkip.disabledSelectors) ? cursorSkip.disabledSelectors : []);
        const skipSelectors = Array.from(new Set([...DEFAULT_SKIPS, ...customSkips])).filter(item => !disabledCursorSkips.has(item));

        const engineConfig = {
            apiType,
            engineId: config.activeId,
            targetLanguage: languageName(targetLang),
            targetLanguageCode: languageCode(targetLang),
            openai: apiType === 'openai' ? activeEngine : null,
            anthropic: apiType === 'anthropic' ? activeEngine : null,
            gemini: apiType === 'gemini' ? activeEngine : null,
            deepl: apiType === 'deepl' ? activeEngine : null,
            skip: { ...cursorSkip, selectors: skipSelectors },
            protection: {
                terms: mergeDefaultList(config.protection?.terms, protectionDefaults.terms),
                patterns: mergeDefaultList(config.protection?.patterns, protectionDefaults.patterns),
                disabledTerms: Array.isArray(config.protection?.disabledTerms) ? config.protection.disabledTerms : [],
                disabledPatterns: Array.isArray(config.protection?.disabledPatterns) ? config.protection.disabledPatterns : []
            },
            cacheVersion: config.cacheVersion || 0,
            features: Object.assign({ enableDictionary: true, enableNestedDict: true, enableRegex: true, enableTranslationBridge: true, enableLoadingAnimation: true, enableFileNameGuard: true, enableProtectedTermGuard: true }, config.features || {})
        };
        const I18N_DICT = loadI18n(targetLang);
        const injectCode = `\n\n// === 安装期编译内联组装 ===\n(function(){\n` +
            `window.__I18N_TERMS__ = Object.assign(window.__I18N_TERMS__ || {}, ${JSON.stringify(I18N_DICT)});\n` +
            `window.__I18N_CONFIG__ = ${JSON.stringify(engineConfig)};\n\n` +
            `${engineCode}\n})();\n`;

        if (isAlreadyLocalized && fs.existsSync(versionedBakJs)) {
            fs.copyFileSync(versionedBakJs, paths.workbenchJs);
        }
        onProgress('向主程序注入翻译核心...');
        fs.appendFileSync(paths.workbenchJs, injectCode, 'utf8');

        onProgress('净化 HTML CSP 策略...');
        let htmlContentSync = fs.readFileSync(paths.workbenchHtml, 'utf8');
        if (!isAlreadyLocalized) {
            const metaTagRegex = /<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*">/i;
            htmlContentSync = htmlContentSync.replace(metaTagRegex, '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' https: http:; connect-src \'self\' https: http:; img-src \'self\' https: http: data:; style-src \'self\' \'unsafe-inline\' https: http:; font-src \'self\' https: http:;">');
            fs.writeFileSync(paths.workbenchHtml, htmlContentSync, 'utf8');
        }

        // Cleanup old cross-version backups
        const allFiles = fs.readdirSync(paths.workbenchDir);
        allFiles.forEach(f => {
            if (f.endsWith('.bak') && !f.includes(version)) {
                fs.unlinkSync(path.join(paths.workbenchDir, f));
            }
        });

        if (config.injectWebview) {
            onProgress('向 Webview (插件) 注入翻译核心...');
            const plugins = getPluginPaths();
            const globalWebviewSkip = config.skipRules?.webview?.['_global_'] || {};
            for (const plugin of plugins) {
                const pluginSkip = config.skipRules?.webview?.[plugin.id]
                    || (plugin.legacyIds || []).map(id => config.skipRules?.webview?.[id]).find(Boolean)
                    || {};
                const mergedSkip = {
                    selectors: Array.from(new Set([...activeSkipItems(globalWebviewSkip, 'selectors'), ...activeSkipItems(pluginSkip, 'selectors')])),
                    titles: Array.from(new Set([...activeSkipItems(globalWebviewSkip, 'titles'), ...activeSkipItems(pluginSkip, 'titles')])),
                    urls: Array.from(new Set([...activeSkipItems(globalWebviewSkip, 'urls'), ...activeSkipItems(pluginSkip, 'urls')]))
                };

                const pluginEngineConfig = {
                    ...engineConfig,
                    skip: mergedSkip,
                    name: plugin.displayName || plugin.name
                };

                const pluginInjectCode = `\n\n// === 安装期编译内联组装 ===\n(function(){\n` +
                    `window.__I18N_TERMS__ = Object.assign(window.__I18N_TERMS__ || {}, ${JSON.stringify(I18N_DICT)});\n` +
                            `window.__I18N_CONFIG__ = ${JSON.stringify(pluginEngineConfig)};\n\n` +
                    `${engineCode}\n})();\n`;

                const pluginBak = `${plugin.webviewJs}.${plugin.version}.bak`;
                const pluginContent = fs.readFileSync(plugin.webviewJs, 'utf8');
                const isPluginLocalized = pluginContent.includes('// === 安装期编译内联组装 ===');

                // Clean up old cross-version plugin backups
                const pluginDir = path.dirname(plugin.webviewJs);
                const pluginFiles = fs.readdirSync(pluginDir);
                pluginFiles.forEach(f => {
                    if (f.match(/^index\.js\..+\.bak$/) && f !== `index.js.${plugin.version}.bak`) {
                        fs.unlinkSync(path.join(pluginDir, f));
                    }
                });

                if (!fs.existsSync(pluginBak)) {
                    if (!isPluginLocalized) {
                        fs.copyFileSync(plugin.webviewJs, pluginBak);
                    }
                }

                if (fs.existsSync(pluginBak)) {
                    fs.copyFileSync(pluginBak, plugin.webviewJs);
                    fs.appendFileSync(plugin.webviewJs, pluginInjectCode, 'utf8');
                }
            }
        } else {
            // Restore plugins if injectWebview is false
            const plugins = getPluginPaths();
            for (const plugin of plugins) {
                const pluginBak = `${plugin.webviewJs}.${plugin.version}.bak`;
                if (fs.existsSync(pluginBak)) {
                    fs.copyFileSync(pluginBak, plugin.webviewJs);
                }
            }
        }

        // Update product.json checksums
        onProgress('更新 product.json 哈希校验...');
        const jsHash = crypto.createHash('sha256').update(fs.readFileSync(paths.workbenchJs)).digest('base64').replace(/=+$/, '');
        const htmlHash = crypto.createHash('sha256').update(fs.readFileSync(paths.workbenchHtml)).digest('base64').replace(/=+$/, '');
        const product = JSON.parse(fs.readFileSync(paths.productJson, 'utf8'));
        product.checksums['vs/code/electron-sandbox/workbench/workbench.js'] = jsHash;
        product.checksums['vs/code/electron-sandbox/workbench/workbench.html'] = htmlHash;
        fs.writeFileSync(paths.productJson, JSON.stringify(product, null, '\t'), 'utf8');

        if (process.platform === 'darwin') {
            onProgress('修复 macOS 签名...');
            const { execSync } = require('child_process');
            const appBundle = paths.root.replace('/Contents/Resources/app', '');
            try {
                execSync(`xattr -cr "${appBundle}"`);
                execSync(`codesign --force --deep --sign - "${appBundle}"`);
            } catch (e) {
                console.error('macOS codesign failed:', e);
            }
        }

        onProgress('安装成功！');
    }

    async restore(config = {}, hooks = {}) {
        // Support legacy signature: restore(hooks) where config is actually hooks
        if (typeof config === 'object' && (config.onProgress || config.onRequestSudo) && !hooks.onProgress) {
            hooks = config;
            config = {};
        }
        const status = await this.detectStatus(config.appPath || null);
        if (!status.installed) throw new Error('Cursor is not installed or detected.');
        const paths = status.paths;
        const onProgress = hooks.onProgress || (() => {});

        onProgress('检查并恢复主窗口备份...');
        let hasRestored = false;

        const allFiles = fs.readdirSync(paths.workbenchDir);
        for (const file of allFiles) {
            const bakMatch = file.match(/^(workbench\.(?:html|js))\.(.+)\.bak$/);
            if (bakMatch) {
                const bakPath = path.join(paths.workbenchDir, file);
                const targetName = bakMatch[1]; // workbench.html or workbench.js
                fs.copyFileSync(bakPath, path.join(paths.workbenchDir, targetName));
                fs.unlinkSync(bakPath);
                onProgress(`恢复源文件: ${targetName}`);
                hasRestored = true;
            }
        }

        const plugins = getPluginPaths();
        for (const plugin of plugins) {
            const pluginDir = path.dirname(plugin.webviewJs);
            if (fs.existsSync(pluginDir)) {
                const pluginFiles = fs.readdirSync(pluginDir);
                for (const file of pluginFiles) {
                    if (file.match(/^index\.js\..+\.bak$/)) {
                        const bakPath = path.join(pluginDir, file);
                        fs.copyFileSync(bakPath, plugin.webviewJs);
                        fs.unlinkSync(bakPath);
                        onProgress(`恢复插件源文件: ${plugin.id}`);
                        hasRestored = true;
                    }
                }
            }
        }

        if (!hasRestored) {
            onProgress('未发现任何汉化备份，或已被清理。');
        } else {
            // Update product.json checksums
            onProgress('更新 product.json 哈希校验...');
            const crypto = require('crypto');
            const jsHash = crypto.createHash('sha256').update(fs.readFileSync(paths.workbenchJs)).digest('base64').replace(/=+$/, '');
            const htmlHash = crypto.createHash('sha256').update(fs.readFileSync(paths.workbenchHtml)).digest('base64').replace(/=+$/, '');
            const product = JSON.parse(fs.readFileSync(paths.productJson, 'utf8'));
            product.checksums['vs/code/electron-sandbox/workbench/workbench.js'] = jsHash;
            product.checksums['vs/code/electron-sandbox/workbench/workbench.html'] = htmlHash;
            fs.writeFileSync(paths.productJson, JSON.stringify(product, null, '\t'), 'utf8');

            if (process.platform === 'darwin') {
                onProgress('修复 macOS 签名...');
                const { execSync } = require('child_process');
                const appBundle = paths.root.replace('/Contents/Resources/app', '');
                try {
                    execSync(`xattr -cr "${appBundle}"`);
                    execSync(`codesign --force --deep --sign - "${appBundle}"`);
                } catch (e) {
                    console.error('macOS codesign failed:', e);
                }
            }
            onProgress('恢复官方原版成功！');
        }
    }
}

module.exports = { CursorPatcher };
