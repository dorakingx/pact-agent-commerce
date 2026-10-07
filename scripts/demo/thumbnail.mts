/** Renders scripts/demo/thumbnail.html to artifacts/devpost/00-thumbnail.png (1500x1000, the 3:2 ratio Devpost recommends). */
import { chromium } from "@playwright/test";
const b = await chromium.launch();
const p = await (await b.newContext({ viewport: { width: 1500, height: 1000 }, deviceScaleFactor: 1 })).newPage();
await p.goto("file://" + process.cwd() + "/scripts/demo/thumbnail.html");
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(800);
await p.screenshot({ path: "artifacts/devpost/00-thumbnail.png" });
await b.close();
