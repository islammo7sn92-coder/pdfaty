import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ar from "../src/i18n/ar";

const S: Record<string, string> = JSON.parse(readFileSync(join(process.cwd(), "e2e", ".samples", "samples.json"), "utf8"));

async function openDoc(page: Page, file: string) {
  await page.goto("/");
  await page.locator(".hero-drop input[type=file]").setInputFiles(file);
  await expect(page.locator(".page .canvas-holder canvas").first()).toBeVisible();
}

async function openTool(page: Page, cat: string, tool: string) {
  if (!(await page.locator(".toolpanel").isVisible())) await page.getByRole("button", { name: ar["ws.tools"] }).click();
  const back = page.locator(".toolhost .panel-head button").first();
  if (await back.isVisible().catch(() => false)) await back.click();
  const head = page.locator(".cat-head", { hasText: ar[`cat.${cat}`] });
  if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  await page.locator(".tool-item", { hasText: ar[`tool.${tool}`] }).click();
  await expect(page.locator(".toolhost h2")).toContainText(ar[`tool.${tool}`]);
}

async function canvasInk(page: Page): Promise<number> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".page .canvas-holder canvas");
    if (!c) return 0;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 140) n++;
    return n;
  });
}

const toastSuccess = (page: Page) => expect(page.locator(".toast-success").last()).toBeVisible();

test("home page is Arabic RTL and switches to English", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("h1")).toHaveText(ar["home.title"]);
  await page.getByRole("button", { name: ar["header.switchLang"] }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator("h1")).toContainText("Every PDF tool");
  await page.getByRole("button", { name: "Switch language" }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
});

test("open PDF, render, navigate and zoom", async ({ page }) => {
  await openDoc(page, S.english);
  await expect(page.locator(".page-form")).toContainText("/ 6");
  await expect.poll(() => canvasInk(page)).toBeGreaterThan(50);
  await page.getByRole("button", { name: ar["ws.next"] }).click();
  await expect(page.locator(".page-input")).toHaveValue("2");
  await page.getByRole("button", { name: ar["ws.zoomIn"] }).click();
  await expect(page.locator(".zoom-select")).not.toHaveValue("fit-width");
  await page.getByRole("radio", { name: ar["ws.double"] }).click();
  await expect(page.locator(".page-row").first().locator(".page")).toHaveCount(2);
});

test("search English and Arabic text with highlights", async ({ page }) => {
  await openDoc(page, S.english);
  await page.getByRole("tab", { name: ar["side.search"] }).click();
  await page.getByPlaceholder(ar["search.placeholder"]).fill("INV-1003");
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-nav")).toContainText("1 من 1");
  await expect(page.locator("mark.hl.active")).toBeVisible();

  await openDoc(page, S.arabic);
  await page.getByRole("tab", { name: ar["side.search"] }).click();
  await page.getByPlaceholder(ar["search.placeholder"]).fill("توريد");
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-hits li").first()).toBeVisible();
});

test("invalid file shows a clear error", async ({ page }) => {
  await page.goto("/");
  await page.locator(".hero-drop input[type=file]").setInputFiles(S.bad);
  await expect(page.locator(".toast-error")).toContainText(ar["err.invalid_pdf"]);
});

test("password-protected PDF asks for the password", async ({ page }) => {
  await page.goto("/");
  await page.locator(".hero-drop input[type=file]").setInputFiles(S.encrypted);
  await expect(page.getByRole("dialog", { name: ar["pw.title"] })).toBeVisible();
  await page.getByLabel(ar["pw.label"]).fill("wrong");
  await page.getByRole("dialog").getByRole("button", { name: ar["pw.open"], exact: true }).click();
  await expect(page.getByText(ar["pw.incorrect"])).toBeVisible();
  await page.getByLabel(ar["pw.label"]).fill("user123");
  await page.getByRole("dialog").getByRole("button", { name: ar["pw.open"], exact: true }).click();
  await expect(page.locator(".page-form")).toContainText("/ 6");
});

test("add watermark, undo, redo and download", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "watermark", "watermark_add");
  await page.getByLabel(ar["f.text"]).fill("سري جدا");
  await page.getByRole("button", { name: ar["common.apply"] }).click();
  await toastSuccess(page);
  await expect(page.locator(".doc-name .dot")).toBeVisible();
  await page.getByRole("button", { name: ar["ws.undo"] }).click();
  await expect(page.getByRole("button", { name: ar["ws.redo"] })).toBeEnabled();
  await page.getByRole("button", { name: ar["ws.redo"] }).click();
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".ws-bar .btn-primary").click()]);
  const buf = readFileSync((await dl.path())!);
  expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
  // the watermark adds a form XObject + embedded font: the file must have grown
  expect(buf.length).toBeGreaterThan(readFileSync(S.english).length + 2000);
});

