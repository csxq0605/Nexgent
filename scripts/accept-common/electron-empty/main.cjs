// An empty Electron app for the desktop-layer smoke check: one window with
// the isolation settings the desktop app must use (contextIsolation, renderer
// sandbox, no Node integration) and a static page. Replaced by apps/desktop
// once it exists (step-2 round 3).
const { app, BrowserWindow } = require('electron')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 480,
    height: 320,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  })
  win.loadURL('data:text/html;charset=utf-8,<!doctype html><title>nexgent-empty</title><p id="ok">ok</p>')
})

app.on('window-all-closed', () => app.quit())
