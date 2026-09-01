const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');
const sudo = require('sudo-prompt');
const asar = require('@electron/asar');
const { patchExtractedClaudeCsp } = require('./csp-patcher');
const protectionDefaults = require('@live-translator/core/src/protection-defaults.json');

const TEMP_DIR = path.join(os.tmpdir(), 'claude-unified-workspace');
const NEW_ASAR = path.join(os.tmpdir(), 'app.asar.new');
const NEW_UNPACKED = NEW_ASAR + '.unpacked';

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

// 执行脚本：先直接运行；若被 macOS TCC 拦截则调 onTCCBlocked 并每 3 秒自动重试
async function _execScript(scriptPath, platform, _sudoOptions, hooks) {
    const { onProgress = () => {}, onTCCBlocked = () => {} } = hooks;
    const directCmd = platform === 'win32'
        ? `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`
        : `sh "${scriptPath}"`;

    const tryRun = () => {
        try {
            execSync(directCmd, { stdio: 'pipe' });
            return { ok: true };
        } catch (err) {
            const msg = err.stderr?.toString().trim() || err.message;
            const isTCC = msg.includes('Operation not permitted') || msg.includes('Permission denied');
            return { ok: false, isTCC, msg };
        }
    };

    const first = tryRun();
    if (first.ok) return;
    if (!first.isTCC) throw new Error(`Script Execution Failed: ${first.msg}`);

    onTCCBlocked();
    onProgress('⚠️ macOS 阻止了文件写入，已打开系统设置。请在「隐私与安全性」中点击「允许」，程序将自动重试...');

    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        onProgress(`正在重试 (${i + 1}/40)...`);
        const result = tryRun();
        if (result.ok) return;
        if (!result.isTCC) throw new Error(`Script Execution Failed: ${result.msg}`);
    }
    throw new Error('授权超时，请在系统设置→隐私与安全性中允许应用修改权限后重新部署。');
}

// 跨平台：生成提权执行命令
function _elevate(scriptPath, platform) {
    if (platform === 'win32') {
        return `powershell.exe -ExecutionPolicy Bypass -File "${scriptPath}"`;
    }
    return `sh "${scriptPath}"`;
}

// 跨平台：生成部署脚本路径
function _scriptPath(name, platform) {
    if (platform === 'win32') {
        return path.join(os.tmpdir(), `claude-${name}.ps1`);
    }
    return `/tmp/claude-${name}.sh`;
}

// 跨平台：组装 macOS 专属的后处理步骤（Info.plist + 签名）
function _macOSPostDeploy(appPath, mainPlist, headerHash, lang) {
    let cmds = '';
    cmds += `/usr/libexec/PlistBuddy -c "Set :ElectronAsarIntegrity:Resources/app.asar:hash ${headerHash}" "${mainPlist}"\n`;
    cmds += `/usr/libexec/PlistBuddy -c "Set :CFBundleDevelopmentRegion ${lang}" "${mainPlist}" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :CFBundleDevelopmentRegion string ${lang}" "${mainPlist}"\n`;
    cmds += `xattr -rd com.apple.quarantine "${appPath}" || true\n`;
    cmds += `xattr -cr "${appPath}"\n`;
    cmds += `codesign --force --deep --sign - "${appPath}"\n`;
    return cmds;
}

let ENGINE_SOURCE;
try {
    ENGINE_SOURCE = require.resolve('@live-translator/core/src/translator-engine.js');
} catch {
    ENGINE_SOURCE = path.join(__dirname, '../core/src/translator-engine.js');
}
let _pkgDir;
try {
    _pkgDir = path.dirname(require.resolve('@live-translator/patcher-claude/package.json'));
} catch {
    _pkgDir = __dirname;
}
let ZH_CN_SOURCE = path.join(_pkgDir, 'zh-CN.json');
let STRINGS_SOURCE = path.join(_pkgDir, 'Localizable.strings.zh-CN');