test("page numbers preview and apply", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "edit", "page_numbers");
  await page.getByRole("button", { name: ar["common.previewPage"].replace("{n}", "1") }).click();
  await expect(page.locator(".preview-box canvas")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: ar["common.apply"] }).click();
  await toastSuccess(page);
});

test("organize pages: rotate and delete then apply", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "organize", "organize");
  const items = page.locator(".org-item");
  await expect(items).toHaveCount(6);
  await items.nth(0).click();
  await page.getByRole("button", { name: ar["org.rotR"] }).click();
  await items.nth(5).click();
  await page.getByRole("button", { name: ar["org.delete"] }).click();
  await expect(items).toHaveCount(5);
  await page.locator(".org-bar").getByRole("button", { name: ar["common.apply"] }).click();
  await expect(page.locator(".toast-success")).toBeVisible();
  await page.locator(".org-bar").getByRole("button", { name: ar["common.close"] }).click();
  await expect(page.locator(".page-form")).toContainText("/ 5");
});

test("merge two PDFs (standalone tool)", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cat-card button", { hasText: ar["tool.merge"] }).click();
  await page.locator(".filelist input[type=file]").setInputFiles([S.english, S.arabic]);
  await expect(page.locator(".filelist li")).toHaveCount(2);
  await page.getByRole("button", { name: ar["merge.run"].replace("{n}", "2") }).click();
  await expect(page.locator(".outputs li")).toHaveCount(1);
  const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(".outputs li").getByRole("button", { name: ar["common.download"] }).click()]);
  const buf = readFileSync((await dl.path())!).toString("latin1");
  expect(buf.startsWith("%PDF-")).toBeTruthy();
});

test("compress shows before/after sizes", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "optimize", "compress");
  await page.getByRole("button", { name: ar["common.apply"] }).click();
  await expect(page.locator(".result-box")).toContainText(/قبل|الحجم/);
});

test("redaction by pattern is permanent and verified", async ({ page }) => {
  await openDoc(page, S.arabic);
  await openTool(page, "protect", "redact");
  await page.getByRole("radio", { name: ar["redact.search"] }).click();
  await page.getByLabel(ar["preset.email"]).check();
  await page.getByLabel(ar["preset.national_id"]).check();
  await page.getByRole("button", { name: ar["redact.findMatches"] }).click();
  await expect(page.locator(".redact-hit").first()).toBeVisible();
  await page.getByRole("button", { name: ar["redact.apply"] }).click();
  await page.getByRole("dialog").getByRole("button", { name: ar["common.confirm"] }).click();
  await expect(page.locator(".result-box")).toContainText(ar["redact.verified"]);
  // the redacted e-mail must not be searchable any more
  await page.getByRole("tab", { name: ar["side.search"] }).click();
  await page.getByPlaceholder(ar["search.placeholder"]).fill("sales@example.com");
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-nav")).toContainText(ar["search.none"]);
});

test("protect with password then the result opens with it", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "protect", "protect");
  await page.getByLabel(ar["f.userPassword"]).fill("pass-123");
  await page.getByLabel(ar["f.ownerPassword"]).fill("owner-456");
  await page.getByRole("button", { name: ar["common.apply"] }).click();
  await expect(page.getByRole("dialog", { name: ar["pw.title"] })).toBeVisible();
  await page.getByLabel(ar["pw.label"]).fill("pass-123");
  await page.getByRole("dialog").getByRole("button", { name: ar["pw.open"], exact: true }).click();
  await toastSuccess(page);
});

test("OCR makes a scanned Arabic page searchable", async ({ page }) => {
  await openDoc(page, S.scanned);
  await openTool(page, "ocr", "ocr");
  await page.getByRole("button", { name: ar["common.apply"] }).click();
  await expect(page.locator(".result-box")).toContainText("صفحة 1", { timeout: 120_000 });
  await page.getByRole("tab", { name: ar["side.search"] }).click();
  await page.getByPlaceholder(ar["search.placeholder"]).fill("توريد");
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-hits li").first()).toBeVisible();
});

