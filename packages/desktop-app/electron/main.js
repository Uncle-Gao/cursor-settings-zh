const { app, BrowserWindow, ipcMain, safeStorage, dialog, nativeTheme, shell, Menu } = require('electron');
const path = require('path');
const fs   = require('fs');
const https = require('https');

app.setName('Live Translator Hub');

let autoUpdater = null;
let downloadedUpdateFile = null;
let latestUpdateInfo = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* dev mode without package */ }

// Fix: macOS 13 + Electron 34 AppKit state-restoration crash (NSPersistentUIRequiresSecureCoding)
app.commandLine.appendSwitch('disable-features', 'RestoredWindowsInformer');
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
app.commandLine.appendSwitch('disable-features', 'HardwareVideoDecoder');

// ─── Config paths ────────────────────────────────────────────────────────────
const CONFIG_DIR      = path.join(app.getPath('home'), '.live_translator_hub');
const API_KEYS_PATH   = path.join(CONFIG_DIR, 'api_keys.enc');
const CONFIG_FILE_PATH = path.join(CONFIG_DIR, 'config.json');
const DICTS_DIR       = path.join(CONFIG_DIR, 'dicts');
const MAC_UPDATE_CACHE_DIR = path.join(app.getPath('home'), 'Library', 'Caches', 'desktop-app-updater', 'manual');

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

// ─── API Key helpers (safeStorage) ──────────────────────────────────────────
function saveApiKeys(keys) {
  ensureConfigDir();
  if (!safeStorage.isEncryptionAvailable()) {
    fs.writeFileSync(API_KEYS_PATH + '.plain', JSON.stringify(keys, null, 2), { mode: 0o600 });
    return;
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(keys));
  fs.writeFileSync(API_KEYS_PATH, encrypted, { mode: 0o600 });
}