// When loaded from within an ASAR archive (e.g., the Live Translator Hub desktop app),
// resource files are inaccessible to shell cp/mv commands. Copy them to temp so the
// generated deploy scripts can reference real filesystem paths.
if (_pkgDir.includes('.asar')) {
    ZH_CN_SOURCE = path.join(os.tmpdir(), 'live-translator-patcher-claude-zh-CN.json');
    STRINGS_SOURCE = path.join(os.tmpdir(), 'live-translator-patcher-claude-Localizable.strings.zh-CN');
    fs.writeFileSync(ZH_CN_SOURCE, fs.readFileSync(path.join(_pkgDir, 'zh-CN.json')));
    fs.writeFileSync(STRINGS_SOURCE, fs.readFileSync(path.join(_pkgDir, 'Localizable.strings.zh-CN')));
}

function resolveDictSource(targetLanguage) {
    const userDir = path.join(os.homedir(), '.live_translator_hub', 'dicts', 'claude');
    const resolvePath = (filename) => {
        const userPath = path.join(userDir, filename);
        if (fs.existsSync(userPath)) return userPath;
        const pkgPath = path.join(_pkgDir, filename);
        if (fs.existsSync(pkgPath)) return pkgPath;
        return null;
    };
    if (!targetLanguage || targetLanguage === 'zh-CN') {
        return { dictPath: resolvePath('zh-CN.json') || ZH_CN_SOURCE, isChinese: true };
    }
    const dictPath = resolvePath(`${targetLanguage}.json`);
    if (dictPath) {
        return { dictPath, isChinese: false };
    }
    return { dictPath: resolvePath('zh-CN.json') || ZH_CN_SOURCE, isChinese: false, fallback: true };
}

// Search for a marker string inside a (potentially huge) binary file.
// Uses grep to avoid Node.js fs issues with Electron-interceptable .asar files.
function fileContainsMarker(filePath, marker) {
    try {
        execSync(`grep -qaF '${marker}' "${filePath}"`, { stdio: 'ignore' });
        return true;
    } catch (e) {
        if (e.status !== 1) {
            console.error('[fileContainsMarker] grep error:', e.message);
        }
        return false;
    }
}

// Returns the directory that directly contains app.asar, or null if not found.
// customRoot may be: the .app bundle (macOS), the install dir (Windows/Linux),
// the resources dir itself, or any ancestor — we try all interpretations.
function resolveResourcesPath(customRoot = null) {
    const home = os.homedir();
    const platform = process.platform;

    if (customRoot) {
        const candidates = [
            platform === 'darwin' ? path.join(customRoot, 'Contents', 'Resources') : null,
            path.join(customRoot, 'resources'),
            customRoot,
        ].filter(Boolean);
        // Squirrel installer: 扫描 app-* 子目录
        try {
            fs.readdirSync(customRoot)
                .filter(d => d.startsWith('app-'))
                .sort().reverse()
                .forEach(d => candidates.push(path.join(customRoot, d, 'resources')));
        } catch {}
        // 兜底：扫描一层子目录找带 "claude" 关键字的 .app / 安装目录
        // （用户在 macOS 选择器里点不到 .app bundle，可能选了父目录如 /Applications/）
        try {
            fs.readdirSync(customRoot)
                .map(name => path.join(customRoot, name))
                .filter(p => {
                    try { return fs.statSync(p).isDirectory(); } catch { return false; }
                })
                .filter(p => {
                    const base = path.basename(p).toLowerCase();
                    return base.includes('claude');
                })
                .forEach(p => {
                    if (platform === 'darwin') {
                        candidates.push(path.join(p, 'Contents', 'Resources'));
                    } else {
                        candidates.push(path.join(p, 'resources'));
                    }
                });
        } catch {}
        return candidates.find(p => fs.existsSync(path.join(p, 'app.asar'))) || null;
    }

    if (platform === 'darwin') {
        const candidates = [
            '/Applications/Claude.app/Contents/Resources',
            path.join(home, 'Applications/Claude.app/Contents/Resources'),
        ];
        return candidates.find(p => fs.existsSync(path.join(p, 'app.asar'))) || null;
    }

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        // Squirrel installer: %LOCALAPPDATA%\AnthropicClaude\app-{version}\resources
        const squirrelBase = path.join(localAppData, 'AnthropicClaude');
        if (fs.existsSync(squirrelBase)) {
            const appDirs = fs.readdirSync(squirrelBase)
                .filter(d => d.startsWith('app-'))
                .sort().reverse();
            for (const dir of appDirs) {
                const p = path.join(squirrelBase, dir, 'resources');
                if (fs.existsSync(path.join(p, 'app.asar'))) return p;
            }
        }
        const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
        const candidates = [
            path.join(localAppData, 'Programs', 'claude', 'resources'),
            path.join(programFiles, 'Claude', 'resources'),
        ];
        return candidates.find(p => fs.existsSync(path.join(p, 'app.asar'))) || null;
    }

    // Linux
    const candidates = [
        '/opt/claude/resources',
        '/usr/lib/claude/resources',
        path.join(home, '.local', 'lib', 'claude', 'resources'),
    ];
    return candidates.find(p => fs.existsSync(path.join(p, 'app.asar'))) || null;
}

