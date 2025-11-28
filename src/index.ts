import { createWorker, Worker } from 'tesseract.js';
import { BrowserContext, Page, chromium } from "playwright";
import fs from "fs";
import path from "path";
import { EPub } from 'epub-gen-memory';
import type { Options, Chapter } from 'epub-gen-memory';
import slugify from 'slugify';
import * as readline from 'readline';

type ChapterInfo = {
    url: string;
    title: string;
};

let worker: Worker | null = null;

async function closeAllPages(context: BrowserContext) {
    const pages = context.pages();

    if (pages.length === 0) {
        console.log("Không có trang nào đang mở để đóng.");
        return;
    }

    await Promise.all(pages.map(page => {
        try {
            return page.close();
        } catch (error) {
            console.warn(`Lỗi khi đóng một trang: ${error}`);
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
    // random mouse moves
    for (let i = 0; i < 5; i++) {
        const x = Math.floor(Math.random() * 700) + 100;
        const y = Math.floor(Math.random() * 500) + 100;
        await page.mouse.move(x, y, { steps: Math.floor(Math.random() * 20) + 5 });
        await sleep(Math.random() * 400 + 200);
    }

    // scroll down in chunks
    await page.evaluate(() => {
    let total = 0;
    const step = 20;
    const interval = setInterval(() => {
        window.scrollBy(0, step);
        total += step;
        if (total >= window.innerHeight * 0.8) clearInterval(interval);
    }, 15 + Math.random() * 20); // 15–35ms per step
    });
    await sleep(Math.random() * 500 + 300);

    // pause and scroll up
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
        width: 1200 + Math.floor(Math.random() * 200),   // 1200–1400
        height: 700 + Math.floor(Math.random() * 200)    // 700–900
    };
}


async function init(): Promise<BrowserContext> {

    const userDataDir = "./profile_edge";
    const extPath = path.join(process.cwd(), "extensions", "ublock");
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

        const globalWindow = window as any;
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
            return getParameter(p);
        };
    });


    await context.setExtraHTTPHeaders({
        "accept-language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
    });

    await context.route("**/*", (route) => route.continue());

    return context;
}

async function crawlChapter(page: Page, dto: ChapterInfo): Promise<string> {
    // Random delay
    await humanBehavior(page);
    const captchaSelector = 'div#captcha';;

    const captchaPresent = await page.$(captchaSelector);

    if (captchaPresent) {
        console.log("Phát hiện có CAPTCHA, xin vui lòng giải quyết ...");

        await page.waitForFunction((selector) => !document.querySelector(selector), captchaSelector, { timeout: 0 });

        console.log("CAPTCHA đã được giải");
    }

    await page.waitForSelector("#content-container", { timeout: 0 });

    const needUnlock = await page.evaluate(() => {
        const el = document.querySelector("#content-container");
        if (!el) return false;
        return el.textContent.includes("Nhấp vào để tải chương...");
    });

    if (needUnlock) {
        await page.click("#content-container");
        await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    }

    await humanBehavior(page);
    await page.waitForFunction(() => {
        const el = document.querySelector("#content-container");
        if (!el) return false;
        return !el.textContent.includes("Nhấp vào để tải chương...") && !el.textContent.includes("Đang tải chương...");
    }, { timeout: 0 });


    if (!worker) {
        worker = await createWorker('vie');
    }
    try {
        await page.waitForSelector("#content-container", { timeout: 0 });
        const contentElement = page.locator("#content-container");
        const screenshotBuffer = await contentElement.screenshot();
        const { data } = await worker?.recognize(screenshotBuffer);

        await humanBehavior(page);
        return textToHtml(data.text);

    } catch (error) {
        console.error(error);
    }

    return "";
}

