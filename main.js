const { app, BrowserWindow, Menu, dialog, shell, session, desktopCapturer, ipcMain } = require('electron');
const path = require('path');
const QRCode = require('qrcode');
const srv = require('./server');
const { forwardUsb } = require('./usb');

const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
let info = null;
let capture = null;

async function infoPage() {
  const s = srv.getState();
  const addr = `${s.addresses[0] || 'localhost'}:${s.port}`;
  const qr = await QRCode.toDataURL(`http://${addr}/#pin=${s.pin}`, { margin: 1, width: 220 });
  const phones = s.devices.length ? s.devices.map(d => `<li>${esc(d.name)}</li>`).join('') : '<li>None yet</li>';
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
<h2>PIN</h2><p class="pin">${s.pin}</p><p class="mut">Changes after each pairing.</p>
<h2>Paired phones</h2><ul>${phones}</ul>
<h2>Shared folder</h2><p>${esc(s.share)}</p>`;
}

async function showInfo() {
  const html = await infoPage();
  if (!info) {
    info = new BrowserWindow({ width: 460, height: 680, title: 'fisync', autoHideMenuBar: true });
    info.on('closed', () => { info = null; app.quit(); });
  }
  info.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function openPhonePanel() {
  const s = srv.getState();
  const w = new BrowserWindow({ width: 800, height: 860, title: 'fisync phone', autoHideMenuBar: true });
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

function buildMenu() {
  const s = srv.getState();
  const mirroring = srv.isMirroring();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'fisync',
    submenu: [
      { label: 'Show pairing code', click: showInfo },
      { label: 'Open phone panel (calls, messages, photos)', click: openPhonePanel },
      { label: mirroring ? 'Stop sharing screen with phones' : 'Share screen with phones', click: () => srv.events.emit('mirror', !srv.isMirroring()) },
      { type: 'separator' },
      { label: 'Connect a phone over USB', click: usbConnect },
      { label: 'Open shared folder', click: () => shell.openPath(s.share) },
      { label: 'Forget all phones', click: forgetAll },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]));
}

// Approval dialog shown whenever a phone asks to pair with the right PIN.
const approve = name => dialog.showMessageBox({
  type: 'question', buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1,
  message: `Allow "${name}" to connect?`,
  detail: 'It will be able to control this computer and read and write files in the fisync folder. You can forget it later from the menu.',
}).then(r => r.response === 0);

app.whenReady().then(async () => {
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
  srv.events.on('pin', () => { if (info) showInfo(); });
  srv.events.on('state', buildMenu);

  try {
    await srv.start({ approve });
    buildMenu();
    await showInfo();
  } catch (e) {
    dialog.showErrorBox('fisync could not start', e.message);
    app.quit();
  }
});