function detectVersion(resourcesPath) {
    const platform = process.platform;
    if (platform === 'darwin') {
        const plist = path.join(resourcesPath, '..', '..', 'Contents', 'Info.plist');
        try {
            return execSync(`defaults read "${path.resolve(plist)}" CFBundleShortVersionString`).toString().trim();
        } catch (e) {}
    } else if (platform === 'win32') {
        // Squirrel install dirs are named app-{version}
        const dirName = path.basename(path.resolve(resourcesPath, '..'));
        if (dirName.startsWith('app-')) return dirName.slice(4);
    }
    // Linux or fallback: try package.json one level up
    try {
        const pkgPath = path.join(resourcesPath, '..', 'package.json');
        if (fs.existsSync(pkgPath)) {
            return JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version || 'unknown';
        }
    } catch (e) {}
    return 'unknown';
}

class ClaudePatcher {
    async detectStatus(customRoot = null) {
        const resourcesPath = resolveResourcesPath(customRoot);
        if (!resourcesPath) return { installed: false };

        const version = detectVersion(resourcesPath);
        const asarFile = path.join(resourcesPath, 'app.asar');

        let isPatched = false;
        try {
            isPatched = fileContainsMarker(asarFile, 'Unified v3 Injection');
        } catch (e) {
            console.error('[ClaudePatcher] detectStatus error:', e.message);
        }

        let backupVersion = null;
        let versionMismatch = false;
        try {
            const asarFiles = fs.readdirSync(resourcesPath).filter(f => f.startsWith('app.asar.') && f.endsWith('.bak'));
            if (asarFiles.length > 0) {
                const parts = asarFiles[0].replace('app.asar.', '').replace('.bak', '');
                backupVersion = parts;
                versionMismatch = backupVersion !== version;
            }
        } catch (e) {}

        return {
            installed: true,
            version,
            isPatched,
            hasBackup: backupVersion !== null,
            backupVersion,
            versionMismatch
        };
    }