function loadApiKeys() {
  ensureConfigDir();
  try {
    if (fs.existsSync(API_KEYS_PATH) && safeStorage.isEncryptionAvailable()) {
      const encrypted = fs.readFileSync(API_KEYS_PATH);
      return JSON.parse(safeStorage.decryptString(encrypted));
    }
    const plainPath = API_KEYS_PATH + '.plain';
    if (fs.existsSync(plainPath)) {
      return JSON.parse(fs.readFileSync(plainPath, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

// ─── Legacy config migration ─────────────────────────────────────────────────
const OLD_CURSOR_DIR  = path.join(app.getPath('home'), '.cursor_live_translator');
const OLD_CLAUDE_DIR  = path.join(app.getPath('home'), '.claude_live_translator');
const OLD_CURSOR_CFG  = path.join(OLD_CURSOR_DIR, 'config.json');
const OLD_CLAUDE_CFG  = path.join(OLD_CLAUDE_DIR, 'config.json');

function migrateFromLegacy() {
  if (fs.existsSync(CONFIG_FILE_PATH) && fs.existsSync(API_KEYS_PATH)) return; // already migrated

  const oldCursor = fs.existsSync(OLD_CURSOR_CFG) ? safeReadJSON(OLD_CURSOR_CFG) : null;
  const oldClaude = fs.existsSync(OLD_CLAUDE_CFG) ? safeReadJSON(OLD_CLAUDE_CFG) : null;
  if (!oldCursor && !oldClaude) return;

  console.log('[migrate] Found legacy configs, migrating...');
  ensureConfigDir();

  // --- API Keys ---
  const cursorEngines = oldCursor?.engines || {};
  const claudeEngines = oldClaude?.engines || {};
  const mergedEngines = { ...claudeEngines, ...cursorEngines }; // cursor wins
  const activeId = oldCursor?.activeId || oldClaude?.activeId || 'none';

  if (!fs.existsSync(API_KEYS_PATH)) {
    saveApiKeys({ activeId, engines: mergedEngines });
  }

  // --- Main config ---
  const newCfg = loadConfig(); // may be partial from previous runs

  const defaultFeatures = {
    enableDictionary: true,
    enableNestedDict: true,
    enableRegex: true,
    enableTranslationBridge: true,
    enableLoadingAnimation: true,
    enableFileNameGuard: true,
    enableProtectedTermGuard: true,
  };

  if (oldCursor) {
    newCfg.cursor = newCfg.cursor || {};
    newCfg.cursor.features = newCfg.cursor.features || { ...defaultFeatures };
    newCfg.cursor.targetLanguage = newCfg.cursor.targetLanguage || 'zh-CN';
    // cursor.skip._cursor_
    if (oldCursor.skip?._cursor_) {
      newCfg.cursor.skip = newCfg.cursor.skip || {};
      newCfg.cursor.skip._cursor_ = oldCursor.skip._cursor_;
    }
    // cursor.skip.{pluginKey} → cursor.skipRules.webview.{pluginKey}
    if (oldCursor.skip) {
      newCfg.cursor.skipRules = newCfg.cursor.skipRules || { webview: {} };
      for (const [key, val] of Object.entries(oldCursor.skip)) {
        if (key === '_cursor_') continue;
        newCfg.cursor.skipRules.webview[key] = val;
      }
    }
  }

  if (oldClaude) {
    newCfg.claude = newCfg.claude || {};
    newCfg.claude.features = newCfg.claude.features || { ...defaultFeatures };
    newCfg.claude.targetLanguage = newCfg.claude.targetLanguage || 'zh-CN';
    if (oldClaude.skip) {
      newCfg.claude.skip = { _claude_: oldClaude.skip };
    }
  }

  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(newCfg, null, 2), 'utf8');

  // --- Cleanup old dirs ---
  deleteDir(OLD_CURSOR_DIR);
  deleteDir(OLD_CLAUDE_DIR);

  console.log('[migrate] Done. Old configs migrated and cleaned up.');
}

function safeReadJSON(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

function deleteDir(dir) {
  try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── Menu ─────────────────────────────────────────────────────────────────────
function buildMenu() {
  const template = [
    {
      label: app.getName(),
      submenu: [
        { label: '关于 Live Translator Hub', role: 'about' },
        { type: 'separator' },
        { label: '隐藏', role: 'hide', accelerator: 'Command+H' },
        { type: 'separator' },
        { label: '退出', role: 'quit', accelerator: 'Command+Q' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo', accelerator: 'Command+Z' },
        { label: '重做', role: 'redo', accelerator: 'Shift+Command+Z' },
        { type: 'separator' },
        { label: '剪切', role: 'cut', accelerator: 'Command+X' },
        { label: '复制', role: 'copy', accelerator: 'Command+C' },
        { label: '粘贴', role: 'paste', accelerator: 'Command+V' },
        { label: '全选', role: 'selectAll', accelerator: 'Command+A' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── Window ──────────────────────────────────────────────────────────────────
let mainWindow;

function createWindow() {
  const isMac = process.platform === 'darwin';

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 760,
    minWidth: 1000,
    minHeight: 640,
    icon: path.join(__dirname, '../build/icon-mac.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    ...(isMac && { titleBarStyle: 'hidden', trafficLightPosition: { x: 16, y: 20 } }),
    ...(!isMac && { autoHideMenuBar: true }),
    backgroundColor: '#0B0D10',
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }
}

// ─── Auto Updater ─────────────────────────────────────────────────────────────
function setupAutoUpdater() {
  if (!autoUpdater || process.env.VITE_DEV_SERVER_URL) return;

  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'Uncle-Gao',
    repo: 'Live-Translator-Hub',
    releaseType: 'release',
  });

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    if (mainWindow) mainWindow.webContents.send('update:checking');
  });

  autoUpdater.on('update-available', (info) => {
    latestUpdateInfo = info;
    if (mainWindow) mainWindow.webContents.send('update:available', {
      version: info.version,
      releaseDate: info.releaseDate,
      releaseNotes: info.releaseNotes,
    });
  });

  autoUpdater.on('update-not-available', () => {
    latestUpdateInfo = null;
    if (mainWindow) mainWindow.webContents.send('update:not-available');
  });

  autoUpdater.on('download-progress', (progress) => {
    if (mainWindow) mainWindow.webContents.send('update:download-progress', {
      percent: progress.percent,
      transferred: progress.transferred,
      total: progress.total,
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateFile = info.downloadedFile;
    if (mainWindow) mainWindow.webContents.send('update:downloaded', {
      platform: process.platform,
      downloadedFile: info.downloadedFile,
    });
  });

  autoUpdater.on('error', (error) => {
    console.error('[autoUpdater]', error);
    if (mainWindow) mainWindow.webContents.send('update:error', {
      message: error.message,
      code: error.code,
      canManualInstall: false,
    });
  });

  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[autoUpdater] checkForUpdates failed:', err.message);
    });
  }, 5000);
}

function getMacDmgCachePath(version, fileName) {
  const safeName = (fileName || `Live Translator Hub-${version}-mac-${process.arch}.dmg`).replace(/[/:]/g, '-');
  return path.join(MAC_UPDATE_CACHE_DIR, safeName);
}

function githubReleaseAssetUrl(version, fileName) {
  const tag = version.startsWith('v') ? version : `v${version}`;
  const encodedName = fileName.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/Uncle-Gao/Live-Translator-Hub/releases/download/${encodeURIComponent(tag)}/${encodedName}`;
}

function findMacDmgAsset(updateInfo) {
  const files = Array.isArray(updateInfo?.files) ? updateInfo.files : [];
  const dmgFiles = files
    .map(file => file?.url || file?.path || '')
    .filter(url => /\.dmg($|\?)/i.test(url));

  const archMatch = dmgFiles.find(url => url.includes(process.arch));
  const fileName = path.basename(decodeURIComponent(archMatch || dmgFiles[0] || `Live Translator Hub-${updateInfo.version}-mac-${process.arch}.dmg`));
  const rawUrl = archMatch || dmgFiles[0];

  if (rawUrl && /^https?:\/\//i.test(rawUrl)) {
    return { fileName, url: rawUrl };
  }

  return {
    fileName,
    url: githubReleaseAssetUrl(updateInfo.version, rawUrl || fileName),
  };
}

function cleanupOldMacDmgFiles(keepFile) {
  try {
    if (!fs.existsSync(MAC_UPDATE_CACHE_DIR)) return;
    for (const name of fs.readdirSync(MAC_UPDATE_CACHE_DIR)) {
      const file = path.join(MAC_UPDATE_CACHE_DIR, name);
      if (file !== keepFile && name.toLowerCase().endsWith('.dmg')) {
        fs.unlinkSync(file);
      }
    }
  } catch (err) {
    console.warn('[manualMacUpdate] cleanup failed:', err.message);
  }
}

function downloadFile(url, destination, onProgress, redirectCount = 0) {
  if (redirectCount > 5) {
    return Promise.reject(new Error('Too many redirects while downloading update'));
  }

  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      const statusCode = response.statusCode || 0;
      if (statusCode >= 300 && statusCode < 400 && response.headers.location) {
        response.resume();
        const nextUrl = new URL(response.headers.location, url).toString();
        downloadFile(nextUrl, destination, onProgress, redirectCount + 1).then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${statusCode}`));
        return;
      }

      const total = Number(response.headers['content-length'] || 0);
      let transferred = 0;
      const startedAt = Date.now();
      const file = fs.createWriteStream(destination);

      response.on('data', chunk => {
        transferred += chunk.length;
        const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
        onProgress?.({
          percent: total ? (transferred / total) * 100 : 0,
          transferred,
          total,
          bytesPerSecond: transferred / elapsedSeconds,
        });
      });

      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    });

    request.on('error', reject);
  });
}