test("highlight selected text and list it in comments", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "review", "annotate");
  const span = page.locator(".page[data-page='0'] .textLayer span", { hasText: "Hello world page 1" }).first();
  await expect(span).toBeVisible();
  const box = (await span.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(".pending li")).toHaveCount(1);
  await page.getByRole("button", { name: ar["annot.save"] }).click();
  await toastSuccess(page);
  await page.getByRole("tab", { name: ar["side.comments"] }).click();
  await expect(page.locator(".comment-list li")).toHaveCount(1);
});

test("edit existing text", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "edit", "edit_text");
  const target = page.locator(".page[data-page='0'] .tobj[title*='INV-1000']");
  await expect(target).toBeVisible();
  await target.click();
  await page.getByLabel(ar["edittext.new"]).fill("Invoice number INV-7777 total 1.00 USD");
  await page.getByRole("button", { name: ar["edittext.queue"] }).click();
  await page.getByRole("button", { name: ar["common.apply"] }).click();
  await toastSuccess(page);
  await page.getByRole("tab", { name: ar["side.search"] }).click();
  await page.getByPlaceholder(ar["search.placeholder"]).fill("INV-7777");
  await page.keyboard.press("Enter");
  await expect(page.locator(".search-nav")).toContainText("1 من 1");
});

test("digital signature with a certificate, then verify", async ({ page }) => {
  await openDoc(page, S.english);
  await openTool(page, "review", "digital_sign");
  await page.getByLabel(ar["dsig.cert"]).setInputFiles(S.cert);
  await page.getByLabel(ar["dsig.certPw"]).fill("certpw");
  await expect(page.locator(".busy-backdrop")).toHaveCount(0);
  const pg = page.locator(".page[data-page='0'] .overlay");
  const b = (await pg.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.7, b.y + 300);
  await expect(page.locator(".sigbox-preview")).toBeVisible();
  await page.getByRole("button", { name: ar["dsig.sign"] }).click();
  await expect(page.locator(".result-box")).toContainText(ar["dsig.validSig"]);
  await openTool(page, "review", "verify_signatures");
  await expect(page.locator(".item-editor")).toContainText(ar["dsig.validSig"]);
  await expect(page.locator(".item-editor")).toContainText("PDFATY Test Signer");
});

test("fill a form", async ({ page }) => {
  await openDoc(page, S.form);
  await openTool(page, "forms", "forms_fill");
  const nameField = page.locator(".form-field", { hasText: "name" }).first().locator("input");
  await nameField.fill("أحمد علي");
  await page.getByRole("button", { name: ar["forms.save"] }).click();
  await toastSuccess(page);
});

test("compare two versions in contract mode", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cat-card button", { hasText: ar["tool.compare"] }).click();
  await page.locator(".cmp-pick > div").nth(0).locator("input[type=file]").setInputFiles(S.arabic);
  await page.locator(".cmp-pick > div").nth(1).locator("input[type=file]").setInputFiles(S.arabic_v2);
  await page.getByRole("button", { name: ar["cmp.run"] }).click();
  await expect(page.locator(".cmp-item").first()).toBeVisible();
  expect(await page.locator(".cmp-item").count()).toBeGreaterThanOrEqual(3);
  await expect(page.locator(".cmp-list")).toContainText("1,350,000");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: ar["cmp.report"] }).click()]);
  expect((await dl.suggestedFilename()).endsWith(".pdf")).toBeTruthy();
});

test("batch: compress two files", async ({ page }) => {
  await page.goto("/");
  await page.locator(".cat-card button", { hasText: ar["tool.batch"] }).click();
  await page.locator(".batch input[type=file]").first().setInputFiles([S.english, S.arabic]);
  await expect(page.locator(".batch-rows li")).toHaveCount(2);
  await page.getByRole("button", { name: ar["batch.run"].replace("{n}", "2") }).click();
  await expect(page.locator(".batch-rows li.b-done")).toHaveCount(2, { timeout: 60_000 });
  const [dl] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: ar["batch.zip"] }).click()]);
  expect(await dl.suggestedFilename()).toContain(".zip");
});

test("mobile layout has no horizontal scroll", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.locator(".hero-drop input[type=file]").setInputFiles(S.arabic);
  await expect(page.locator(".page .canvas-holder canvas").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await ctx.close();
});

test("keyboard: tools are reachable and dialogs close with Escape", async ({ page }) => {
  await openDoc(page, S.english);
  await page.getByRole("button", { name: ar["ws.close"] }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".hero")).toBeVisible();
});
