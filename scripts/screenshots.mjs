import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const output = fileURLToPath(new URL("../docs/screenshots/", import.meta.url));
await mkdir(output, { recursive: true });
await writeFile(
  output + "visual-checks.json",
  JSON.stringify({ completed: false, started_at: new Date().toISOString() }),
);
const browser = await chromium.launch({ headless: true });
const errors = [],
  checks = [];
const base = process.env.QINGXING_E2E_URL || "http://127.0.0.1:5188";
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(base);
  await page
    .getByRole("heading", { name: /让校园的每一程，\s*更轻盈。/ })
    .waitFor();
  await page.screenshot({
    path: output + "01-login-desktop.png",
    fullPage: true,
  });
  const groups = [
    {
      account: "管理员 · 贾鑫洋",
      pages: [
        ["运营驾驶舱", "02-overview"],
        ["运营分析", "06-analytics"],
        ["维修管理", "07-maintenance"],
        ["车辆调度", "08-dispatch"],
        ["基础资料", "09-admin"],
      ],
    },
    {
      account: "学生 · 欧阳晨",
      pages: [
        ["骑行首页", "12-student"],
        ["借车与归还", "03-rides"],
        ["路线规划", "04-routes"],
        ["碳积分", "05-carbon"],
        ["我的订单", "11-orders"],
        ["我的报修", "13-repair"],
      ],
    },
    {
      account: "运营员 · 郑一凡",
      pages: [
        ["运维工作台", "14-operator"],
        ["维修工单", "15-tickets"],
        ["调度任务", "16-dispatch"],
        ["风险处置", "17-risks"],
      ],
    },
  ];
  for (const group of groups) {
    await page.getByRole("button", { name: group.account }).click();
    await page.getByRole("button", { name: "登录青行", exact: true }).click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({
        width,
        height: width === 1440 ? 1000 : 844,
      });
      for (const [name, file] of group.pages) {
        await page
          .getByRole("navigation")
          .getByRole("button", { name, exact: true })
          .click();
        await page
          .getByRole("heading", { name, exact: true, level: 1 })
          .waitFor();
        await page.waitForLoadState("networkidle");
        await expect(page.locator(".loading")).toHaveCount(0);
        if (name === "基础资料") {
          await page.getByRole("button", { name: "查看数据库结构" }).click();
          await expect(page.locator(".entity-grid article")).toHaveCount(18);
          await expect(page.getByText(/trg_payment_guard/)).toBeVisible();
        }
        await page.evaluate(() => window.scrollTo(0, 0));
        checks.push({
          name,
          width,
          overflow: await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          alerts: await page.getByRole("alert").allTextContents(),
        });
        await page.screenshot({
          path: output + file + "-" + width + ".png",
          fullPage: true,
        });
      }
    }
    await page.getByRole("button", { name: "退出登录" }).click();
  }
  const report = {
    completed: true,
    generated_at: new Date().toISOString(),
    errors,
    checks,
  };
  await writeFile(
    output + "visual-checks.json",
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || checks.some((c) => c.overflow || c.alerts.length))
    process.exitCode = 1;
} catch (error) {
  await writeFile(
    output + "visual-checks.json",
    JSON.stringify(
      { completed: false, errors: [...errors, error.message], checks },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
