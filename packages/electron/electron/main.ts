/**
 * Electron main process for Codex Proxy desktop app.
 *
 * Built by esbuild into dist-electron/main.cjs (CJS format).
 * Loads the backend ESM modules from asarUnpack (real filesystem paths).
 */

import { app, BrowserWindow, Tray, Menu, shell, nativeImage, dialog } from "electron";
import { resolve, join, relative } from "path";
import { pathToFileURL } from "url";
import { existsSync, mkdirSync, cpSync } from "fs";
import { homedir } from "os";
import {
  LEGACY_USER_DATA_SCOPES,
  UNOFFICIAL_LEGACY_USER_DATA_SCOPES,
  resolveUserDataDir,
  userDataBaseDir,
} from "../../../scripts/portable/user-data.mjs";
import {
  initAutoUpdater,
  getAutoUpdateState,
  checkForUpdateManual,
  installUpdate,
  downloadUpdate,
  stopAutoUpdater,
} from "./auto-updater.js";
import { IS_MAC } from "./constants.js";

// Injected by electron/build.mjs. Fork (OCGO) builds set OCX_BUILD=1, which
// skips updater initialisation entirely: no upstream feed, no app-update.yml,
// no updater cache directory. `typeof` keeps unbundled/ts-node contexts safe.
const OCX_BUILD = typeof __OCX_BUILD__ !== "undefined" && __OCX_BUILD__;


let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let serverHandle: { close: () => Promise<void>; port: number } | null = null;
let isQuitting = false;
let allowProcessExit = false;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ── macOS application menu ──────────────────────────────────────────

function setupAppMenu(): void {
  if (IS_MAC) {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          {
            label: "Quit",
            accelerator: "Command+Q",
            click: () => quitApplication(),
          },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "front" },
        ],
      },
    ];

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  } else {
    Menu.setApplicationMenu(null);
  }
}


// ── App ready ────────────────────────────────────────────────────────

