const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const { start } = require('./server');

app.whenReady().then(async () => {
  try {
    const { port, share } = await start();
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'fisync', submenu: [
        { label: 'Open shared folder', click: () => shell.openPath(share) },
        { role: 'quit' },
      ] },
    ]));
    new BrowserWindow({ width: 460, height: 700, title: 'fisync' })
      .loadURL(`http://localhost:${port}/pair`);
  } catch (e) {
    dialog.showErrorBox('fisync could not start', e.message);
    app.quit();
  }
});
app.on('window-all-closed', () => app.quit());