async function downloadMacDmgUpdate() {
  if (!latestUpdateInfo) {
    const result = await autoUpdater.checkForUpdates();
    latestUpdateInfo = result?.updateInfo || result?.versionInfo;
  }
  if (!latestUpdateInfo?.version) throw new Error('No macOS update metadata available');

  const asset = findMacDmgAsset(latestUpdateInfo);
  fs.mkdirSync(MAC_UPDATE_CACHE_DIR, { recursive: true });

  const destination = getMacDmgCachePath(latestUpdateInfo.version, asset.fileName);
  const tempDestination = `${destination}.download`;
  if (fs.existsSync(tempDestination)) fs.unlinkSync(tempDestination);

  try {
    await downloadFile(asset.url, tempDestination, progress => {
      if (mainWindow) mainWindow.webContents.send('update:download-progress', progress);
    });
  } catch (err) {
    if (fs.existsSync(tempDestination)) fs.unlinkSync(tempDestination);
    throw err;
  }

  fs.renameSync(tempDestination, destination);
  cleanupOldMacDmgFiles(destination);
  downloadedUpdateFile = destination;

  if (mainWindow) mainWindow.webContents.send('update:downloaded', {
    platform: process.platform,
    downloadedFile: destination,
  });

  return destination;
}

// ─── Lifecycle & IPC ────────────────────────────────────────────────────────
let cursor, claude, DictGenerator;

