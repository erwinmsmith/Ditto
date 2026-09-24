const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync, readFileSync, existsSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const directory = process.env.DITTO_DESKTOP_WORKSPACE;
if (!directory || !require('node:path').isAbsolute(directory)) throw new Error('Missing dedicated desktop workspace');
app.setPath('userData', join(directory, 'desktop-profile'));
app.whenReady().then(() => {
  ipcMain.handle('save-note', (_, value) => {
    if (!value || typeof value.title !== 'string' || typeof value.body !== 'string' || value.title.length > 100 || value.body.length > 1000) throw new Error('Invalid note');
    const path = join(directory, 'desktop-note.json'), body = JSON.stringify(value);
    if (existsSync(path) && readFileSync(path, 'utf8') !== body) throw new Error('Note conflicts with previous save');
    if (!existsSync(path)) writeFileSync(path, body, { flag: 'wx' });
    return 'Saved';
  });
  const window = new BrowserWindow({ width: 680, height: 460, show: true, webPreferences: { preload: join(__dirname, 'desktop-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(join(__dirname, 'desktop.html'));
});
app.on('window-all-closed', () => app.quit());