app.on("ready", async () => {
  setupAppMenu();

  try {
    // 1. Determine paths — must happen before importing backend
    // Renaming the packaged app moves the per-user directory; migrate once so existing
    // accounts/keys/logs are not orphaned. The legacy directory is copied, never deleted.
    // The target scope comes from Electron itself, so the regular and the unofficial build
    // keep their separate data directories instead of collapsing into one.
    const defaultUserData = app.getPath("userData");
    const userDataBase = userDataBaseDir({ platform: process.platform, env: process.env, home: homedir() });
    const primaryScope = relative(userDataBase, defaultUserData).split(/[\\/]+/).filter(Boolean);
    const resolvedUserData = resolveUserDataDir({
      baseDir: userDataBase,
      ...(primaryScope.length > 0 ? { primaryScope } : {}),
      legacyScopes: OCX_BUILD ? UNOFFICIAL_LEGACY_USER_DATA_SCOPES : LEGACY_USER_DATA_SCOPES,
      existsSync,
      copySync: cpSync,
    });
    if (resolvedUserData.error) console.warn(`[desktop] ${resolvedUserData.error}`);
    else if (resolvedUserData.migrated) console.log(`[desktop] migrated user data from ${resolvedUserData.legacyDir}`);
    try {
      if (resolvedUserData.dir !== app.getPath("userData")) app.setPath("userData", resolvedUserData.dir);
    } catch { /* keep Electron's default when setPath is rejected */ }
    const userData = resolvedUserData.dir;
    const dataDir = resolve(userData, "data");
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    const appRoot = app.getAppPath();
    // In dev mode, resources (config/, public/, bin/) live at the monorepo root
    const monorepoRoot = resolve(appRoot, "..", "..");
    const distRoot = app.isPackaged
      ? resolve(process.resourcesPath, "app.asar.unpacked")
      : monorepoRoot;

    const binDir = app.isPackaged
      ? resolve(process.resourcesPath, "bin")
      : resolve(monorepoRoot, "bin");

    // 2. Import the bundled backend server (single ESM file, no node_modules needed)
    const serverUrl = pathToFileURL(resolve(appRoot, "dist-electron", "server.mjs")).href;
    const { setPaths, startServer, getConfig, setDesktopUpdater } = await import(serverUrl);

    // 3. Set paths before starting the server
    setPaths({
      rootDir: appRoot,
      configDir: resolve(distRoot, "config"),
      dataDir,
      binDir,
      publicDir: resolve(distRoot, "public"),
    });

    // 4. Start the proxy server (try configured port first, fall back to random if occupied)
    try {
      serverHandle = await startServer({ entrypoint: "desktop" });
    } catch (error) {
      // A lock conflict is not a port problem: another backend already owns this data
      // directory (CLI or a second desktop window). Running alongside would corrupt the
      // shared SQLite files, so report the holder and stop instead of retrying.
      if ((error as { code?: string })?.code === "INSTANCE_LOCKED") {
        const holder = (error as { holder?: { kind?: string; pid?: number; port?: number } }).holder;
        const who = `${holder?.kind ?? "another"} instance (pid ${holder?.pid ?? "?"}${holder?.port ? `, port ${holder.port}` : ""})`;
        dialog.showErrorBox(
          "OpenCodeX-Router is already running",
          `This data directory is already served by a ${who}.\n\n` +
            "Stop that instance first — two backends sharing one data directory would corrupt " +
            "its databases and schedulers.",
        );
        app.quit();
        return;
      }
      console.warn("[Electron] Default port in use, using random port");
      serverHandle = await startServer({ port: 0, entrypoint: "desktop" });
    }
    console.log(`[Electron] Server started on port ${serverHandle.port}`);

    // 4. System tray
    createTray();

    // 5. Main window
    createWindow();

    // 6. Auto-updater (only in packaged mode; never in unofficial OCGO builds,
    //    which have no GitHub feed and must not fall back to the upstream repo)
    if (app.isPackaged && !OCX_BUILD) {
      if (!IS_MAC) setDesktopUpdater({ getState: getAutoUpdateState, check: checkForUpdateManual, install: () => { isQuitting = true; installUpdate(); } });
      let autoUpdate = true;
      let autoDownload = false;
      let showUpdateDialog = false;
      let allowPrerelease = false;
      try {
        const updateCfg = getConfig().update;
        autoUpdate = updateCfg.auto_update;
        autoDownload = updateCfg.auto_download;
        showUpdateDialog = updateCfg.show_update_dialog;
        allowPrerelease = updateCfg.allow_prerelease;
      } catch { /* use defaults */ }
      initAutoUpdater({
        getMainWindow: () => mainWindow,
        rebuildTrayMenu,
        autoUpdate,
        autoDownload,
        showUpdateDialog,
        allowPrerelease,
      });
    }
  } catch (err) {
    console.error("[Electron] Startup failed:", err);
    dialog.showErrorBox(
      "Codex Proxy - Startup Error",
      `Failed to start:\n\n${err instanceof Error ? err.stack ?? err.message : String(err)}`,
    );
    quitApplication();
  }
});

function getAppIconPath(): string {
  const baseDir = app.isPackaged
    ? join(app.getAppPath(), "electron", "assets")
    : join(__dirname, "..", "electron", "assets");
  if (process.platform === "win32") {
    const icoPath = join(baseDir, "icon.ico");
    if (existsSync(icoPath)) return icoPath;
  }
  const pngPath = join(baseDir, "icon.png");
  if (existsSync(pngPath)) return pngPath;
  return "";
}

// ── Window ───────────────────────────────────────────────────────────