app.whenReady().then(() => {
  nativeTheme.themeSource = 'dark';
  if (process.platform === 'darwin') {
    app.dock.setIcon(path.join(__dirname, '../build/icon-mac.png'));
    buildMenu();
  }
  migrateFromLegacy();

  // Delay loading patcher/generator logic to ensure Electron is fully stable
  const { CursorPatcher } = require('@live-translator/patcher-cursor');
  const { ClaudePatcher } = require('@live-translator/patcher-claude');
  const DG = require('@live-translator/dict-generator').DictGenerator;
  
  cursor = new CursorPatcher();
  claude = new ClaudePatcher();
  DictGenerator = DG;

  createWindow();
  setupAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('i18n:getCursorStatus', async () => {
    const cfg = loadConfig();
    return cursor ? await cursor.detectStatus(cfg.cursor?.appPath || null) : { installed: false };
  });
ipcMain.handle('i18n:getClaudeStatus', async () => {
    const cfg = loadConfig();
    return claude ? await claude.detectStatus(cfg.claude?.appPath || null) : { installed: false };
  });

ipcMain.handle('i18n:getAvailableLanguages', async (_, targetApp) => {
  const langs = new Set(['zh-CN']);
  const scanDir = (dir, patternFn) => {
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach(f => {
      const lang = patternFn(f);
      if (lang) langs.add(lang);
    });
  };
  try {
    if (targetApp === 'cursor') {
      const pattern = (f) => { const m = f.match(/^dictionary\.(.+)\.json$/); return m && m[1] !== 'json' ? m[1] : null; };
      scanDir(path.join(DICTS_DIR, 'cursor'), pattern);
      scanDir(path.resolve(__dirname, '../../patcher-cursor/i18n'), pattern);
    } else {
      const pattern = (f) => { const m = f.match(/^(.+)\.json$/); return m && !['package', 'package-lock'].includes(m[1]) ? m[1] : null; };
      scanDir(path.join(DICTS_DIR, 'claude'), pattern);
      scanDir(path.resolve(__dirname, '../../patcher-claude'), pattern);
    }
  } catch (err) {
    console.error('Failed to scan languages', err);
  }
  return Array.from(langs);
});

const buildHooks = () => ({
  onProgress: (msg) => { if (mainWindow) mainWindow.webContents.send('i18n:progress', msg); },
  onRequestSudo: () => { if (mainWindow) mainWindow.webContents.send('i18n:sudo-prompt'); },
  onTCCBlocked: () => { shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles'); },
});

ipcMain.handle('i18n:installCursor', async (event, config) => {
  const apiConfig = loadApiKeys();
  config.engines = apiConfig.engines || {};
  return await cursor.install(config, buildHooks());
});
ipcMain.handle('i18n:installClaude', async (event, config) => {
  const apiConfig = loadApiKeys();
  config.engines = apiConfig.engines || {};
  return await claude.install(config, buildHooks());
});
ipcMain.handle('cursor:createBackup', async () => {
  const cfg = loadConfig();
  const config = { appPath: cfg.cursor?.appPath || null };
  try {
    const result = await cursor.createBackup(config, buildHooks());
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('claude:createBackup', async () => {
  const cfg = loadConfig();
  const config = { appPath: cfg.claude?.appPath || null };
  try {
    const result = await claude.createBackup(config, buildHooks());
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('i18n:restoreCursor', async () => {
    const cfg = loadConfig();
    const config = { appPath: cfg.cursor?.appPath || null };
    return await cursor.restore(config, buildHooks());
  });
ipcMain.handle('i18n:restoreClaude', async () => {
    const cfg = loadConfig();
    const config = { appPath: cfg.claude?.appPath || null };
    return await claude.restore(config, buildHooks());
  });

ipcMain.handle('app:browsePath', async (_, targetApp) => {
  const result = await dialog.showOpenDialog({
    // macOS 上 .app bundle 在 openDirectory 模式下会被"钻进去"而非"选中"，
    // 同时加 openFile 让用户可以直接选中 .app；treatPackageAsDirectory: false
    // 确保 Finder 把 .app 当成可选中的文件包而非普通目录。
    properties: ['openDirectory', 'openFile'],
    title: targetApp === 'cursor' ? '选择 Cursor 应用目录' : '选择 Claude 应用目录',
    defaultPath: process.platform === 'darwin'
      ? '/Applications'
      : targetApp === 'claude'
        ? path.join(process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local', 'AnthropicClaude')
        : path.join(process.env.LOCALAPPDATA || process.env.PROGRAMFILES || 'C:\\', 'Programs'),
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('app:openExternal', async (_, url) => {
  await require('electron').shell.openExternal(url);
});

ipcMain.handle('config:saveApiKeys', async (_, keys) => {
  saveApiKeys(keys);
  return { ok: true };
});

ipcMain.handle('config:loadApiKeys', async () => {
  return loadApiKeys();
});

ipcMain.handle('config:load', async () => {
  ensureConfigDir();
  return loadConfig();
});

ipcMain.handle('config:save', async (_, config) => {
  ensureConfigDir();
  try {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf8');
    return { ok: true };
  } catch (e) {
    console.error('Failed to save config.json', e);
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('cursor:getInstalledExtensions', async () => {
  return await cursor.getInstalledExtensions();
});

ipcMain.handle('config:testApiKey', async (_, { engine, apiKey, model, baseURL }) => {
  try {
    await DictGenerator.testConnection({ engine, apiKey, model, baseURL });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dict:generate', async (_, { app: targetApp, lang, engine, batchSize, engineConfig, appPath }) => {
  try {
    const gen = new DictGenerator({
      engine,
      lang,
      batchSize: batchSize || 40,
      apiConfig: engineConfig,
      outputDir: DICTS_DIR,
    });

    gen.on('progress', (msg) => {
      if (mainWindow) mainWindow.webContents.send('dict:progress', msg);
    });

    const results = await gen.generate(targetApp, appPath || null);
    return { ok: true, results };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('dict:status', async (_, { app: targetApp, lang }) => {
  try {
    if (targetApp === 'claude-strings') {
      const userPath = path.join(DICTS_DIR, 'claude', 'Localizable.strings.zh-CN');
      const stringsPath = fs.existsSync(userPath) ? userPath
        : path.resolve(__dirname, '../../patcher-claude/Localizable.strings.zh-CN');
      if (!fs.existsSync(stringsPath)) return { exists: false };
      const content = fs.readFileSync(stringsPath, 'utf8');
      const count = (content.match(/^"[^"]+"\s*=/gm) || []).length;
      return { exists: true, count, path: stringsPath };
    }

    let dictPath;
    let fallback = false;
    if (targetApp === 'cursor') {
      const userDir = path.join(DICTS_DIR, 'cursor');
      const userPath = path.join(userDir, `dictionary.${lang}.json`);
      const userFallback = path.join(userDir, 'dictionary.json');
      const asarPath = path.resolve(__dirname, '../../patcher-cursor/i18n', `dictionary.${lang}.json`);
      const asarFallback = path.resolve(__dirname, '../../patcher-cursor/i18n', 'dictionary.json');
      if (fs.existsSync(userPath)) {
        dictPath = userPath;
      } else if (fs.existsSync(userFallback)) {
        dictPath = userFallback; fallback = true;
      } else if (fs.existsSync(asarPath)) {
        dictPath = asarPath;
      } else if (fs.existsSync(asarFallback)) {
        dictPath = asarFallback; fallback = true;
      }
    } else {
      const userPath = path.join(DICTS_DIR, 'claude', `${lang}.json`);
      dictPath = fs.existsSync(userPath) ? userPath
        : path.resolve(__dirname, '../../patcher-claude', `${lang}.json`);
    }
    if (!dictPath || !fs.existsSync(dictPath)) return { exists: false };
    const dict = JSON.parse(fs.readFileSync(dictPath, 'utf8'));
    const count = Object.keys(dict).length;
    return { exists: true, count, path: dictPath, fallback };
  } catch (e) {
    return { exists: false, error: e.message };
  }
});


// ─── Update IPC ────────────────────────────────────────────────────────────────
ipcMain.handle('update:check', async () => {
  if (!autoUpdater) return { ok: false, error: 'Update mechanism not available' };
  try {
    const result = await autoUpdater.checkForUpdates();
    latestUpdateInfo = result?.updateInfo || result?.versionInfo || latestUpdateInfo;
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:download', async () => {
  if (!autoUpdater) return { ok: false, error: 'Update mechanism not available' };
  try {
    if (process.platform === 'darwin') {
      const downloadedFile = await downloadMacDmgUpdate();
      return { ok: true, downloadedFile };
    }
    await autoUpdater.downloadUpdate();
    return { ok: true };
  } catch (err) {
    if (mainWindow) mainWindow.webContents.send('update:error', {
      message: err.message,
      canManualInstall: false,
    });
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('update:install', async () => {
  if (!autoUpdater) return { ok: false, error: 'Update mechanism not available' };
  if (process.platform === 'darwin') {
    if (!downloadedUpdateFile) return { ok: false, error: 'No macOS installer has been downloaded' };
    const error = await shell.openPath(downloadedUpdateFile);
    if (error && mainWindow) mainWindow.webContents.send('update:error', {
      message: error,
      canManualInstall: false,
    });
    return error ? { ok: false, error } : { ok: true };
  } else {
    // Windows/Linux: auto-update via electron-updater
    app.removeAllListeners('window-all-closed');
    autoUpdater.quitAndInstall();
    setTimeout(() => app.exit(0), 3000);
    return { ok: true };
  }
});

ipcMain.handle('update:getVersion', () => {
  return app.getVersion();
});