    async createBackup(config = {}, hooks = {}) {
        // Support legacy signature: createBackup(hooks)
        if (typeof config === 'object' && (config.onProgress || config.onRequestSudo) && !hooks.onProgress) {
            hooks = config;
            config = {};
        }

        const resourcesPath = resolveResourcesPath(config.appPath || null);
        if (!resourcesPath) throw new Error('Claude is not installed.');

        const platform = process.platform;
        const asarFile = path.join(resourcesPath, 'app.asar');
        const version = detectVersion(resourcesPath);
        const ASAR_BAK = `${asarFile}.${version}.bak`;
        const UNPACKED_BAK = `${ASAR_BAK}.unpacked`;

        if (fs.existsSync(ASAR_BAK)) {
            return { ok: true, skipped: true, reason: 'backup already exists' };
        }

        const onProgress = hooks.onProgress || (() => {});
        const onRequestSudo = hooks.onRequestSudo || (() => {});

        onProgress(`正在为版本 ${version} 创建官方原版备份...`);

        const scriptPath = _scriptPath('backup', platform);

        if (platform === 'win32') {
            let ps = `$ErrorActionPreference = "Stop"\n`;
            ps += `Copy-Item -Path "${asarFile}" -Destination "${ASAR_BAK}" -Force\n`;
            if (fs.existsSync(`${asarFile}.unpacked`)) {
                ps += `Copy-Item -Path "${asarFile}.unpacked" -Destination "${UNPACKED_BAK}" -Recurse -Force\n`;
            }
            fs.writeFileSync(scriptPath, ps, 'utf8');
        } else {
            let sh = `#!/bin/sh\nset -e\n`;
            sh += `cp "${asarFile}" "${ASAR_BAK}"\n`;
            if (fs.existsSync(`${asarFile}.unpacked`)) {
                sh += `cp -R "${asarFile}.unpacked" "${UNPACKED_BAK}"\n`;
            }
            fs.writeFileSync(scriptPath, sh, { mode: 0o755 });
        }

        onProgress('正在等待系统管理员授权 (备份原版)...');
        onRequestSudo();

        return new Promise((resolve, reject) => {
            const options = { name: 'Live Translator Hub' };
            sudo.exec(_elevate(scriptPath, platform), options, (error, _stdout, stderr) => {
                if (error) {
                    console.error('[ClaudePatcher] Backup Error:', error, stderr);
                    reject(new Error(`Backup Failed: ${error.message}`));
                } else {
                    onProgress('官方原版备份完成！');
                    fs.unlinkSync(scriptPath);
                    resolve({ ok: true, skipped: false });
                }
            });
        });
    }