function createWindow(): void {
  if (IS_MAC) app.dock?.show();

  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const iconPath = getAppIconPath();

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 500,
    title: "Codex Proxy",
    autoHideMenuBar: true,
    ...(iconPath ? { icon: iconPath } : {}),
    // macOS: native hidden titlebar with traffic lights inset into content
    ...(IS_MAC
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 16, y: 18 },
        }
      : {}),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    show: false,
  });

  if (!IS_MAC) {
    mainWindow.setMenu(null);
  }

  const port = serverHandle?.port ?? 8080;
  mainWindow.loadURL(`http://127.0.0.1:${port}/`);

  // Mark <html> with platform class so frontend CSS can adapt
  mainWindow.webContents.on("did-finish-load", () => {
    const legacy = IS_MAC ? "electron-mac" : "electron-win";
    const platform = IS_MAC ? "platform-mac" : "platform-win";
    mainWindow?.webContents.executeJavaScript(
      `document.documentElement.classList.add("electron","${legacy}","${platform}")`,
    );
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  // Close → hide to tray instead of quitting (unless app is quitting)
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
      if (IS_MAC) app.dock?.hide();
    }
  });

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── Tray ─────────────────────────────────────────────────────────────

function quitApplication(): void {
  allowProcessExit = true;
  isQuitting = true;

  if (serverHandle) {
    const forceQuit = setTimeout(() => {
      console.error("[Electron] Server close timeout, forcing exit");
      app.exit(0);
    }, 5000);

    serverHandle.close()
      .then(() => { clearTimeout(forceQuit); app.quit(); })
      .catch((err: unknown) => {
        console.error("[Electron] Server close error:", err);
        clearTimeout(forceQuit);
        app.quit();
      });
  } else {
    app.quit();
  }
}

function buildTrayMenu(): Electron.MenuItemConstructorOptions[] {
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: "Open Dashboard",
      click: () => createWindow(),
    },
    { type: "separator" },
    {
      label: `Port: ${serverHandle?.port ?? 8080}`,
      enabled: false,
    },
    { type: "separator" },
  ];

  // Auto-update menu items
  const updateState = getAutoUpdateState();
  if (OCX_BUILD) {
    items.push({
      label: "OCGo Releases (manual updates)",
      click: () => { void shell.openExternal("https://github.com/LeonhardtHUST/codex-ocgo-proxy/releases"); },
    });
  } else if (updateState.downloaded) {
    items.push({
      label: `Install Update (v${updateState.version})`,
      click: () => installUpdate(),
    });
  } else if (updateState.downloading) {
    items.push({
      label: `Downloading Update... ${updateState.progress}%`,
      enabled: false,
    });
  } else if (updateState.updateAvailable) {
    items.push({
      // macOS: no code signing — open release page for manual DMG download
      label: IS_MAC && updateState.releaseUrl
        ? `Open Release Page (v${updateState.version})`
        : `Download Update (v${updateState.version})`,
      click: () => downloadUpdate(),
    });
  } else {
    items.push({
      label: "Check for Updates",
      click: () => checkForUpdateManual(),
    });
  }

  items.push(
    { type: "separator" },
    {
      label: "Quit",
      click: () => quitApplication(),
    },
  );

  return items;
}

function rebuildTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
  }
}

function createTray(): void {
  const iconPath = getAppIconPath();
  let icon = iconPath && existsSync(iconPath)
    ? nativeImage.createFromPath(iconPath)
    : nativeImage.createEmpty();

  // macOS: resize to 18x18 and mark as template for automatic dark/light adaptation
  if (IS_MAC && !icon.isEmpty()) {
    icon = icon.resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
  }

  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Codex Proxy");
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenu()));
  tray.on("click", () => createWindow());
}

// macOS: re-create window when dock icon is clicked
app.on("activate", () => {
  createWindow();
});

// Handle OS-initiated termination (system shutdown, logout).
// SIGTERM → quitApplication() sets allowProcessExit synchronously before
// before-quit fires, enabling graceful server cleanup instead of SIGKILL.
process.on("SIGTERM", () => {
  if (!isQuitting) quitApplication();
});

app.on("before-quit", (event) => {
  if (IS_MAC && !allowProcessExit) {
    event.preventDefault();
    mainWindow?.hide();
    app.dock?.hide();
    return;
  }

  isQuitting = true;
  stopAutoUpdater();
});

// Prevent app from quitting when all windows are closed (tray keeps it alive)
app.on("window-all-closed", () => {
  // Do nothing — tray keeps the app running
});
