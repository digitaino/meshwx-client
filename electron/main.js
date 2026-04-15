const { app, BrowserWindow } = require('electron');
const path = require('path');

// Enable Web Bluetooth
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch('enable-web-bluetooth', 'true');

// In production, web files are in resources/app/; in dev, they're in ../
const isProd = app.isPackaged;
const webRoot = isProd
    ? path.join(process.resourcesPath, 'app')
    : path.join(__dirname, '..');

function createWindow() {
    const win = new BrowserWindow({
        width: 1024,
        height: 768,
        title: 'MeshWX',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
    });

    win.loadFile(path.join(webRoot, 'index.html'));

    // Handle Web Bluetooth device selection.
    // The web app's requestDevice() already filters by the MeshCore service UUID,
    // so only matching radios appear here. If exactly one is found, auto-select it.
    // If multiple are found, ask the renderer to let the user pick via an IPC-free
    // approach: we inject a small selection dialog.
    let bluetoothCallback = null;
    let bluetoothTimeout = null;

    win.webContents.on('select-bluetooth-device', (event, devices, callback) => {
        event.preventDefault();
        bluetoothCallback = callback;

        // Clear any previous auto-select timeout
        if (bluetoothTimeout) clearTimeout(bluetoothTimeout);

        if (devices.length === 1) {
            // Only one matching device — auto-select it
            callback(devices[0].deviceId);
            bluetoothCallback = null;
        } else if (devices.length > 1) {
            // Multiple devices found — show a picker dialog in the renderer
            const deviceList = devices.map(d => ({
                id: d.deviceId,
                name: d.deviceName || 'Unknown Device',
            }));
            const script = `
                (function() {
                    if (document.getElementById('ble-picker')) return;
                    const overlay = document.createElement('div');
                    overlay.id = 'ble-picker';
                    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:9999;display:flex;align-items:center;justify-content:center';
                    const box = document.createElement('div');
                    box.style.cssText = 'background:#1e1e2e;border-radius:12px;padding:24px;min-width:300px;color:#fff;font-family:system-ui';
                    box.innerHTML = '<h3 style="margin:0 0 16px">Select Bluetooth Device</h3>';
                    ${JSON.stringify(deviceList)}.forEach(d => {
                        const btn = document.createElement('button');
                        btn.textContent = d.name;
                        btn.dataset.deviceId = d.id;
                        btn.style.cssText = 'display:block;width:100%;padding:12px;margin:6px 0;border:1px solid #444;border-radius:8px;background:#2a2a3e;color:#fff;font-size:1rem;cursor:pointer';
                        btn.onmouseover = () => btn.style.background='#3a3a5e';
                        btn.onmouseout = () => btn.style.background='#2a2a3e';
                        btn.onclick = () => { window.__blePickResult = d.id; overlay.remove(); };
                        box.appendChild(btn);
                    });
                    const cancel = document.createElement('button');
                    cancel.textContent = 'Cancel';
                    cancel.style.cssText = 'display:block;width:100%;padding:10px;margin:12px 0 0;border:none;border-radius:8px;background:#555;color:#fff;font-size:0.9rem;cursor:pointer';
                    cancel.onclick = () => { window.__blePickResult = ''; overlay.remove(); };
                    box.appendChild(cancel);
                    overlay.appendChild(box);
                    document.body.appendChild(overlay);
                })();
            `;
            win.webContents.executeJavaScript(script).catch(() => {});

            // Poll for user selection
            const pollPick = setInterval(async () => {
                try {
                    const result = await win.webContents.executeJavaScript('window.__blePickResult');
                    if (result !== undefined && result !== null) {
                        clearInterval(pollPick);
                        win.webContents.executeJavaScript('delete window.__blePickResult').catch(() => {});
                        if (bluetoothCallback) {
                            bluetoothCallback(result);
                            bluetoothCallback = null;
                        }
                    }
                } catch { clearInterval(pollPick); }
            }, 200);

            // Timeout after 30 seconds
            bluetoothTimeout = setTimeout(() => {
                clearInterval(pollPick);
                win.webContents.executeJavaScript(`
                    document.getElementById('ble-picker')?.remove();
                    delete window.__blePickResult;
                `).catch(() => {});
                if (bluetoothCallback) {
                    bluetoothCallback('');
                    bluetoothCallback = null;
                }
            }, 30000);
        }
        // If no devices yet, do nothing — event will fire again as more are found
    });

    // Cancel BLE selection if the page navigates away
    win.webContents.on('did-navigate', () => {
        if (bluetoothCallback) {
            bluetoothCallback('');
            bluetoothCallback = null;
        }
        if (bluetoothTimeout) {
            clearTimeout(bluetoothTimeout);
            bluetoothTimeout = null;
        }
    });

    // Handle Web Serial port selection — show native picker
    win.webContents.session.on('select-serial-port', (event, portList, webContents, callback) => {
        event.preventDefault();
        if (portList.length > 0) {
            callback(portList[0].portId);
        } else {
            callback('');
        }
    });

    // Grant permissions for serial and bluetooth
    win.webContents.session.setPermissionCheckHandler((webContents, permission) => {
        return true;
    });

    win.webContents.session.setPermissionRequestHandler((webContents, permission, callback) => {
        callback(true);
    });

    win.webContents.session.setDevicePermissionHandler((details) => {
        return true;
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});
