const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let mainWindow;

function getUserDataPath() {
    const appName = 'STV-Epub-Tool';
    const platform = process.platform;
    
    if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', appName);
    } else if (platform === 'win32') {
        return path.join(process.env.APPDATA || os.homedir(), appName);
    } else {
        return path.join(os.homedir(), '.config', appName);
    }
}

function getOutputPath() {
    const userDataPath = getUserDataPath();
    const outputPath = path.join(userDataPath, 'output');
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }
    return outputPath;
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        minWidth: 600,
        minHeight: 500,
        titleBarStyle: 'hiddenInset',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    mainWindow.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
    }
});

ipcMain.handle('start-crawl', async (event, url) => {
    console.log(`[Main] Received crawl request for: ${url}`);

    try {
        const { crawlNovel } = require('../dist/crawler');

        const result = await crawlNovel(url, (progress) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (progress.type === 'info' || progress.type === 'warning') {
                    console.log(`[Crawler] ${progress.type.toUpperCase()}: ${progress.message}`);
                }

                mainWindow.webContents.send('crawl-progress', progress);
            }
        });

        console.log('[Main] Crawl completed successfully:', result);
        return { success: true, result };

    } catch (error) {
        console.error('[Main] FATAL ERROR during crawl:');
        console.error('  Message:', error.message);
        console.error('  Stack:', error.stack);

        return {
            success: false,
            error: error.message,
            stack: error.stack
        };
    }
});

ipcMain.handle('open-output-folder', async () => {
    const outputPath = getOutputPath();
    shell.openPath(outputPath);
});
