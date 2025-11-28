const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    startCrawl: (url) => ipcRenderer.invoke('start-crawl', url),
    openOutputFolder: () => ipcRenderer.invoke('open-output-folder'),
    onProgress: (callback) => {
        ipcRenderer.on('crawl-progress', (_, data) => callback(data));
    },
    removeProgressListener: () => {
        ipcRenderer.removeAllListeners('crawl-progress');
    }
});
