const { app, BrowserWindow, Menu, Tray, dialog, shell, session, desktopCapturer, ipcMain, nativeImage, clipboard, Notification, globalShortcut, safeStorage, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');
const srv = require('./server');
const { forwardUsb } = require('./usb');

process.on('uncaughtException', err => srv.recordCrash(err));

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const LABEL = { files: 'Files', control: 'Mouse and keyboard', screen: 'Screen', phone: 'Calls and messages', clipboard: 'Clipboard' };
const ALL = ['files', 'control', 'screen', 'phone', 'clipboard'];
let info = null, capture = null, tray = null, quitting = false, lastClip = '';
let dnd = false;   // do not disturb: phone alerts are kept in the app but not shown

async function infoPage() {
  const s = srv.getState();
  const addr = `${s.addresses[0] || 'localhost'}:${s.port}`;
  const secureAddr = `${s.addresses[0] || 'localhost'}:${s.securePort || s.port}`;
  const qr = await QRCode.toDataURL(srv.pairLink(), { margin: 1, width: 220 });   // same code as the desk panel, including the Tailscale name
  const phones = s.devices.length
    ? s.devices.map(d => `<li>${esc(d.name)}${d.locked ? ' (locked)' : ''}: ${esc((d.perms || ALL).map(p => LABEL[p]).join(', ') || 'no access')}</li>`).join('')
    : '<li>None yet</li>';
  return `<!doctype html><meta charset="utf-8"><title>fisync</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#111}
@media(prefers-color-scheme:dark){body{background:#0e0e10;color:#ececee}}
h1{font-size:18px;margin:0}h2{font-size:14px;margin:24px 0 8px}
.pin{font-size:32px;letter-spacing:6px;margin:4px 0}.mut{opacity:.7}
img{width:220px;height:220px;border:1px solid #8884;border-radius:4px}
ul{padding-left:18px;margin:4px 0}
</style>
<h1>fisync</h1>
<h2>Pair a phone</h2>
<img src="${qr}" alt="Pairing code">
<p>Scan this with your phone, or open <b>http://${esc(addr)}</b> and enter the PIN. You will then be asked to allow it here.</p>
<h2>PIN</h2><p class="pin">${s.pin}</p><p class="mut">Changes after each pairing, and every 5 minutes.</p>
<h2>Paired phones</h2><ul>${phones}</ul>
<h2>Screen sharing</h2><p>${srv.isMirroring() ? '<b>On</b>. Phones can see this screen.' : 'Off'}</p>
<h2>Clipboard sync</h2><p>${srv.isClipboardSync() ? '<b>On</b>. Text is shared with phones.' : 'Off'}</p>
<h2>Secure page</h2><p>Browsers need the fisync certificate once. Download it from http://${esc(addr)}/ca.pem and check that its fingerprint is <b>${esc(s.caFingerprint || 'not ready yet')}</b> before you install it.</p>
<h2>Setup checklist</h2><ul>
<li>Allow fisync through the firewall on private networks.</li>
<li>Turn on Bluetooth if you want call audio on this computer.</li>
<li>On Android, set fisync's battery use to Unrestricted, and allow notification access if you want notifications here.</li>
<li>To wake this computer from a phone, enable Wake-on-LAN in its network adapter settings.</li>
</ul>
<h2>Shared folder</h2><p>${esc(s.share)}</p>`;
}

const WINDOW_FILE = () => path.join(app.getPath('userData'), 'window.json');
function windowBounds(name, w, h) {
  try {
    const saved = JSON.parse(fs.readFileSync(WINDOW_FILE(), 'utf8'))[name];
    if (saved && saved.width > 200 && saved.height > 200) return saved;
  } catch (e) { /* first run */ }
  return { width: w, height: h };
}
function saveBounds(name, win) {
  if (!win || win.isDestroyed()) return;
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(WINDOW_FILE(), 'utf8')); } catch (e) { /* none yet */ }
    all[name] = win.getBounds();
    fs.writeFileSync(WINDOW_FILE(), JSON.stringify(all));
  } catch (e) { /* not worth stopping for */ }
}

