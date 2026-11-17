
const {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell
} = require('electron');

const path = require('path');
const fs = require('fs');
const os = require('os');
const media = require('./media');

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const WIN_WIDTH = 760;

function createWindow() {
  const win = new BrowserWindow({
    width: WIN_WIDTH,
    height: 560,
    useContentSize: true,
    minHeight: 200,
    title: 'Squeeze',

    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    show: false,

    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  const reveal = () => { if (!win.isDestroyed() && !win.isVisible()) win.show(); };
  setTimeout(reveal, 1500);

  win.loadFile('index.html');
}

ipcMain.on('fit-height', (event, height) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || !Number.isFinite(height)) return;

  const area = require('electron').screen.getDisplayMatching(win.getBounds()).workArea;
  const h = Math.max(200, Math.min(Math.round(height), area.height));

  win.setContentSize(WIN_WIDTH, h);

  const b = win.getBounds();
  if (b.y + b.height > area.y + area.height) {
    win.setPosition(b.x, Math.max(area.y, area.y + area.height - b.height));
  }
  if (!win.isVisible()) win.show();
});

ipcMain.on('close-app', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  if (win) win.close();
});

let lastCpu = null;
function cpuTimes() {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}
ipcMain.handle('cpu-usage', () => {
  const now = cpuTimes();
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total <= prev.total) return 0;
  const busy = 1 - (now.idle - prev.idle) / (now.total - prev.total);
  return Math.max(0, Math.min(100, Math.round(busy * 100)));
});

const saveTargets = new Map();
const openFiles = new Map();
let fileSeq = 0;

ipcMain.handle('save-choose-dir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showOpenDialog(win, {
    title: 'Choose where to save the files',
    properties: ['openDirectory', 'createDirectory']
  });
  if (pick.canceled || !pick.filePaths[0]) return { canceled: true };
  saveTargets.set(event.sender.id, { dir: pick.filePaths[0], used: new Set(), first: null, count: 0 });
  return { dir: pick.filePaths[0] };
});

function uniqueName(target, rawName) {
  const parsed = path.parse(path.basename(String(rawName || 'file')));
  const baseName = parsed.name || 'file';
  const extension = parsed.ext;

  let name = `${baseName}${extension}`;
  let n = 1;
  while (target.used.has(name.toLowerCase()) || fs.existsSync(path.join(target.dir, name))) {
    name = `${baseName} (${n++})${extension}`;
  }
  target.used.add(name.toLowerCase());
  return name;
}

ipcMain.handle('save-open', async (event, rawName) => {
  const target = saveTargets.get(event.sender.id);
  if (!target) throw new Error('No folder was chosen.');

  const name = uniqueName(target, rawName);
  const outputPath = path.join(target.dir, name);
  const handle = await fs.promises.open(outputPath, 'wx');
  const id = ++fileSeq;
  openFiles.set(id, { handle, path: outputPath, owner: event.sender.id });
  return { id, name };
});

ipcMain.handle('save-write', async (event, id, bytes) => {
  const f = openFiles.get(id);
  if (!f || f.owner !== event.sender.id) throw new Error('Unknown file.');
  await f.handle.writeFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
});

ipcMain.handle('save-close', async (event, id, ok) => {
  const f = openFiles.get(id);
  if (!f || f.owner !== event.sender.id) return;
  openFiles.delete(id);
  await f.handle.close();
  const target = saveTargets.get(event.sender.id);
  if (ok) {
    if (target) { target.first = target.first || f.path; target.count++; }
  } else {
    await fs.promises.unlink(f.path).catch(() => {});
  }
});

ipcMain.handle('save-finish', async (event) => {
  const target = saveTargets.get(event.sender.id);
  if (!target) return { dir: '', count: 0 };
  saveTargets.delete(event.sender.id);
  if (target.first) shell.showItemInFolder(target.first);
  return { dir: target.dir, count: target.count };
});

const nativeTmp = new Set();

ipcMain.handle('native-ready', () => media.available());

ipcMain.handle('native-compress', async (event, job) => {
  const ext = String((job && job.ext) || '').toLowerCase();
  if (!job || !media.NATIVE.has(ext) || typeof job.path !== 'string' || !fs.existsSync(job.path)) {
    return { ok: false, reason: 'bad request' };
  }
  const id = Number(job.id) || 0;
  const quality = ['high', 'bal', 'small'].includes(job.quality) ? job.quality : 'bal';
  const threads = Math.max(1, Math.min(Number(job.threads) || 1, os.cpus().length || 1));

  const r = await media.compress({
    inPath: job.path,
    ext,
    quality,
    threads,
    tmpDir: media.tmpRoot(),
    outName: `${id}-${path.basename(job.path)}`,
    onProgress: (pct) => { if (!event.sender.isDestroyed()) event.sender.send('native-progress', id, pct); }
  });
  if (r.ok) nativeTmp.add(r.path);
  return r;
});

ipcMain.handle('native-discard', async (event, p) => {
  if (nativeTmp.delete(p)) await fs.promises.unlink(p).catch(() => {});
});

ipcMain.handle('save-temp', async (event, tmpPath, rawName) => {
  const target = saveTargets.get(event.sender.id);
  if (!target) throw new Error('No folder was chosen.');
  if (!nativeTmp.has(tmpPath)) throw new Error('Unknown file.');
  const name = uniqueName(target, rawName);
  const dest = path.join(target.dir, name);
  await fs.promises.copyFile(tmpPath, dest, fs.constants.COPYFILE_EXCL);
  target.first = target.first || dest;
  target.count++;
  return { name };
});

ipcMain.handle('save-temp-as', async (event, tmpPath, rawName) => {
  if (!nativeTmp.has(tmpPath)) throw new Error('Unknown file.');
  const win = BrowserWindow.fromWebContents(event.sender);
  const pick = await dialog.showSaveDialog(win, { defaultPath: path.basename(String(rawName || 'file')) });
  if (pick.canceled || !pick.filePath) return { canceled: true };
  await fs.promises.copyFile(tmpPath, pick.filePath);
  shell.showItemInFolder(pick.filePath);
  return { saved: true };
});

app.on('will-quit', () => {
  media.cancelAll();
  try { fs.rmSync(media.tmpRoot(), { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Hello from the developer :D