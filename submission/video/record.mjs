import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("submission/video/demo");
const footageDir = path.join(root, "footage");
await mkdir(footageDir, { recursive: true });

const url = "https://wasm-oj-forge.jacoblincool.chatgpt.site/";
const solution = `#include <stdio.h>

int main(void) {
    int n, q;
    if (scanf("%d %d", &n, &q) != 2) return 0;
    static long long prefix[200001];
    prefix[0] = 0;
    for (int i = 1; i <= n; ++i) {
        long long cost;
        scanf("%lld", &cost);
        prefix[i] = prefix[i - 1] + cost;
    }
    for (int i = 0; i < q; ++i) {
        long long budget;
        scanf("%lld", &budget);
        int lo = 0, hi = n;
        while (lo < hi) {
            int mid = lo + (hi - lo + 1) / 2;
            if (prefix[mid] <= budget) lo = mid;
            else hi = mid - 1;
        }
        printf("%d\\n", lo);
    }
    return 0;
}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1920, height: 1080 },
  recordVideo: { dir: footageDir, size: { width: 1920, height: 1080 } },
  reducedMotion: "reduce",
  colorScheme: "dark",
});

await context.addInitScript(() => {
  localStorage.setItem("wasm-oj-forge-v1:judge-onboarding:v1", "completed");
  localStorage.setItem("wasm-oj-forge-v1:judge-ui-locale:v1", "en");
});

const page = await context.newPage();
const video = page.video();
const startedAt = Date.now();
const elapsed = () => Number(((Date.now() - startedAt) / 1000).toFixed(3));
const milestones = {};

await page.goto(url, { waitUntil: "load", timeout: 120_000 });
await page.getByRole("heading", { name: "Progressive Cost Budget" }).waitFor({ timeout: 120_000 });
await page.getByText("Ready to submit", { exact: true }).waitFor({ timeout: 180_000 });
await page.addStyleTag({
  content: "*,*::before,*::after{animation:none!important;transition:none!important}*{caret-color:transparent!important}::-webkit-scrollbar{width:0!important;height:0!important}",
});

await page.getByRole("button", { name: "Open getting started guide" }).click();
const localChapter = page.locator(".onboarding-nav button").filter({ hasText: "02 · Local" });
await localChapter.click();
await page.getByRole("heading", { name: "From source code to verdict, inside this tab" }).waitFor();
milestones.localStart = elapsed();
await page.waitForTimeout(30_000);

await page.getByRole("button", { name: "Close tutorial" }).click();
await page.getByText("Ready to submit", { exact: true }).waitFor();
milestones.workspaceStart = elapsed();
await page.waitForTimeout(8_000);

milestones.buildStart = elapsed();
await page.mouse.click(1170, 270);
await page.keyboard.press("Meta+A");
await page.keyboard.type(solution, { delay: 1 });
await page.waitForTimeout(1_000);
await page.getByRole("button", { name: "Build", exact: true }).click();
await page.locator(".terminal-output").getByText(/Completed .*\.wasm/).waitFor({ timeout: 120_000 });
milestones.buildResult = elapsed();
await page.waitForTimeout(26_000);

await page.getByRole("button", { name: "Self Test", exact: true }).click();
await page.getByRole("button", { name: "Run Case 1" }).waitFor();
milestones.selfTestStart = elapsed();
await page.getByRole("button", { name: "Run Case 1" }).click();
await page.getByText("exited · exit 0", { exact: true }).waitFor({ timeout: 120_000 });
milestones.selfTestResult = elapsed();
await page.waitForTimeout(25_000);

milestones.submitStart = elapsed();
await page.getByRole("button", { name: "Submit", exact: true }).click();
await page.getByText("Accepted", { exact: true }).waitFor({ timeout: 120_000 });
await page.getByText("4 / 4 cases · 100.00 / 100 points", { exact: false }).waitFor({ timeout: 120_000 });
milestones.accepted = elapsed();
await page.waitForTimeout(35_000);
milestones.end = elapsed();

await writeFile(path.join(root, "milestones.json"), `${JSON.stringify(milestones, null, 2)}\n`);
await page.screenshot({ path: path.resolve("submission/assets/03-accepted-verdict.png") });
await page.close();
if (!video) throw new Error("Playwright did not create a recording.");
await video.saveAs(path.join(footageDir, "session.webm"));
await context.close();
await browser.close();

console.log(JSON.stringify({ video: path.join(footageDir, "session.webm"), milestones }, null, 2));
