// 墨卷 · Windows 桌面端入口
// 在本地 127.0.0.1 起一个微型 HTTP 服务，把内联好的离线单文件版喂给渲染进程，
// 这样维基文库在线取书时跨域(CORS) 不会因为 null 源被拦。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const HTML_FILE = path.join(__dirname, 'mojuan-offline.html');
let server = null;

function startServer() {
  const html = fs.readFileSync(HTML_FILE);
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end(html);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function createWindow(port) {
  const win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    title: '墨卷',
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });
  win.loadURL('http://127.0.0.1:' + port + '/');
  win.on('closed', () => { if (server) server.close(); });
}

app.whenReady().then(async () => {
  const port = await startServer();
  createWindow(port);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