    async install(config, hooks = {}) {
        const resourcesPath = resolveResourcesPath(config.appPath || null);
        if (!resourcesPath) throw new Error('Claude is not installed or could not be detected.');

        const platform = process.platform;
        const isMac = platform === 'darwin';
        const appPath = path.resolve(resourcesPath, '..', '..');
        const asarFile = path.join(resourcesPath, 'app.asar');
        const mainPlist = isMac ? path.join(appPath, 'Contents', 'Info.plist') : null;
        const version = detectVersion(resourcesPath);
        const ASAR_BAK = `${asarFile}.${version}.bak`;
        const UNPACKED_BAK = `${ASAR_BAK}.unpacked`;

        const onProgress = hooks.onProgress || (() => {});

        // Resolve dictionary file based on target language
        const targetLang = config.targetLanguage || 'zh-CN';
        const { dictPath: resolvedDict, isChinese } = resolveDictSource(targetLang);
        if (resolvedDict !== ZH_CN_SOURCE) {
            onProgress(`使用 ${targetLang} 字典: ${path.basename(resolvedDict)}`);
        }

        onProgress('初始化临时工作区...');
        if (fs.existsSync(TEMP_DIR)) fs.rmSync(TEMP_DIR, { recursive: true, force: true });
        fs.mkdirSync(TEMP_DIR, { recursive: true });

        const isAlreadyLocalized = fileContainsMarker(asarFile, 'Unified v3 Injection');

        let extractionSource = asarFile;
        if (fs.existsSync(ASAR_BAK)) {
            extractionSource = ASAR_BAK;
        } else if (isAlreadyLocalized) {
            onProgress('⚠️ 警告：当前包已被修改且无纯净备份，本次操作将基于已修改版本进行（不建议）。如遇异常，请重装 Claude。');
        }

        onProgress(`从 ${path.basename(extractionSource)} 提取应用包...`);
        asar.extractAll(extractionSource, TEMP_DIR);

        const cspResult = patchExtractedClaudeCsp(TEMP_DIR, config);
        if (cspResult.enabled && cspResult.origin) {
            if (cspResult.skipped) {
                onProgress(`⚠️ 第三方推理模式 CSP 追加已跳过：当前 Claude 版本的 CSP 结构未匹配。主汉化注入将继续，第三方 API 直连可能仍受 Claude CSP 限制。`);
            } else {
                onProgress(cspResult.changed
                    ? `已启用第三方推理模式，允许 Claude 页面访问: ${cspResult.origin}`
                    : `第三方推理模式已存在允许项: ${cspResult.origin}`);
            }
        } else if (cspResult.enabled) {
            onProgress('第三方推理模式已启用，但未检测到可追加到 CSP 的安全 API 域名。');
        }

        onProgress('编译并组装引擎代码...');
        const engineCode = fs.readFileSync(ENGINE_SOURCE, 'utf8');
        const activeEngine = config.engines?.[config.activeId];
        const apiType = (config.activeId === 'none' || !config.activeId) ? 'none' : config.activeId;

        const { languageName, languageCode } = require('@live-translator/core/src/language-names');
        const engineConfig = {
            apiType,
            engineId: config.activeId,
            targetLanguage: languageName(targetLang),
            targetLanguageCode: languageCode(targetLang),
            openai: apiType === 'openai' ? activeEngine : null,
            anthropic: apiType === 'anthropic' ? activeEngine : null,
            gemini: apiType === 'gemini' ? activeEngine : null,
            deepl: apiType === 'deepl' ? activeEngine : null,
            skip: {
                selectors: activeSkipItems(config.skip?._claude_, 'selectors'),
                titles: activeSkipItems(config.skip?._claude_, 'titles'),
                urls: activeSkipItems(config.skip?._claude_, 'urls')
            },
            protection: {
                terms: mergeDefaultList(config.protection?.terms, protectionDefaults.terms),
                patterns: mergeDefaultList(config.protection?.patterns, protectionDefaults.patterns),
                disabledTerms: Array.isArray(config.protection?.disabledTerms) ? config.protection.disabledTerms : [],
                disabledPatterns: Array.isArray(config.protection?.disabledPatterns) ? config.protection.disabledPatterns : []
            },
            cacheVersion: config.cacheVersion || 0,
            features: Object.assign({
                enableDictionary: true,
                enableNestedDict: true,
                enableRegex: true,
                enableTranslationBridge: true,
                enableLoadingAnimation: true,
                enableFileNameGuard: true,
                enableProtectedTermGuard: true
            }, config.features || {})
        };

        const MARKER = '/** [Claude-Live-Translator] Unified v3 Injection **/';
        const injection = `\n${MARKER}\n(function() {\n    window.__I18N_TERMS__ = Object.assign(window.__I18N_TERMS__ || {}, {});\n    window.__I18N_CONFIG__ = ${JSON.stringify(engineConfig)};\n    try { ${engineCode} } catch(e) { console.error('[I18N] Error:', e); }\n})();\n`;

        const preloads = [
            path.join(TEMP_DIR, '.vite', 'build', 'mainView.js'),
            path.join(TEMP_DIR, '.vite', 'build', 'mainWindow.js')
        ];
        preloads.forEach(file => {
            if (fs.existsSync(file)) {
                const original = fs.readFileSync(file, 'utf8');
                if (!original.includes(MARKER)) {
                    fs.writeFileSync(file, original + injection);
                }
            }
        });

        onProgress('重新封包应用...');
        if (fs.existsSync(NEW_ASAR)) fs.unlinkSync(NEW_ASAR);
        if (fs.existsSync(NEW_UNPACKED)) fs.rmSync(NEW_UNPACKED, { recursive: true, force: true });
        await asar.createPackageWithOptions(TEMP_DIR, NEW_ASAR, { unpack: '{*.node,*.dll,*.dylib,*.so,*.exe,spawn-helper}' });

        const newAsarBuffer = fs.readFileSync(NEW_ASAR);
        const headerSize = newAsarBuffer.readUInt32LE(12);
        const headerHash = crypto.createHash('sha256').update(newAsarBuffer.subarray(16, 16 + headerSize)).digest('hex');

        onProgress('生成部署脚本...');
        const scriptPath = _scriptPath('deploy', platform);

        if (platform === 'win32') {
            // Windows: PowerShell 脚本
            let ps = `$ErrorActionPreference = "Stop"\n`;
            if (!fs.existsSync(ASAR_BAK) && !isAlreadyLocalized) {
                ps += `Copy-Item -Path "${asarFile}" -Destination "${ASAR_BAK}" -Force\n`;
                if (fs.existsSync(`${asarFile}.unpacked`)) {
                    ps += `Copy-Item -Path "${asarFile}.unpacked" -Destination "${UNPACKED_BAK}" -Recurse -Force\n`;
                }
            }
            const allFiles = fs.readdirSync(resourcesPath);
            allFiles.forEach(f => {
                if (f.includes('.bak') && !f.includes(version)) {
                    ps += `Remove-Item -Path "${path.join(resourcesPath, f)}" -Recurse -Force -ErrorAction SilentlyContinue\n`;
                }
            });
            ps += `Remove-Item -Path "${asarFile}.unpacked" -Recurse -Force -ErrorAction SilentlyContinue\n`;
            ps += `Move-Item -Path "${NEW_ASAR}" -Destination "${asarFile}" -Force\n`;
            ps += `Move-Item -Path "${NEW_UNPACKED}" -Destination "${asarFile}.unpacked" -Force\n`;
            ps += `Copy-Item -Path "${resolvedDict}" -Destination "${path.join(resourcesPath, 'en-US.json')}" -Force\n`;
            ps += `Copy-Item -Path "${resolvedDict}" -Destination "${path.join(resourcesPath, 'ja-JP.json')}" -Force\n`;
            if (isChinese) {
                ps += `New-Item -Path "${path.join(resourcesPath, 'zh-Hans.lproj')}" -ItemType Directory -Force\n`;
                ps += `Copy-Item -Path "${STRINGS_SOURCE}" -Destination "${path.join(resourcesPath, 'zh-Hans.lproj', 'Localizable.strings')}" -Force\n`;
            }
            fs.writeFileSync(scriptPath, ps, 'utf8');
        } else {
            // macOS / Linux: Shell 脚本
            let sh = `#!/bin/sh\nset -e\n`;
            if (!fs.existsSync(ASAR_BAK) && !isAlreadyLocalized) {
                sh += `cp "${asarFile}" "${ASAR_BAK}"\n`;
                if (fs.existsSync(`${asarFile}.unpacked`)) {
                    sh += `cp -R "${asarFile}.unpacked" "${UNPACKED_BAK}"\n`;
                }
            }
            const allFiles = fs.readdirSync(resourcesPath);
            allFiles.forEach(f => {
                if (f.includes('.bak') && !f.includes(version)) {
                    sh += `rm -rf "${path.join(resourcesPath, f)}"\n`;
                }
            });
            sh += `rm -rf "${asarFile}.unpacked"\n`;
            sh += `mv "${NEW_ASAR}" "${asarFile}"\n`;
            sh += `mv "${NEW_UNPACKED}" "${asarFile}.unpacked"\n`;
            sh += `cp "${resolvedDict}" "${path.join(resourcesPath, 'en-US.json')}"\n`;
            sh += `cp "${resolvedDict}" "${path.join(resourcesPath, 'ja-JP.json')}"\n`;
            if (isChinese) {
                sh += `mkdir -p "${path.join(resourcesPath, 'zh-Hans.lproj')}"\n`;
                sh += `cp "${STRINGS_SOURCE}" "${path.join(resourcesPath, 'zh-Hans.lproj', 'Localizable.strings')}"\n`;
            }
            if (isMac) {
                const macLang = isChinese ? 'zh-Hans' : targetLang.split('-')[0];
                sh += _macOSPostDeploy(appPath, mainPlist, headerHash, macLang);
            }
            fs.writeFileSync(scriptPath, sh, { mode: 0o755 });
        }

        onProgress('正在写入系统资源...');
        const options = { name: 'Live Translator Hub' };
        return _execScript(scriptPath, platform, options, hooks).then(() => {
            onProgress('系统资源写入成功！');
            fs.unlinkSync(scriptPath);
        });
    }

