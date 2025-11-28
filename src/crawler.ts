import { createWorker, Worker } from 'tesseract.js';
import { BrowserContext, Page, chromium } from "playwright";
import fs from "fs";
import path from "path";
import os from "os";
import { EPub } from 'epub-gen-memory';
import type { Options, Chapter } from 'epub-gen-memory';
import slugify from 'slugify';

type ChapterInfo = {
    url: string;
    title: string;
};

type ProgressCallback = (progress: {
    type: 'chapter' | 'info' | 'warning';
    message?: string;
    current?: number;
    total?: number;
    title?: string;
}) => void;

let worker: Worker | null = null;

function getAppBasePath(): string {
    if (process.env.ELECTRON_RUN_AS_NODE || process.versions.electron) {
        const appPath = process.env.PORTABLE_EXECUTABLE_DIR 
            || (process.resourcesPath ? path.dirname(process.resourcesPath) : process.cwd());
        return appPath;
    }
    return process.cwd();
}

function getUserDataPath(): string {
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

function getProfilePath(): string {
    const userDataPath = getUserDataPath();
    const profilePath = path.join(userDataPath, 'profile_edge');
    if (!fs.existsSync(profilePath)) {
        fs.mkdirSync(profilePath, { recursive: true });
    }
    return profilePath;
}

function getExtensionPath(): string {
    const basePath = getAppBasePath();
    const possiblePaths = [
        path.join(basePath, 'extensions', 'ublock'),
        path.join(basePath, 'resources', 'extensions', 'ublock'),
        path.join(process.resourcesPath || '', 'extensions', 'ublock'),
        path.join(__dirname, '..', 'extensions', 'ublock'),
        path.join(process.cwd(), 'extensions', 'ublock'),
    ];

    for (const p of possiblePaths) {
        if (fs.existsSync(p)) {
            console.log(`[Crawler] Found uBlock extension at: ${p}`);
            return p;
        }
    }

    throw new Error(
        `uBlock extension not found!\n` +
        `Searched locations:\n` +
        possiblePaths.map((p, i) => `  ${i + 1}. ${p}`).join('\n') + '\n' +
        `Please ensure extensions folder is included in the build.`
    );
}

function getOutputPath(): string {
    const userDataPath = getUserDataPath();
    const outputPath = path.join(userDataPath, 'output');
    if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true });
    }
    return outputPath;
}

function getTesseractDataFolder(): string {
    const filename = 'vie.traineddata';

    if (process.resourcesPath) {
        const packagedPath = path.join(process.resourcesPath, filename);
        if (fs.existsSync(packagedPath)) {
            console.log(`[Crawler] Found Tesseract data at: ${packagedPath}`);
            return process.resourcesPath;
        }
    }

    const localPath = path.join(process.cwd(), filename);
    if (fs.existsSync(localPath)) {
        console.log(`[Crawler] Found Tesseract data at: ${localPath}`);
        return process.cwd();
    }

    const basePath = getAppBasePath();
    const basePathFile = path.join(basePath, filename);
    if (fs.existsSync(basePathFile)) {
        console.log(`[Crawler] Found Tesseract data at: ${basePathFile}`);
        return basePath;
    }

    throw new Error(
        `Tesseract language data '${filename}' not found!\n` +
        `Searched locations:\n` +
        `  1. ${process.resourcesPath ? path.join(process.resourcesPath, filename) : 'N/A (not packaged)'}\n` +
        `  2. ${localPath}\n` +
        `  3. ${basePathFile}\n` +
        `Please ensure vie.traineddata is included in the build.`
    );
}

async function closeAllPages(context: BrowserContext) {
    const pages = context.pages();

    if (pages.length === 0) {
        return;
    }

    await Promise.all(pages.map(page => {
        try {
            return page.close();
        } catch (error) {
            console.warn(`Error closing page: ${error}`);
            return Promise.resolve();
        }
    }));
}

function textToHtml(ocrText: string): string {
    const escapeHtml = (str: string) =>
        str.replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");

    const lines = ocrText.split(/\r?\n/).filter(line => line.trim() !== '');
    const bodyHtml = lines.map(line => `<p>${escapeHtml(line.trim())}</p>`).join('\n');

    return bodyHtml;
}