async function crawlNovel(page: Page, url: string) {
    await page.goto(url, { waitUntil: "load", timeout: 0 });

    // Scroll to simulate user activity
    await page.evaluate(() => window.scrollBy(0, window.innerHeight))
    await humanBehavior(page);

    const captchaSelector = 'div#captcha';
    const captchaPresent = await page.$(captchaSelector);

    if (captchaPresent) {
        console.log("Phát hiện có Captcha chờ ...");

        await page.waitForFunction((selector) => !document.querySelector(selector), captchaSelector, { timeout: 0 });

        console.log("CAPTCHA đã được giải!");
    }

    const imgSrc = await page.$eval("#thumb-prop", (img: HTMLImageElement) => img.src);

    await page.waitForFunction(() => {
        const box = document.querySelector("div#chapterlist");
        if (!box) return false;
        const text = box.textContent || "";
        return !text.includes("Đang tải danh sách chương...");
    });

    await humanBehavior(page);
    const chapters = await page.$$eval("div#chaptercontainerinner a.listchapitem", els =>
        els.map((el, i) => ({
            url: window.location.href + (i + 1) + '/',
            title: (el as HTMLAnchorElement).title || "",
        }))
    );

    if (chapters.length == 0) {
        console.log("Không có chapter nào!")
        return
    }
    const bookSummary = await page.$eval("#book-sumary", (div: HTMLDivElement) => div.innerText.trim());

    const texts = await page.$$eval("div.blk-body.ib-100", (divs: HTMLDivElement[]) =>
        divs.map(div => div.innerText.trim())
    );

    let name = "";
    let hanviet = "";
    let author = "";
    let category = "";
    let origin = "";
    let typeNovel = "";
    let date = "";

    texts.forEach(line => {
        const [key, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        switch (key.trim()) {
            case "Tên gốc":
                name = value;
                break;
            case "Hán việt":
                hanviet = value;
                break;
            case "Tác giả":
                author = value;
                break;
            case "Thể loại":
                category = value;
                break;
            case "Nguồn truyện":
                origin = value;
                break;
            case "Loại truyện":
                typeNovel = value;
                break;
            case "Nhập thời":
                date = value;
                break;
        }
    });
    const outputDir = path.join(process.cwd(), "output");
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const option: Options = {
        title: hanviet,
        author: author,
        date: date,
        cover: imgSrc,
        description: textToHtml(bookSummary),
        lang: "vi",
        tocTitle: "Danh sách chương",
        numberChaptersInTOC: true,
        publisher: origin,
    };

    const content: Chapter[] = [{
        title: "Bìa",
        content: `<div style="text-align:center;"><img src="${imgSrc}" alt="Bìa sách" style="max-width:100%;height:auto;"></div>`,
        excludeFromToc: true,
        beforeToc: true
    }]


    const firstChapter = page.locator("div#chaptercontainerinner a.listchapitem").first();

    await firstChapter.scrollIntoViewIfNeeded();
    await firstChapter.waitFor({ state: "visible" });
    await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'load', timeout: 0 }),
        firstChapter.click(),
    ]);

    for (let i = 0; i < chapters.length; i++) {
        const chapter = chapters[i];
        console.log(`⏳ Đang xử lý chương ${i + 1}/${chapters.length}: ${chapter.title}`);
        const html = await crawlChapter(page, chapter);
        content.push({
            title: chapter.title,
            content: html,
        });

        if (i === chapters.length - 1) {
            continue
        }

        const selectors = ["a#navnextbot", "a#navnexttop"];
        const chosenSelector = selectors[Math.floor(Math.random() * selectors.length)];
        const nextButton = page.locator(chosenSelector);
        await nextButton.scrollIntoViewIfNeeded();
        await nextButton.waitFor({ state: "visible" });
        await page.waitForTimeout(Math.floor(Math.random() * 1000 + 500));
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'load', timeout: 0 }),
            nextButton.click(),
        ]);
    }

    const epub = new EPub(option, content);
    const newEpub = await epub.render()

    const buffer = await newEpub.genEpub();
    const slugName: string = slugify(hanviet, {
        lower: true,
        strict: true
    });
    const epubPath = path.join(outputDir, `${slugName}.epub`);
    fs.writeFileSync(epubPath, buffer);

    console.log(`✅ EPub đã được tạo: output/${slugName}.epub`);
}

function promptUser(question: string): Promise<string> {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    return new Promise((resolve) => {
        rl.question(question, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
}
function isValidSVTUrl(url: string): boolean {
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

(async () => {
    const url = await promptUser("Vui lòng nhập URL truyện trên SVT cần crawl\nVí dụ: https://sangtacviet.app/truyen/sangtac/1/42585/: ");

    if (!url) {
        console.log("⚠️ URL không được nhập. Thoát chương trình.");
        process.exit(0);
    }

    if (!isValidSVTUrl(url.trim())) {
        console.log("❌ URL không hợp lệ hoặc không phải URL truyện SVT!");
        process.exit(0);
    }

    if (!worker) {
        worker = await createWorker('vie');
    }

    const context = await init();
    const page = await context.newPage();

    try {
        await crawlNovel(page, url);
    } catch (err) {
        console.error("❌ Đã xảy ra lỗi trong quá trình crawl:", err);
    } finally {
        await closeAllPages(context);
        await context.close();
        process.exit(0);
    }
})();