    async restore(config = {}, hooks = {}) {
        // Support legacy signature: restore(hooks) where config is actually hooks
        if (typeof config === 'object' && (config.onProgress || config.onRequestSudo) && !hooks.onProgress) {
            hooks = config;
            config = {};
        }

        const resourcesPath = resolveResourcesPath(config.appPath || null);
        if (!resourcesPath) throw new Error('Claude is not installed.');

        const platform = process.platform;
        const isMac = platform === 'darwin';
        const asarFile = path.join(resourcesPath, 'app.asar');
        const version = detectVersion(resourcesPath);
        const ASAR_BAK = `${asarFile}.${version}.bak`;
        const UNPACKED_BAK = `${ASAR_BAK}.unpacked`;
        const legacyBak = `${asarFile}.bak`;

        const onProgress = hooks.onProgress || (() => {});

        if (!fs.existsSync(ASAR_BAK) && !fs.existsSync(legacyBak)) {
            throw new Error('未找到备份文件，无法自动恢复。');
        }

        onProgress('生成恢复脚本...');
        const appPath = path.resolve(resourcesPath, '..', '..');
        const scriptPath = _scriptPath('restore', platform);
        const backupAsar = fs.existsSync(ASAR_BAK) ? ASAR_BAK : legacyBak;

        if (platform === 'win32') {
            let ps = `$ErrorActionPreference = "Stop"\n`;
            ps += `Copy-Item -Path "${backupAsar}" -Destination "${asarFile}" -Force\n`;
            if (fs.existsSync(UNPACKED_BAK)) {
                ps += `Remove-Item -Path "${asarFile}.unpacked" -Recurse -Force -ErrorAction SilentlyContinue\n`;
                ps += `Copy-Item -Path "${UNPACKED_BAK}" -Destination "${asarFile}.unpacked" -Recurse -Force\n`;
            }
            ps += `Remove-Item -Path "${path.join(resourcesPath, 'zh-Hans.lproj')}" -Recurse -Force -ErrorAction SilentlyContinue\n`;
            ps += `Remove-Item -Path "${path.join(resourcesPath, 'ja.lproj')}" -Recurse -Force -ErrorAction SilentlyContinue\n`;
            ps += `Remove-Item -Path "${path.join(resourcesPath, 'en-US.json')}" -Force -ErrorAction SilentlyContinue\n`;
            ps += `Remove-Item -Path "${path.join(resourcesPath, 'ja-JP.json')}" -Force -ErrorAction SilentlyContinue\n`;
            fs.writeFileSync(scriptPath, ps, 'utf8');
        } else {
            let sh = `#!/bin/sh\nset -e\n`;
            sh += `cp "${backupAsar}" "${asarFile}"\n`;
            if (fs.existsSync(UNPACKED_BAK)) {
                sh += `rm -rf "${asarFile}.unpacked"\n`;
                sh += `cp -R "${UNPACKED_BAK}" "${asarFile}.unpacked"\n`;
            }
            sh += `rm -rf "${path.join(resourcesPath, 'zh-Hans.lproj')}"\n`;
            sh += `rm -rf "${path.join(resourcesPath, 'ja.lproj')}"\n`;
            sh += `rm -f "${path.join(resourcesPath, 'en-US.json')}"\n`;
            sh += `rm -f "${path.join(resourcesPath, 'ja-JP.json')}"\n`;

            if (isMac) {
                const mainPlist = path.join(appPath, 'Contents', 'Info.plist');
                const backupBuffer = fs.readFileSync(backupAsar);
                const headerSize = backupBuffer.readUInt32LE(12);
                const backupHash = crypto.createHash('sha256').update(backupBuffer.subarray(16, 16 + headerSize)).digest('hex');
                sh += _macOSPostDeploy(appPath, mainPlist, backupHash, 'en');
            }
            fs.writeFileSync(scriptPath, sh, { mode: 0o755 });
        }

        onProgress('正在恢复系统资源...');
        const options = { name: 'Live Translator Hub' };
        return _execScript(scriptPath, platform, options, hooks).then(() => {
            onProgress('官方版本已恢复！');
            fs.unlinkSync(scriptPath);
        }).catch(err => {
            throw new Error(`Restore Failed: ${err.message}`);
        });
    }
}

module.exports = { ClaudePatcher, resolveResourcesPath, detectVersion };