async function updateInfo(show) {
  if (!info && !show) return;
  const html = await infoPage();
  if (!info || info.isDestroyed()) {
    info = new BrowserWindow({ ...windowBounds('info', 460, 780), title: 'fisync', autoHideMenuBar: true, webPreferences: HARDENED });
    info.on('close', e => { if (!quitting) { e.preventDefault(); info.hide(); } });   // closing keeps fisync in the tray
    info.on('closed', () => { info = null; });
    info.on('resize', () => saveBounds('info', info));
    info.on('move', () => saveBounds('info', info));
  }
  info.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  if (show) info.show();
}

// Settings for every window that shows fisync pages: no Node access in the page, and an isolated script context.
const HARDENED = { contextIsolation: true, nodeIntegration: false, sandbox: true };
// Pages may not open new windows.
app.on('web-contents-created', (_, contents) => {
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

function openPhonePanel() {
  const s = srv.getState();
  const w = new BrowserWindow({ width: 800, height: 860, title: 'fisync phone', autoHideMenuBar: true, webPreferences: HARDENED });
  // The panel stays on this computer's own page; any other address is blocked.
  w.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(`http://localhost:${s.port}/`)) e.preventDefault(); });
  w.loadURL(`http://localhost:${s.port}/desk#key=${s.owner}`);
}