function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

async function humanBehavior(page: Page) {
    for (let i = 0; i < 5; i++) {
        const x = Math.floor(Math.random() * 700) + 100;
        const y = Math.floor(Math.random() * 500) + 100;
        await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 20) + 5 });
        await sleep(Math.random() * 400 + 200);
    }

    await page.evaluate(() => {
        let total = 0;
        const step = 20;
        const interval = setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= window.innerHeight * 0.8) clearInterval(interval);
        }, 15 + Math.random() * 20);
    });
    await sleep(Math.random() * 500 + 300);

    await sleep(Math.random() * 500 + 500);
    await page.evaluate(() => {
        window.scrollBy(0, -window.innerHeight * 0.5);
    });
    await sleep(Math.random() * 500 + 300);

    for (let i = 0; i < 3; i++) {
        await page.mouse.move(Math.random() * 10 - 5, Math.random() * 10 - 5, { steps: 3 });
        await sleep(Math.random() * 200 + 100);
    }
}

function randomViewport() {
    return {
        width: 1200 + Math.floor(Math.random() * 200),
        height: 700 + Math.floor(Math.random() * 200)
    };
}

async function init(): Promise<BrowserContext> {
    console.log('[Crawler] Getting profile path...');
    const userDataDir = getProfilePath();
    console.log(`[Crawler] Profile path: ${userDataDir}`);

    console.log('[Crawler] Getting extension path...');
    const extPath = getExtensionPath();
    console.log(`[Crawler] Extension path: ${extPath}`);

    console.log('[Crawler] Launching browser context...');
    const context = await chromium.launchPersistentContext(userDataDir, {
        channel: "chrome",
        headless: false,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
        args: [
            '--disable-blink-features=AutomationControlled',
            `--disable-extensions-except=${extPath}`,
            `--load-extension=${extPath}`,
            '--disable-features=IsolateOrigins,site-per-process,OptimizationGuideModelDownloading',
            '--disable-infobars',
            '--no-sandbox',
            '--no-first-run',
            '--no-default-browser-check',
            '--start-maximized',
        ],
        viewport: randomViewport(),
        locale: "vi-VN",
        bypassCSP: true,
        ignoreHTTPSErrors: true,
        acceptDownloads: true,
        serviceWorkers: "allow",
    });
    
    await context.addInitScript(() => {
        Object.defineProperty(navigator, "webdriver", { get: () => undefined });

        Object.defineProperty(navigator, "plugins", {
            get: () => [1, 2, 3],
        });

        Object.defineProperty(navigator, "languages", {
            get: () => ["vi-VN", "vi"],
        });

        Object.defineProperty(navigator, "platform", {
            get: () => "Win32",
        });

        const globalWindow = window as unknown as { chrome?: { app?: unknown } };
        if (globalWindow?.chrome && typeof globalWindow?.chrome === 'object') {
            globalWindow.chrome.app = {
                isInstalled: false,
                getDetails: () => null,
                getIsInstalled: () => false
            };
        }

        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function (p) {
            if (p === 34921) return 16;
            if (p === 37445) return "Intel Inc.";
            if (p === 37446) return "Intel(R) UHD Graphics 620";
            return getParameter.call(this, p);
        };
    });

    await context.setExtraHTTPHeaders({
        "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    await context.route("**/*", (route) => route.continue());

    return context;
}

async function crawlChapter(page: Page, _chapterInfo: ChapterInfo, onProgress?: ProgressCallback): Promise<string> {
    await humanBehavior(page);
    const captchaSelector = 'div#captcha';

    const captchaPresent = await page.$(captchaSelector);

    if (captchaPresent) {
        onProgress?.({ type: 'warning', message: 'CAPTCHA detected, please solve it...' });

        await page.waitForFunction((selector) => !document.querySelector(selector), captchaSelector, { timeout: 0 });

        onProgress?.({ type: 'info', message: 'CAPTCHA solved' });
    }

    await page.waitForSelector("#content-container", { timeout: 0 });

    const needUnlock = await page.evaluate(() => {
        const el = document.querySelector("#content-container");
        if (!el) return false;
        return el.textContent?.includes("Nhap vao de tai chuong...") ?? false;
    });

    if (needUnlock) {
        await page.click("#content-container");
        await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    }

    await humanBehavior(page);
    await page.waitForFunction(() => {
        const el = document.querySelector("#content-container");
        if (!el) return false;
        const text = el.textContent ?? '';
        return !text.includes("Nhap vao de tai chuong...") && !text.includes("Dang tai chuong...");
    }, { timeout: 0 });

    if (!worker) {
        const langFolder = getTesseractDataFolder();
        console.log(`[Crawler] Initializing Tesseract with langPath: ${langFolder}`);

        worker = await createWorker('vie', 1, {
            langPath: langFolder,
            gzip: false,
            cachePath: langFolder,
            logger: (m) => {
                if (m.status === 'loading language traineddata') {
                    console.log(`[Tesseract] Loading ${m.status}... ${Math.round(m.progress * 100)}%`);
                }
            }
        });

        console.log('[Crawler] Tesseract worker initialized successfully');
    }

    try {
        await page.waitForSelector("#content-container", { timeout: 0 });
        const contentElement = page.locator("#content-container");
        const screenshotBuffer = await contentElement.screenshot();
        const { data } = await worker.recognize(screenshotBuffer);

        await humanBehavior(page);
        return textToHtml(data.text);
    } catch (error) {
        console.error(error);
    }

    return "";
}

async function crawlNovelInternal(page: Page, url: string, onProgress?: ProgressCallback): Promise<string> {
    console.log(`[Crawler] Navigating to novel page: ${url}`);
    await page.goto(url, { waitUntil: "load", timeout: 0 });
    console.log('[Crawler] Novel page loaded');

    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await humanBehavior(page);

    const captchaSelector = 'div#captcha';
    const captchaPresent = await page.$(captchaSelector);

    if (captchaPresent) {
        onProgress?.({ type: 'warning', message: 'CAPTCHA detected, waiting...' });

        await page.waitForFunction((selector) => !document.querySelector(selector), captchaSelector, { timeout: 0 });

        onProgress?.({ type: 'info', message: 'CAPTCHA solved!' });
    }

    const imgSrc = await page.$eval("#thumb-prop", (img: HTMLImageElement) => img.src);

    await page.waitForFunction(() => {
        const box = document.querySelector("div#chapterlist");
        if (!box) return false;
        const text = box.textContent || "";
        return !text.includes("Dang tai danh sach chuong...");
    });

    await humanBehavior(page);
    const chapters = await page.$$eval("div#chaptercontainerinner a.listchapitem", els =>
        els.map((el, i) => ({
            url: window.location.href + (i + 1) + '/',
            title: (el as HTMLAnchorElement).title || "",
        }))
    );

    if (chapters.length === 0) {
        throw new Error("No chapters found!");
    }

    onProgress?.({ type: 'info', message: `Found ${chapters.length} chapters` });

    const bookSummary = await page.$eval("#book-sumary", (div: HTMLDivElement) => div.innerText.trim());

    const texts = await page.$$eval("div.blk-body.ib-100", (divs: HTMLDivElement[]) =>
        divs.map(div => div.innerText.trim())
    );

    let hanviet = "";
    let author = "";
    let origin = "";
    let date = "";

    texts.forEach(line => {
        const [key, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        switch (key.trim()) {
            case "Han viet":
                hanviet = value;
                break;
            case "Tac gia":
                author = value;
                break;
            case "Nguon truyen":
                origin = value;
                break;
            case "Nhap thoi":
                date = value;
                break;
        }
    });

    console.log(`[Crawler] Extracted metadata - Title: "${hanviet}", Author: "${author}", Origin: "${origin}", Date: "${date}"`);

    const outputDir = getOutputPath();
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    let validDate: string | undefined = undefined;
    if (date) {
        const parsedDate = new Date(date);
        if (!isNaN(parsedDate.getTime())) {
            validDate = date;
        } else {
            console.log(`[Crawler] Warning: Invalid date "${date}", using current date`);
            validDate = new Date().toISOString().split('T')[0];
        }
    } else {
        validDate = new Date().toISOString().split('T')[0];
    }

    const option: Options = {
        title: hanviet,
        author: author,
        date: validDate,
        cover: imgSrc,
        description: textToHtml(bookSummary),
        lang: "vi",
        tocTitle: "Danh sach chuong",
        numberChaptersInTOC: true,
        publisher: origin,
    };

    const content: Chapter[] = [{
        title: "Bia",
        content: `<div style="text-align:center;"><img src="${imgSrc}" alt="Bia sach" style="max-width:100%;height:auto;"></div>`,
        excludeFromToc: true,
        beforeToc: true
    }];

    console.log(`[Crawler] Navigating to first chapter`);
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));

    const firstChapter = page.locator("div#chaptercontainerinner a.listchapitem").first();
    await firstChapter.scrollIntoViewIfNeeded();
    await firstChapter.waitFor({ state: "visible" });
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));

    await firstChapter.click({ timeout: 60000 });
    await page.waitForLoadState('load', { timeout: 60000 });

    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        onProgress?.({ 
            type: 'chapter', 
            current: i + 1, 
            total: chapters.length, 
            title: chapter.title 
        });
        
        const html = await crawlChapter(page, chapter, onProgress);
        content.push({
            title: chapter.title,
            content: html,
        });

        if (i === chapters.length - 1) {
            continue;
        }

        await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));

        console.log(`[Crawler] Navigating to chapter ${i + 2}/${chapters.length}`);

        const selectors = ["a#navnextbot", "a#navnexttop"];
        const chosenSelector = selectors[Math.floor(Math.random() * selectors.length)];
        const nextButton = page.locator(chosenSelector);
        await nextButton.scrollIntoViewIfNeeded();
        await nextButton.waitFor({ state: "visible" });
        await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));

        await nextButton.click({ timeout: 60000 });
        await page.waitForLoadState('load', { timeout: 60000 });
    }

    const epub = new EPub(option, content);
    const newEpub = await epub.render();

    const buffer = await newEpub.genEpub();

    let slugName: string = slugify(hanviet, {
        lower: true,
        strict: true
    });

    if (!slugName || slugName.trim() === '') {
        console.log(`[Crawler] Warning: Empty title, using fallback filename`);
        const timestamp = new Date().getTime();
        slugName = `novel-${timestamp}`;
    }

    console.log(`[Crawler] Saving EPUB as: ${slugName}.epub`);
    const epubPath = path.join(outputDir, `${slugName}.epub`);
    fs.writeFileSync(epubPath, buffer);

    return `${slugName}.epub`;
}

export function isValidSVTUrl(url: string): boolean {
    try {
        const u = new URL(url);

        if (!u.hostname.includes("sangtacviet")) {
            return false;
        }

        const regex = /^\/truyen\/[a-zA-Z0-9_-]+\/\d+\/\d+\/?$/;

        return regex.test(u.pathname);
    } catch {
        return false;
    }
}

export async function crawlNovel(url: string, onProgress?: ProgressCallback): Promise<string> {
    console.log('[Crawler] Starting crawlNovel function');

    if (!isValidSVTUrl(url.trim())) {
        throw new Error("Invalid STV URL!");
    }
    console.log('[Crawler] URL validation passed');

    if (!worker) {
        console.log('[Crawler] Worker not initialized, starting initialization...');
        const langFolder = getTesseractDataFolder();
        console.log(`[Crawler] Initializing Tesseract with langPath: ${langFolder}`);

        worker = await createWorker('vie', 1, {
            langPath: langFolder,
            gzip: false,
            cachePath: langFolder,
            logger: (m) => {
                if (m.status === 'loading language traineddata') {
                    console.log(`[Tesseract] Loading ${m.status}... ${Math.round(m.progress * 100)}%`);
                }
            }
        });

        console.log('[Crawler] Tesseract worker initialized successfully');
    } else {
        console.log('[Crawler] Using existing Tesseract worker');
    }

    console.log('[Crawler] Initializing browser context...');
    const context = await init();
    console.log('[Crawler] Browser context initialized');

    console.log('[Crawler] Creating new page...');
    const page = await context.newPage();
    console.log('[Crawler] New page created');

    try {
        const result = await crawlNovelInternal(page, url, onProgress);
        return result;
    } finally {
        await closeAllPages(context);
        await context.close();
    }
}