// Screen sharing: a hidden window captures the screen and sends JPEG frames back here.
async function startCapture() {
  if (capture && !capture.isDestroyed()) return;
  capture = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(__dirname, 'capture-preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  await capture.loadFile(path.join(__dirname, 'capture.html'));
}
function stopCapture() {
  if (capture && !capture.isDestroyed()) capture.destroy();
  capture = null;
}
function toggleMirror() { srv.events.emit('mirror', !srv.isMirroring()); }
function toggleClipboard() { srv.setClipboardSync(!srv.isClipboardSync()); }

async function usbConnect() {
  const r = await forwardUsb(srv.getState().port);
  dialog.showMessageBox({ type: r.ok ? 'info' : 'error', message: r.ok ? 'Phone connected over USB' : 'USB connection failed', detail: r.msg });
}

async function forgetAll() {
  const r = await dialog.showMessageBox({
    type: 'warning', buttons: ['Forget', 'Cancel'], defaultId: 1, cancelId: 1,
    message: 'Forget all paired phones?',
    detail: 'Connected phones are disconnected, and each one must be approved again to reconnect.',
  });
  if (r.response === 0) srv.forgetDevices();
}

async function removePhone(d) {
  const r = await dialog.showMessageBox({
    type: 'warning', buttons: ['Remove', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Remove ${d.name}?`, detail: 'It is disconnected and must be approved again to reconnect.',
  });
  if (r.response === 0) srv.removeDevice(d.added);
}

function ago(t) {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function phoneMenu(d) {
  const perms = d.perms || ALL;
  return {
    label: d.name + (d.locked ? ' (locked)' : ''),
    submenu: [
      { label: d.lastSeen ? `Last seen ${ago(d.lastSeen)}` : 'Not seen yet', enabled: false },
      { label: `Paired ${new Date(d.added).toLocaleDateString()}`, enabled: false },
      { label: 'Rotate this phone\'s key', click: () => { const r = srv.rotatePhoneKey(d.added); if (!r.ok) dialog.showMessageBox({ message: r.reason }); } },
      { label: d.via ? `Connected by ${({ tailscale: 'Tailscale', local: 'local network', usb: 'USB or this computer', other: 'another network', relay: 'a relay' })[d.via]}` : 'Not connected yet', enabled: false },
      { type: 'separator' },
      { label: 'Full access', click: () => srv.setPerms(d.added, ALL) },
      { label: 'Files only', click: () => srv.setPerms(d.added, ['files']) },
      { type: 'separator' },
      ...ALL.map(p => ({
        label: `${perms.includes(p) ? '✓ ' : '    '}${LABEL[p]}`,
        click: () => srv.setPerms(d.added, perms.includes(p) ? perms.filter(x => x !== p) : [...perms, p]),
      })),
      { type: 'separator' },
      { label: 'Remove this phone', click: () => removePhone(d) },
    ],
  };
}

function clipMenu() {
  const items = srv.clipboardHistory().map(entry => ({
    label: `${entry.from === 'phone' ? 'From phone' : 'From this computer'}: ${entry.text.replace(/\s+/g, ' ').slice(0, 44)}`,
    click: () => clipboard.writeText(entry.text),
  }));
  return items.length ? items : [{ label: 'Nothing copied yet', enabled: false }];
}

async function exportSettingsFile() {
  const r = await dialog.showSaveDialog({ defaultPath: 'fisync-settings.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (!r.canceled && r.filePath) fs.writeFileSync(r.filePath, JSON.stringify(srv.exportSettings(), null, 2));
}
async function importSettingsFile() {
  const r = await dialog.showOpenDialog({ filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    srv.importSettings(JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8')));
  } catch (e) {
    dialog.showErrorBox('Import settings', e.message);
  }
}

function buildMenu() {
  const s = srv.getState();
  const phones = s.devices.length
    ? [...s.devices.map(phoneMenu), { type: 'separator' }, { label: 'Forget all phones', click: forgetAll }]
    : [{ label: 'No paired phones', enabled: false }];
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'fisync',
    submenu: [
      { label: 'Show pairing code', click: () => updateInfo(true) },
      { label: 'Open phone panel (calls, messages, photos)', click: openPhonePanel },
      { label: srv.isMirroring() ? 'Stop sharing screen with phones' : 'Share screen with phones', click: toggleMirror },
      { label: 'Sync clipboard with phones', type: 'checkbox', checked: srv.isClipboardSync(), click: toggleClipboard },
      { type: 'separator' },
      { label: 'Paired phones', submenu: phones },
      { label: 'Connect a phone over USB', click: usbConnect },
      { type: 'separator' },
      { label: 'Start fisync when I sign in', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: m => app.setLoginItemSettings({ openAtLogin: m.checked }) },
      { label: srv.isLocked() ? 'Unlock phones' : 'Lock phones now',
        click: () => (srv.isLocked() ? srv.unlockComputer() : srv.lockComputer('locked from the menu')) },
      { label: 'Do not disturb (hide phone alerts)', type: 'checkbox', checked: dnd, click: m => { dnd = m.checked; } },
      { label: srv.isPaused() ? 'Resume phones' : 'Pause phones for 1 hour',
        click: () => (srv.isPaused() ? srv.resumeLink() : srv.pauseFor(3600000, 'from the menu')) },
      { label: 'Export settings…', click: exportSettingsFile },
      { label: 'Import settings…', click: importSettingsFile },
      { label: 'Clipboard history', submenu: clipMenu() },
      { label: 'Rotate phone-panel key', click: () => { srv.rotateOwnerKey(); openPhonePanel(); } },
      { label: 'Open activity log', click: () => shell.openPath(srv.LOG) },
      { label: 'Check for updates', click: () => autoUpdater.checkForUpdatesAndNotify().catch(e => dialog.showErrorBox('Updates', e.message)) },
      { label: 'Open shared folder', click: () => shell.openPath(s.share) },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]));
}

function buildTray() {
  if (tray) return;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'tray.png')));
  tray.on('click', () => updateInfo(true));
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  tray.setToolTip(srv.isMirroring() ? 'fisync · sharing your screen' : 'fisync');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show pairing code', click: () => updateInfo(true) },
    { label: 'Open phone panel', click: openPhonePanel },
    { label: srv.isMirroring() ? 'Stop sharing screen' : 'Share screen with phones', click: toggleMirror },
    { label: srv.isClipboardSync() ? 'Turn clipboard sync off' : 'Turn clipboard sync on', click: toggleClipboard },
    { type: 'separator' },
    { label: 'Quit fisync', click: () => app.quit() },
  ]));
}

// Approval dialog shown whenever a phone asks to connect (new, or reconnecting after inactivity).
const approve = name => dialog.showMessageBox({
  type: 'question', buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0,
  message: `Allow "${name}" to connect?`,
  detail: 'It can use the features you allow for it in the Paired phones menu. Remove it at any time.',
}).then(r => r.response === 1);

// The key that encrypts the paired-phone list. It is itself protected by Windows or the Linux keyring.
function storageKeyFor() {
  if (!safeStorage.isEncryptionAvailable()) return null;   // no keyring: the list stays plain text
  const keyFile = path.join(app.getPath('userData'), 'store.key');
  try {
    if (fs.existsSync(keyFile)) return Buffer.from(safeStorage.decryptString(fs.readFileSync(keyFile)), 'hex');
    const hex = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyFile, safeStorage.encryptString(hex), { mode: 0o600 });
    return Buffer.from(hex, 'hex');
  } catch (e) {
    return null;
  }
}

function toastNotice(text) {
  if (!dnd && Notification.isSupported()) new Notification({ title: 'fisync', body: text }).show();
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) return app.quit();     // a second copy would fail to use port 8484
  app.on('second-instance', () => updateInfo(true));
  app.on('before-quit', () => { quitting = true; stopCapture(); });
  app.on('window-all-closed', () => {});                          // keep running in the tray

  // Gives the hidden capture window the screen when it asks for it.
  session.defaultSession.setDisplayMediaRequestHandler((_req, cb) => {
    desktopCapturer.getSources({ types: ['screen'] })
      .then(src => cb({ video: src[0] }))
      .catch(() => cb({}));
  });

  ipcMain.on('frame', (_e, buf) => srv.pushFrame(Buffer.from(buf)));
  ipcMain.on('capture-failed', (_e, msg) => {
    stopCapture();
    srv.setMirroring(false);
    dialog.showErrorBox('Screen sharing', msg);
  });

  srv.events.on('mirror', async on => {
    if (!on) { stopCapture(); srv.setMirroring(false); return; }
    try {
      await startCapture();
      srv.setMirroring(true);
    } catch (e) {
      stopCapture();
      srv.setMirroring(false);
      dialog.showErrorBox('Screen sharing', 'Could not start: ' + e.message);
    }
  });

  // Clipboard: only read while sync is on. Text is never written back to the phones it came from.
  setInterval(() => {
    if (!srv.isClipboardSync()) return;
    const t = clipboard.readText();
    if (t && t !== lastClip) { lastClip = t; srv.pushClipboard(t); }
  }, 1000);
  srv.events.on('clip', t => { if (t !== lastClip) { lastClip = t; clipboard.writeText(t); } });

  srv.events.on('network', addrs => {
    if (Notification.isSupported()) {
      new Notification({
        title: 'fisync',
        body: addrs.length ? 'The network changed. Pair or share only on networks you trust.' : 'Offline. fisync reconnects when a network is available.',
      }).show();
    }
    updateInfo(false);
  });
  // Texts, calls and notifications from the phone. Texts can be answered from the notification.
  srv.events.on('incoming', m => {
    if (dnd || !Notification.isSupported()) return;
    if (m.t === 'notif') {
      new Notification({ title: m.app || 'Phone notification', body: [m.title, m.text].filter(Boolean).join(': ').slice(0, 200) }).show();
      return;
    }
    const who = m.name || m.from || m.number || 'Unknown';
    const isText = m.t === 'smsin';
    const n = new Notification({
      title: isText ? 'New text' : 'Incoming call',
      body: isText ? `${who}: ${String(m.body || '').slice(0, 120)}` : `From ${who}`,
      hasReply: isText && process.platform !== 'linux',
      replyPlaceholder: 'Reply',
    });
    if (isText) {
      n.on('reply', (_event, text) => {
        if (!srv.sendTextFromComputer(m.from, text)) toastNotice('The phone is not connected, so the reply was not sent.');
      });
    }
    n.on('click', openPhonePanel);
    n.show();
  });

  // Keyboard shortcuts that work from any app.
  globalShortcut.register('CommandOrControl+Shift+M', toggleMirror);
  globalShortcut.register('CommandOrControl+Shift+C', toggleClipboard);
  globalShortcut.register('CommandOrControl+Shift+P', openPhonePanel);
  app.on('will-quit', () => globalShortcut.unregisterAll());

  // Lock the phones when the computer sleeps. Unlock them from the menu when you are back.
  powerMonitor.on('suspend', () => srv.lockComputer('the computer went to sleep'));

  srv.events.on('phonestatus', m => {
    if (tray && m.battery !== undefined) {
      tray.setToolTip(`fisync · phone ${m.battery}%${m.charging ? ' charging' : ''}`);
    }
  });
  srv.events.on('pin', () => updateInfo(false));
  srv.events.on('state', () => { buildMenu(); refreshTray(); updateInfo(false); });

  try {
    await srv.start({ approve, storageKey: storageKeyFor() });
  } catch (e) {
    dialog.showErrorBox('fisync could not start', e.code === 'EADDRINUSE'
      ? 'Port 8484 is already in use. Close the other program that uses it, then start fisync again.'
      : e.message);
    return app.quit();
  }
  buildMenu();
  buildTray();
  if (app.isPackaged) autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  await updateInfo(true);
});
