import { test, expect } from "@playwright/test";

test.describe("北京时间的运营分析", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("日期与库存曲线正确处理跨时区和采样缺口", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2026-10-04T18:30:00Z"));
    await page.route("**/api/analytics?**", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.inventory_series = [
        {
          zone_id: 1,
          captured_at: "2026-10-04T18:00:00Z",
          available: 2,
          capacity: 10,
          segment_id: 1,
        },
        {
          zone_id: 1,
          captured_at: "2026-10-04T18:10:00Z",
          available: 3,
          capacity: 10,
          segment_id: 1,
        },
        {
          zone_id: 1,
          captured_at: "2026-10-04T18:20:00Z",
          available: 4,
          capacity: 10,
          segment_id: 2,
        },
        {
          zone_id: 1,
          captured_at: "2026-10-04T18:21:00Z",
          available: 5,
          capacity: 10,
          segment_id: 2,
        },
        {
          zone_id: 1,
          captured_at: "2026-10-04T18:31:00Z",
          available: 6,
          capacity: 10,
          segment_id: 3,
        },
      ];
      await route.fulfill({ response, json: data });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
    await page.getByRole("button", { name: "登录青行", exact: true }).click();
    await page.getByRole("button", { name: "运营分析", exact: true }).click();
    const chart = page.getByRole("img", {
      name: "停车区可用车辆库存时间序列",
    });
    await expect(chart).toContainText("10/5 02时");
    await expect(chart.locator("polyline")).toHaveCount(2);
    await expect(chart.locator("circle")).toHaveCount(1);
    await page.getByRole("button", { name: "自定义筛选" }).click();
    await expect(page.getByLabel("开始日期")).toHaveValue("2026-09-29");
    await expect(page.getByLabel("结束日期")).toHaveValue("2026-10-05");
    await page.unrouteAll({ behavior: "wait" });
  });
});

test("Beihang map names landmarks and keeps coordinate picking correct after zoom", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  const map = page.locator(".map-shell");
  await expect(
    map.getByRole("heading", { name: "北京航空航天大学 · 学院路校区" }),
  ).toBeVisible();
  for (const name of [
    "主楼",
    "图书馆",
    "新主楼",
    "合一楼",
    "北航体育馆",
    "航空航天博物馆",
    "绿园",
    "学院路",
    "知春路",
  ]) {
    await expect(
      map.locator("svg text").filter({ hasText: new RegExp(`^${name}$`) }),
    ).toBeVisible();
  }
  await expect(
    map.getByRole("link", { name: "北航官方校区地图" }),
  ).toHaveAttribute("href", "https://www.buaa.edu.cn/xygk/xydt1/xylxq.htm");
  await page.getByRole("button", { name: "骑行与归还", exact: true }).click();
  await page.getByRole("button", { name: "放大地图" }).click();
  const svg = map.locator("svg.campus-svg");
  await svg.scrollIntoViewIfNeeded();
  const point = await svg.evaluate((element) => {
    const svg = element as SVGSVGElement;
    const p = svg.createSVGPoint();
    p.x = 110;
    p.y = 105;
    const screen = p.matrixTransform(svg.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
  await expect(page.getByLabel("归还横坐标（米）")).toHaveValue(/^(109|110)$/);
  await expect(page.getByLabel("归还纵坐标（米）")).toHaveValue(/^(104|105)$/);
  const station = page.getByRole("button", { name: /东门.*可借/ });
  await station.focus();
  await station.press("Space");
  await expect(page.getByLabel("归还横坐标（米）")).toHaveValue(
    /^900(?:\.0+)?$/,
  );
  await expect(page.getByLabel("归还纵坐标（米）")).toHaveValue(
    /^330(?:\.0+)?$/,
  );
});
test("login form validates and demo account opens campus dashboard", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "让校园的每一程，更轻盈。" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校园总览", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "骑行与归还", exact: true }).click();
  await expect(page.getByLabel("归还横坐标（米）")).toBeVisible();
  await page.getByRole("button", { name: "数据库设计", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "数据库设计", exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/trg_payment_guard/)).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "核心关系", exact: true }),
  ).toBeVisible();
});
test("登录和注册期间冻结表单并阻止重复提交，失败后可重试", async ({ page }) => {
  let requests = 0;
  let registrations = 0;
  let release!: () => void;
  let releaseRegistration!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const registrationGate = new Promise<void>(
    (resolve) => (releaseRegistration = resolve),
  );
  await page.route("**/api/auth/me", (route) =>
    route.fulfill({ status: 401, json: { error: "请登录" } }),
  );
  await page.route("**/api/auth/login", async (route) => {
    requests++;
    await gate;
    await route.fulfill({ status: 401, json: { error: "模拟登录失败" } });
  });
  await page.route("**/api/auth/register", async (route) => {
    registrations++;
    await registrationGate;
    await route.fulfill({ status: 409, json: { error: "模拟注册失败" } });
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "学生 · 欧阳晨" }).click();
    await page.getByRole("button", { name: "登录青行", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByLabel("邮箱")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "注册学生账户" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "学生 · 王奕" }),
    ).toBeDisabled();
    await page.locator(".login-form form").dispatchEvent("submit");
    await page.locator(".login-form form").dispatchEvent("submit");
    expect(requests).toBe(1);
    release();
    await expect(page.getByRole("alert")).toContainText("模拟登录失败");
    expect(requests).toBe(1);
    await expect(page.getByLabel("邮箱")).toBeEnabled();
    await expect(
      page.getByRole("button", { name: "注册学生账户" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "注册学生账户" }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByLabel("姓名").fill("测试用户");
    await page.getByLabel("手机号码").fill("13900000001");
    await page.getByRole("button", { name: "注册并进入校园" }).click();
    await expect.poll(() => registrations).toBe(1);
    await expect(page.getByLabel("姓名")).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "登录", exact: true }),
    ).toBeDisabled();
    await page.locator(".login-form form").dispatchEvent("submit");
    await page.locator(".login-form form").dispatchEvent("submit");
    expect(registrations).toBe(1);
    releaseRegistration();
    await expect(page.getByRole("alert")).toContainText("模拟注册失败");
    expect(registrations).toBe(1);
    await expect(page.getByLabel("姓名")).toBeEnabled();
  } finally {
    release();
    releaseRegistration();
  }
});

test("管理员通过表单提交四位精度的碳积分调整", async ({ page }) => {
  const studentLogin = await page.request.post("/api/auth/login", {
    data: { email: "ouyang@qingxing.local", password: "Qingxing2026!" },
  });
  expect(studentLogin.ok()).toBeTruthy();
  const history = await page.request.get("/api/rides?status=PAID");
  expect(history.ok()).toBeTruthy();
  const { rides } = await history.json();
  expect(rides.length).toBeGreaterThan(0);
  await page.request.post("/api/auth/logout");
  await page.goto("/");
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await page.getByLabel("已支付订单 ID").fill(String(rides[0].id));
  await page.getByLabel("积分变动").fill("1");
  await page.getByLabel("减排变动 kg").fill("0.0001");
  await page.getByLabel("调整原因").fill("浏览器精度验证");
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/carbon/adjustments") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "新增调整流水" }).click(),
  ]);
  expect(response.status()).toBe(201);
  expect((await response.json()).duplicate).toBe(false);
});

test("积分调整响应丢失后，刷新页面重试不会重复记账", async ({ page }) => {
  const login = await page.request.post("/api/auth/login", {
    data: { email: "ouyang@qingxing.local", password: "Qingxing2026!" },
  });
  expect(login.ok()).toBeTruthy();
  const history = await page.request.get("/api/rides?status=PAID");
  const { rides } = await history.json();
  expect(rides.length).toBeGreaterThan(0);
  await page.request.post("/api/auth/logout");
  await page.goto("/");
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await page.getByLabel("已支付订单 ID").fill(String(rides[0].id));
  await page.getByLabel("积分变动").fill("1");
  await page.getByLabel("调整原因").fill("浏览器重试验证");

  let firstRequest: any;
  await page.route(
    "**/api/carbon/adjustments",
    async (route) => {
      firstRequest = route.request().postDataJSON();
      const committed = await route.fetch();
      expect(committed.status()).toBe(201);
      expect((await committed.json()).duplicate).toBe(false);
      await route.abort("failed");
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: "新增调整流水" }).click();
  await expect(page.getByRole("button", { name: "重试调整" })).toBeEnabled();
  await page.reload();
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await expect(page.getByLabel("积分变动")).toHaveValue("1");
  await expect(page.getByLabel("积分变动")).toBeDisabled();
  const [response] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/carbon/adjustments") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "重试调整" }).click(),
  ]);
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual(firstRequest);
  expect((await response.json()).duplicate).toBe(true);
  await expect(
    page.getByRole("button", { name: "新增调整流水" }),
  ).toBeDisabled();
  await expect(page.getByLabel("积分变动")).toHaveValue("0");
  await page.getByLabel("积分变动").fill("1");
  const [nextResponse] = await Promise.all([
    page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/carbon/adjustments") &&
        r.request().method() === "POST",
    ),
    page.getByRole("button", { name: "新增调整流水" }).click(),
  ]);
  expect(nextResponse.request().postDataJSON().idempotency_key).not.toBe(
    firstRequest.idempotency_key,
  );
  expect((await nextResponse.json()).duplicate).toBe(false);
  await expect(
    page.getByRole("button", { name: "新增调整流水" }),
  ).toBeDisabled();
  await page.reload();
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await expect(page.getByRole("button", { name: "重试调整" })).toHaveCount(0);
});

test("数据库设计页面打开实体关系图和完整报告", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "学生 · 欧阳晨" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await page.getByRole("button", { name: "数据库设计", exact: true }).click();
  const [diagram] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: "打开完整 E-R 图" }).click(),
  ]);
  await expect(diagram.locator("svg")).toBeVisible();
  const [report] = await Promise.all([
    page.waitForEvent("popup"),
    page.getByRole("link", { name: "查看课程报告" }).click(),
  ]);
  await expect(
    report.getByRole("heading", { name: "dispatch_suggestions", exact: true }),
  ).toBeVisible();
  await expect(
    report.getByRole("heading", { name: "risk_alerts", exact: true }),
  ).toBeVisible();
});

test("student sees personal rides and responsive navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "学生 · 欧阳晨" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校园总览", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "碳积分", exact: true }).click();
  await expect(page.getByText("模拟减排系数 0.21 kg/km")).toBeVisible();
});

test("ride preserves running order outside fence, then returns and pays once", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "学生 · 王奕" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校园总览", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "骑行与归还", exact: true }).click();
  const borrow = page.getByRole("button", { name: "借用自行车 ↗" }).first();
  if (await borrow.isEnabled()) await borrow.click();
  await expect(page.getByText(/正在骑行/).first()).toBeVisible();
  await page.getByLabel("归还横坐标（米）").fill("0");
  await page.getByLabel("归还纵坐标（米）").fill("0");
  await page.getByRole("button", { name: "确认归还", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("OUTSIDE_FENCE");
  await expect(page.getByText(/正在骑行/).first()).toBeVisible();
  await page.getByRole("button", { name: /东门.*可借/ }).click();
  await expect(page.getByLabel("归还横坐标（米）")).toHaveValue(
    /^900(?:\.0+)?$/,
  );
  await expect(page.getByLabel("归还纵坐标（米）")).toHaveValue(
    /^330(?:\.0+)?$/,
  );
  await page.getByRole("button", { name: "确认归还", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "模拟支付", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模拟支付", exact: true }).click();
  await expect(page.getByText("没有待支付订单")).toBeVisible();
  await page.getByRole("button", { name: "骑行订单", exact: true }).click();
  await expect(page.getByText("已支付", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("OUTSIDE_FENCE", { exact: true }).last(),
  ).toBeVisible();
});
test("还车使用实际选点时间并允许重新采集模拟位置", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "学生 · 王奕" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  const oldTime = new Date(Date.now() - 10 * 60_000);
  await page.clock.setFixedTime(oldTime);
  await page.getByRole("button", { name: "骑行与归还", exact: true }).click();
  const capturedLabel = page.getByText(/模拟位置采集于/);
  const previousLabel = await capturedLabel.textContent();
  await page.clock.setFixedTime(new Date());
  const borrow = page.getByRole("button", { name: "借用自行车 ↗" }).first();
  if (await borrow.isEnabled()) {
    await borrow.click();
    await expect(capturedLabel).not.toHaveText(previousLabel!);
  }
  await expect(page.getByText(/正在骑行/).first()).toBeVisible();

  await page.clock.setFixedTime(oldTime);
  await page.getByRole("button", { name: /东门.*可借/ }).click();
  await page.clock.setFixedTime(new Date());
  const [rejected] = await Promise.all([
    page.waitForResponse((response) =>
      /\/api\/rides\/\d+\/return$/.test(response.url()),
    ),
    page.getByRole("button", { name: "确认归还", exact: true }).click(),
  ]);
  expect(rejected.status()).toBe(409);
  expect((await rejected.json()).code).toBe("LOCATION_STALE");
  expect(rejected.request().postDataJSON().captured_at).toBe(
    oldTime.toISOString(),
  );
  await expect(page.getByText(/正在骑行/).first()).toBeVisible();
  const attempts = await page.request.get("/api/return-attempts?scope=own");
  const { attempts: records } = await attempts.json();
  expect(records[0].reason).toBe("LOCATION_STALE");
  expect(new Date(records[0].location_captured_at).toISOString()).toBe(
    oldTime.toISOString(),
  );

  await page.getByRole("button", { name: "重新采集模拟位置" }).click();
  await page.getByRole("button", { name: "确认归还", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "模拟支付", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "模拟支付", exact: true }).click();
  await expect(page.getByText("没有待支付订单")).toBeVisible();
});

test("admin can create and finish maintenance and dispatch tasks", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校园总览", exact: true }),
  ).toBeVisible();
  const dashboard = await page.request.get("/api/dashboard");
  expect(dashboard.ok()).toBeTruthy();
  const bike = (await dashboard.json()).bikes.find(
    (row: any) => row.status === "AVAILABLE",
  );
  expect(bike).toBeTruthy();
  await page.getByRole("button", { name: "维修报修", exact: true }).click();
  await page.getByLabel("车辆", { exact: true }).selectOption(String(bike.id));
  const description = "UI验收：后轮漏气 " + Date.now();
  await page.getByLabel("问题描述").fill(description);
  await page.getByRole("button", { name: "提交报修", exact: true }).click();
  const ticket = page.getByRole("row").filter({ hasText: description });
  await expect(ticket).toBeVisible({ timeout: 15000 });
  await ticket.getByRole("button", { name: "分配", exact: true }).click();
  await page.getByLabel("维修结果").fill("UI验收：已更换内胎，试骑正常");
  await ticket.getByRole("button", { name: "完成维修", exact: true }).click();
  await expect(ticket.getByText("已完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "车辆调度", exact: true }).click();
  await page.getByRole("checkbox").first().check();
  await page
    .getByRole("button", { name: "确认调度 1 辆", exact: true })
    .click();
  const task = page
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: "开始执行", exact: true }),
    })
    .last();
  const taskNumber = await task.getByRole("cell").first().innerText();
  await task.getByRole("button", { name: "开始执行", exact: true }).click();
  const running = page
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: "确认完成", exact: true }),
    })
    .last();
  await running.getByRole("button", { name: "确认完成", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("操作已保存");
  await expect(page.getByText("已完成", { exact: true }).last()).toBeVisible();
  const completedTask = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: taskNumber, exact: true }) });
  await completedTask.getByText("查看库存变化").click();
  await expect(completedTask.getByText("创建后")).toBeVisible();
  await expect(completedTask.getByText("出发后")).toBeVisible();
  await expect(completedTask.getByText("完成后")).toBeVisible();
});

const regressionDashboard = {
  zones: [
    {
      id: 1,
      name: "测试源站",
      location: "测试",
      x: 100,
      y: 100,
      radius: 50,
      capacity: 20,
      status: "ACTIVE",
      available: 2,
      occupied: 2,
      reserved: 0,
    },
    {
      id: 2,
      name: "测试目标站",
      location: "测试",
      x: 200,
      y: 200,
      radius: 50,
      capacity: 20,
      status: "ACTIVE",
      available: 0,
      occupied: 0,
      reserved: 0,
    },
  ],
  bikes: [
    {
      id: 1,
      code: "QX-REGRESSION",
      status: "AVAILABLE",
      current_zone_id: 1,
      zone_name: "测试源站",
      deployed_at: "2026-09-01T00:00:00.000Z",
      last_service_at: null,
    },
  ],
  staff: [
    {
      id: 1,
      user_id: 3,
      name: "测试员工",
      phone: "13800000000",
      email: "operator@test.local",
      job: "BOTH",
      status: "ACTIVE",
    },
  ],
  rides: [],
  actionable_rides: [],
  payments: [],
  dispatches: [],
  tickets: [],
  attempts: [],
  carbon: { points: 0, carbon_kg: 0, distance_m: 0, entries: [] },
  summary: {
    total_bikes: 1,
    available_bikes: 1,
    active_rides: 0,
    today_rides: 0,
    carbon_kg: 0,
    open_tickets: 0,
  },
};

function routeBundle({ nodes, edges, ...details }: any) {
  return {
    nodes,
    edges,
    routes: Object.fromEntries(
      ["shortest", "safe", "comfortable"].map((mode) => [
        mode,
        { ...details, mode },
      ]),
    ),
  };
}

for (const timezoneId of ["UTC", "America/Los_Angeles", "Asia/Shanghai"]) {
  test.describe(`首页日期（${timezoneId}）`, () => {
    test.use({ timezoneId });

    test("北京时间午夜前后显示正确日期", async ({ page }) => {
      await page.route("**/api/**", async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === "/api/auth/me")
          return route.fulfill({
            json: {
              user: {
                id: 1,
                name: "测试管理员",
                email: "admin@test.local",
                role: "ADMIN",
                status: "ACTIVE",
              },
            },
          });
        return route.fulfill({ json: regressionDashboard });
      });
      await page.clock.install({ time: new Date("2026-10-27T15:59:00Z") });
      await page.goto("/");
      await expect(page.locator("header .date")).toHaveText(/10月27日.*星期二/);
      await page.clock.fastForward(60_000);
      await expect(page.locator("header .date")).toHaveText(/10月28日.*星期三/);
      await page.clock.fastForward(3 * 24 * 60 * 60 * 1000);
      await expect(page.locator("header .date")).toHaveText(/10月31日.*星期六/);
      await page.clock.setSystemTime(new Date("2026-10-28T04:00:00Z"));
      await page.evaluate(() =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
      await expect(page.locator("header .date")).toHaveText(/10月28日.*星期三/);
    });
  });
}
test("道路编辑保留两位坡度并允许仅修改通行状态", async ({ page }) => {
  let saved: { slope_percent: number; status: string } | undefined;
  await page.route("**/api/admin/roads", async (route) => {
    if (route.request().method() === "POST") {
      saved = route.request().postDataJSON();
      return route.fulfill({ json: { id: 1 } });
    }
    return route.fulfill({
      json: {
        roads: [
          {
            id: 1,
            from_name: "测试起点",
            to_name: "测试终点",
            direction: "BOTH",
            status: "OPEN",
            slope_percent: 1.23,
            surface: "SMOOTH",
            shade_level: 3,
            lighting_level: 3,
            traffic_mix: "MIXED",
            intersection_risk: 1,
            attribute_source: "MEASURED",
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  const roads = page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "校园路网属性维护" }) });
  const row = roads.getByRole("row").filter({ hasText: "测试起点" });
  await expect(row).toContainText("1.23%");
  await row.getByRole("button", { name: "编辑" }).click();
  await expect(roads.getByLabel("坡度 %")).toHaveValue("1.23");
  await roads.getByLabel("通行状态").selectOption("CLOSED");
  await roads.getByRole("button", { name: "保存路网属性" }).click();
  await expect
    .poll(() => saved)
    .toMatchObject({ slope_percent: 1.23, status: "CLOSED" });
});

test("admin draft survives rejection; edited bike date and blank staff password are normalized", async ({
  page,
}) => {
  const submissions: { path: string; body: any }[] = [];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        status: 200,
        json: {
          user: {
            id: 1,
            name: "测试管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (path === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (path === "/api/admin/users")
      return route.fulfill({ json: { users: [] } });
    const body = route.request().postDataJSON();
    submissions.push({ path, body });
    if (path === "/api/admin/bikes" && body.code === "INVALID-CODE")
      return route.fulfill({
        status: 400,
        json: { error: "测试保存失败", code: "INVALID_INPUT" },
      });
    return route.fulfill({ json: { id: 1 } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await page.getByRole("button", { name: "车辆管理", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "QX-REGRESSION" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.getByLabel("车辆编号").fill("INVALID-CODE");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("测试保存失败");
  await expect(page.getByLabel("车辆编号")).toHaveValue("INVALID-CODE");
  await expect(
    page.getByRole("heading", { name: "编辑 #1", exact: true }),
  ).toBeVisible();
  await page.getByLabel("车辆编号").fill("QX-REGRESSION-EDITED");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "新增资料", exact: true }),
  ).toBeVisible();
  expect(
    submissions.filter((s) => s.path === "/api/admin/bikes").at(-1)?.body,
  ).toMatchObject({
    id: 1,
    code: "QX-REGRESSION-EDITED",
    status: "AVAILABLE",
    deployed_at: "2026-09-01",
  });
  await page.getByRole("button", { name: "员工管理", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "测试员工" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.getByLabel("密码（编辑时可留空）").fill("temporary-password");
  await page.getByLabel("密码（编辑时可留空）").fill("");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "新增资料", exact: true }),
  ).toBeVisible();
  expect(
    submissions.find((s) => s.path === "/api/admin/staff")?.body,
  ).not.toHaveProperty("password");
});
test("pending writes reject duplicate submissions and block conflicting controls", async ({
  page,
}) => {
  let writes = 0;
  let dashboardReads = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (path === "/api/dashboard") {
      dashboardReads++;
      return route.fulfill({ json: regressionDashboard });
    }
    if (path === "/api/admin/users")
      return route.fulfill({ json: { users: [] } });
    if (path === "/api/admin/bikes") {
      writes++;
      await pending;
      return route.fulfill({ json: { id: 1 } });
    }
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto("/");
    await page.getByRole("button", { name: "基础资料", exact: true }).click();
    await page.getByRole("button", { name: "车辆管理", exact: true }).click();
    await page
      .getByRole("row")
      .filter({ hasText: "QX-REGRESSION" })
      .getByRole("button", { name: "编辑", exact: true })
      .click();
    const form = page
      .locator("form")
      .filter({ has: page.getByLabel("车辆编号") });
    await page.getByRole("button", { name: "保存资料", exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator(".page-content")).toHaveAttribute("inert", "");
    await expect(form.locator("input").first()).toBeDisabled();
    await expect(page.getByRole("button", { name: "刷新数据" })).toBeDisabled();
    await form.dispatchEvent("submit");
    await form.dispatchEvent("submit");
    release();
    await expect(
      page.getByRole("status").filter({ hasText: "操作已保存" }),
    ).toBeVisible();
    expect(writes).toBe(1);
    expect(dashboardReads).toBe(2);
    await expect(page.locator(".page-content")).not.toHaveAttribute(
      "inert",
      "",
    );
  } finally {
    release();
  }
});

test("退出期间阻止重复请求和数据刷新，再登录只显示新账户数据", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  const admin = {
    id: 1,
    name: "旧管理员",
    email: "old@test.local",
    role: "ADMIN",
    status: "ACTIVE",
  };
  const student = {
    id: 2,
    name: "新学生",
    email: "new@test.local",
    role: "STUDENT",
    status: "ACTIVE",
  };
  let currentUser = admin;
  let logoutCount = 0;
  let dashboardCount = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({ json: { user: admin } });
    if (path === "/api/auth/logout") {
      logoutCount++;
      await pending;
      return route.fulfill({ json: { ok: true } });
    }
    if (path === "/api/auth/login") {
      currentUser = student;
      return route.fulfill({ json: { user: student } });
    }
    if (path === "/api/dashboard") {
      dashboardCount++;
      return route.fulfill({
        json: {
          ...regressionDashboard,
          zones: regressionDashboard.zones.map((zone) => ({
            ...zone,
            name:
              currentUser.id === 1
                ? `旧账户${zone.name}`
                : `新账户${zone.name}`,
          })),
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  try {
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: /旧账户测试源站/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: "退出登录" }).click();
    await expect.poll(() => logoutCount).toBe(1);
    await expect(page.locator(".sidebar")).toHaveAttribute("inert", "");
    await expect(page.locator(".page-content")).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "刷新数据" })).toBeDisabled();
    await page.locator('button[aria-label="退出登录"]').dispatchEvent("click");
    await page.getByRole("button", { name: "刷新数据" }).dispatchEvent("click");
    release();
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
    expect(logoutCount).toBe(1);
    expect(dashboardCount).toBe(1);
    await page.getByRole("button", { name: "学生 · 欧阳晨" }).click();
    await page.getByRole("button", { name: "登录青行", exact: true }).click();
    await expect(
      page.getByRole("button", { name: /新账户测试源站/ }),
    ).toBeVisible();
    await expect(page.getByText("旧账户测试源站")).toHaveCount(0);
    expect(dashboardCount).toBe(2);
  } finally {
    release();
  }
});

test("退出失败后保留当前账户并允许重试", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1100 });
  let count = 0;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "测试管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (path === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (path === "/api/auth/logout") {
      count++;
      return count === 1
        ? route.fulfill({ status: 503, json: { error: "退出失败" } })
        : route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("alert")).toContainText("退出失败");
  await expect(page.locator(".sidebar")).not.toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  expect(count).toBe(2);
});

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 390, height: 844 },
]) {
  test(`退出登录适配 ${viewport.width}×${viewport.height} 屏幕`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/auth/me")
        return route.fulfill({
          json: {
            user: {
              id: 1,
              name: "测试管理员",
              email: "admin@test.local",
              role: "ADMIN",
              status: "ACTIVE",
            },
          },
        });
      if (path === "/api/dashboard")
        return route.fulfill({ json: regressionDashboard });
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto("/");
    const logout = page.getByRole("button", { name: "退出登录" });
    await expect(logout).toBeInViewport();
    await page
      .getByRole("button", { name: "数据库设计", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(logout).toBeInViewport();
    await logout.click({ timeout: 2000 });
    await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  });
}

test("successful save reports a failed refresh and manual refresh recovers", async ({
  page,
}) => {
  let failRefresh = false;
  let failAfterSave = true;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (path === "/api/dashboard")
      return failRefresh
        ? route.fulfill({
            status: 503,
            json: { error: "测试刷新失败", code: "DATABASE_UNAVAILABLE" },
          })
        : route.fulfill({ json: regressionDashboard });
    if (path === "/api/admin/users")
      return route.fulfill({ json: { users: [] } });
    if (path === "/api/admin/bikes") {
      failRefresh = failAfterSave;
      return route.fulfill({ json: { id: 1 } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await page.getByRole("button", { name: "车辆管理", exact: true }).click();
  await page
    .getByRole("row")
    .filter({ hasText: "QX-REGRESSION" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.getByLabel("车辆编号").fill("QX-SAVED");
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "操作已保存，但页面刷新失败" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toContainText("测试刷新失败");
  await expect(page.getByText("操作已保存，页面已刷新。")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "新增资料", exact: true }),
  ).toBeVisible();
  failRefresh = false;
  await page.getByRole("button", { name: "刷新数据" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByText("操作已保存，但页面刷新失败", { exact: false }),
  ).toHaveCount(0);
  failAfterSave = false;
  await page
    .getByRole("row")
    .filter({ hasText: "QX-REGRESSION" })
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.getByRole("button", { name: "保存资料", exact: true }).click();
  await expect(page.getByText("操作已保存，页面已刷新。")).toBeVisible();
  failRefresh = true;
  await page.getByRole("button", { name: "刷新数据" }).click();
  await expect(page.getByRole("alert")).toContainText("测试刷新失败");
  await expect(page.getByText("操作已保存，页面已刷新。")).toHaveCount(0);
});

test("analytics refetches after suggestion creation and manual refresh while retaining selected period", async ({
  page,
}) => {
  let created = false;
  const analyticsRequests: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "测试管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/analytics/suggestions") {
      created = true;
      return route.fulfill({ json: { suggestions: [{ id: 1 }] } });
    }
    if (url.pathname === "/api/analytics") {
      analyticsRequests.push(url.search);
      return route.fulfill({
        json: {
          hotspots: [],
          hourly: [],
          weekday: [],
          risks: [],
          risk_alerts: [],
          saved_suggestions: [],
          snapshot_count: 0,
          suggestions: created
            ? []
            : [
                {
                  source_zone_id: 1,
                  target_zone_id: 2,
                  source_name: "测试源站",
                  target_name: "测试目标站",
                  quantity: 1,
                  reason: "回归测试调度建议",
                },
              ],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运营分析", exact: true }).click();
  await page.getByLabel("统计周期").selectOption("30");
  await expect(
    page.getByText("回归测试调度建议", { exact: true }),
  ).toBeVisible();
  const before = analyticsRequests.length;
  await page
    .getByRole("button", { name: "生成并保存本次建议", exact: true })
    .click();
  await expect(
    page.getByText("当前没有可执行调度建议", { exact: true }),
  ).toBeVisible();
  expect(analyticsRequests.length).toBeGreaterThan(before);
  await expect(page.getByLabel("统计周期")).toHaveValue("30");
  const after = analyticsRequests.length;
  await page.getByRole("button", { name: "刷新数据", exact: true }).click();
  await expect.poll(() => analyticsRequests.length).toBeGreaterThan(after);
  await expect(page.getByLabel("统计周期")).toHaveValue("30");
  expect(analyticsRequests.at(-1)).toBe("?days=30");
});

test("PDF expansion controls expose traceable workflows", async ({ page }) => {
  const posts: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (route.request().method() === "POST") posts.push(path);
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "测试管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
            leaderboard_alias: "航空蓝骑手",
            leaderboard_visible: false,
          },
        },
      });
    if (path === "/api/dashboard")
      return route.fulfill({
        json: {
          ...regressionDashboard,
          carbon: {
            points: 8,
            carbon_kg: 0.2,
            distance_m: 1000,
            entries: [
              {
                id: 1,
                order_id: 8,
                entry_type: "ADJUSTMENT",
                points: -2,
                carbon_kg: -0.01,
                rule_version: "carbon-v1",
                reason: "人工校正",
                created_at: "2026-10-08T00:00:00Z",
              },
            ],
          },
        },
      });
    if (path === "/api/analytics")
      return route.fulfill({
        json: {
          hotspots: [
            {
              zone_id: 1,
              name: "测试源站",
              borrow_count: 5,
              return_count: 2,
              peak_hour: 8,
              shortage_minutes: 3,
              full_minutes: 0,
              coverage_minutes: 30,
              coverage_ratio: 0.75,
            },
          ],
          hourly: Array.from({ length: 24 }, (_, hour) => ({
            hour,
            borrow_count: hour === 8 ? 5 : 0,
            return_count: hour === 9 ? 2 : 0,
          })),
          weekday: Array.from({ length: 7 }, (_, weekday) => ({
            weekday,
            borrow_count: 0,
            return_count: 0,
          })),
          snapshot_count: 2,
          suggestions: [],
          saved_suggestions: [
            {
              id: 7,
              source_name: "测试源站",
              target_name: "测试目标站",
              quantity: 1,
              borrow_count: 9,
              return_count: 1,
              desired_inventory: 5,
              algorithm_version: "demand-balance-v1",
              status: "OPEN",
            },
          ],
          risks: [],
          risk_alerts: [
            {
              id: 9,
              bike_code: "QX-REGRESSION",
              score: 60,
              level: "HIGH",
              status: "OPEN",
              reasons: JSON.stringify([{ message: "同类故障复发" }]),
            },
          ],
        },
      });
    if (path === "/api/routes") {
      return route.fulfill({
        json: routeBundle({
          distance_m: 400,
          duration_minutes: 2,
          path: [1, 2],
          nodes: [
            { id: 1, name: "主楼", x: 100, y: 100 },
            { id: 2, name: "新主楼", x: 500, y: 100 },
          ],
          edges: [],
          segments: [
            {
              from_node_id: 1,
              to_node_id: 2,
              direction: "BOTH",
              status: "OPEN",
              distance_m: 400,
              slope_percent: 1,
              surface: "SMOOTH",
              traffic_mix: "MIXED",
              shade_level: 4,
              lighting_level: 5,
            },
          ],
          attribute_totals: {
            intersection_risk: 1,
            motor_heavy_edges: 0,
            rough_edges: 0,
            shaded_edges: 1,
          },
          explanation: "避开封闭及禁骑路段",
        }),
      });
    }
    if (path === "/api/leaderboard")
      return route.fulfill({
        json: {
          rows: [],
          me: {
            rank: 2,
            points: 8,
            distance_m: 1000,
            private: true,
          },
        },
      });
    if (path === "/api/admin/users")
      return route.fulfill({ json: { users: [] } });
    if (path === "/api/admin/roads")
      return route.fulfill({
        json: {
          roads: [
            {
              id: 1,
              from_name: "主楼",
              to_name: "新主楼",
              direction: "BOTH",
              status: "OPEN",
              slope_percent: 1,
              surface: "SMOOTH",
              shade_level: 4,
              lighting_level: 5,
              traffic_mix: "MIXED",
              intersection_risk: 1,
              attribute_source: "SIMULATED_COURSE_DATA",
            },
          ],
        },
      });
    if (path === "/api/return-attempts")
      return route.fulfill({
        json: {
          attempts: [
            {
              id: 3,
              order_id: 8,
              bike_code: "QX-REGRESSION",
              zone_name: "测试目标站",
              x: 999,
              y: 999,
              reason: "LOCATION_STALE",
              location_source: "MAP_SIMULATION",
              review_status: "PENDING",
            },
          ],
        },
      });
    if (path === "/api/admin/orders/review")
      return route.fulfill({
        json: {
          orders: [
            {
              id: 8,
              user_name: "测试学生",
              bike_code: "QX-REGRESSION",
              distance_m: 1000,
              qualification_reason: "距离与时长组合异常",
            },
          ],
        },
      });
    return route.fulfill({ json: { id: 1 } });
  });

  await page.goto("/");
  await page.getByRole("button", { name: "运营分析", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "热点分析条件" }),
  ).toBeVisible();
  await expect(page.getByText("demand-balance-v1")).toBeVisible();
  await expect(page.getByText("同类故障复发")).toBeVisible();
  await page.getByRole("button", { name: "复核并创建任务" }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  expect(posts).toContain("/api/dispatches/from-suggestion/7");
  expect(posts).toContain("/api/risks/9/acknowledge");

  await page.getByRole("button", { name: "路线规划", exact: true }).click();
  await expect(page.getByRole("button", { name: /安全优先/ })).toBeVisible();
  await expect(
    page.getByText("避开封闭及禁骑路段", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "碳积分", exact: true }).click();
  await expect(page.getByText("我的排名 #2")).toBeVisible();
  await expect(page.getByText("人工校正")).toBeVisible();

  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校园路网属性维护" }),
  ).toBeVisible();
  await expect(
    page.getByText("LOCATION_STALE", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("距离与时长组合异常")).toBeVisible();
});

test("路线方案共用一次查询并在刷新后同时更新", async ({ page }) => {
  let dashboards = 0;
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/routes") requests++;
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "测试学生",
            email: "student@test.local",
            role: "STUDENT",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard") {
      dashboards++;
      return route.fulfill({ json: regressionDashboard });
    }
    if (url.pathname === "/api/routes") {
      const version = dashboards > 1 ? 400 : 0;
      const nodes = [
        { id: 1, name: "测试源站", x: 100, y: 100 },
        { id: 2, name: "测试目标站", x: 200, y: 200 },
      ];
      const edges = [];
      const detail = (mode: string) => ({
        mode,
        distance_m: (mode === "shortest" ? 400 : 430) + version,
        duration_minutes: 2,
        path: [1, 2],
        segments: [],
        attribute_totals: {
          intersection_risk: 0,
          motor_heavy_edges: 0,
          rough_edges: 0,
          shaded_edges: 0,
        },
        explanation: "演示路线",
      });
      const mode = url.searchParams.get("mode") || "shortest";
      const data =
        mode === "all"
          ? {
              nodes,
              edges,
              routes: Object.fromEntries(
                ["shortest", "safe", "comfortable"].map((name) => [
                  name,
                  detail(name),
                ]),
              ),
            }
          : { nodes, edges, ...detail(mode) };
      return route.fulfill({ json: data });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "路线规划", exact: true }).click();
  const safe = page.getByRole("button", { name: /安全优先/ });
  await expect(safe).toContainText("0.43 km");
  // React StrictMode may run the initial effect twice in development.
  const initialRequests = requests;
  expect(initialRequests).toBeGreaterThanOrEqual(1);
  expect(initialRequests).toBeLessThanOrEqual(2);
  await page.getByRole("button", { name: "刷新数据" }).click();
  await expect(safe).toContainText("0.83 km");
  await expect.poll(() => requests).toBe(initialRequests + 1);
  await safe.click();
  await expect(page.locator(".route-result")).toContainText("0.83 km");
  await page.getByRole("button", { name: /舒适优先/ }).click();
  await expect(page.locator(".route-result")).toContainText("0.83 km");
  expect(requests).toBe(initialRequests + 1);
  await page.getByLabel("目的停车区").selectOption("1");
  await expect.poll(() => requests).toBe(initialRequests + 2);
});

test("路线详情按实际行驶方向展示路段、通行规则和坡度", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "测试学生",
            email: "student@test.local",
            role: "STUDENT",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/routes") {
      const from = Number(url.searchParams.get("from"));
      const to = Number(url.searchParams.get("to"));
      const reverse = from === 2 && to === 1;
      return route.fulfill({
        json: routeBundle({
          distance_m: 400,
          duration_minutes: 2,
          nodes: [
            { id: 1, name: "测试源站", x: 100, y: 100 },
            { id: 2, name: "测试目标站", x: 200, y: 200 },
          ],
          edges: [
            {
              id: 1,
              from_node_id: 1,
              to_node_id: 2,
              direction: "REVERSE",
              status: "OPEN",
            },
          ],
          path: [from, to],
          segments: [
            {
              id: 1,
              from_node_id: from,
              to_node_id: to,
              road_from_node_id: 1,
              road_to_node_id: 2,
              direction: "REVERSE",
              status: "OPEN",
              distance_m: 400,
              slope_percent: reverse ? -2.25 : 2.25,
              surface: "SMOOTH",
              traffic_mix: "MIXED",
              shade_level: 3,
              lighting_level: 3,
            },
          ],
          attribute_totals: {
            intersection_risk: 0,
            motor_heavy_edges: 0,
            rough_edges: 0,
            shaded_edges: 0,
          },
          explanation: "演示路线",
        }),
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "路线规划", exact: true }).click();
  await page.getByLabel("出发停车区").selectOption("2");
  await page.getByLabel("目的停车区").selectOption("1");
  const row = page
    .getByRole("row")
    .filter({ hasText: "测试目标站 → 测试源站" });
  await expect(row).toContainText("单向 / 开放");
  await expect(row).toContainText("400 m / -2.25%");
});

test("maintenance operator can view and acknowledge risk alerts", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { email: "jia@qingxing.local", password: "Qingxing2026!" },
  });
  expect(login.ok()).toBeTruthy();
  const refreshed = await page.request.post("/api/risks/refresh", { data: {} });
  expect(refreshed.ok()).toBeTruthy();
  await page.request.post("/api/auth/logout", { data: {} });
  await page.goto("/");
  await page.getByRole("button", { name: "运营员 · 郑一凡" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await page.getByRole("button", { name: "风险处置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "车辆风险预警与处置" }),
  ).toBeVisible();
  const acknowledge = page
    .getByRole("button", { name: "确认", exact: true })
    .first();
  await expect(acknowledge).toBeVisible();
  await acknowledge.click();
  await expect(
    page.getByRole("status").filter({ hasText: "操作已保存" }),
  ).toBeVisible();
});

test("work pages keep active tasks visible and load older history", async ({
  page,
}) => {
  const ticket = (id: number, status: string) => ({
    id,
    bike_code: `BIKE-${id}`,
    fault_type: "OTHER",
    description: `工单 ${id}`,
    staff_id: 1,
    staff_name: "员工",
    status,
    result: status === "COMPLETED" ? "已处理" : null,
  });
  const dispatch = (id: number, status: string) => ({
    id,
    source_name: "源站",
    target_name: "目标站",
    bike_ids: [1],
    staff_id: 1,
    staff_name: "员工",
    status,
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({
        json: {
          ...regressionDashboard,
          tickets: [ticket(1, "OPEN"), ticket(101, "COMPLETED")],
          tickets_next_before: 101,
          dispatches: [dispatch(1, "PENDING"), dispatch(201, "COMPLETED")],
          dispatches_next_before: 201,
        },
      });
    if (url.pathname === "/api/maintenance") {
      expect(url.searchParams.get("before")).toBe("101");
      return route.fulfill({
        json: { tickets: [ticket(100, "COMPLETED")], next_before: null },
      });
    }
    if (url.pathname === "/api/dispatches") {
      expect(url.searchParams.get("before")).toBe("201");
      return route.fulfill({
        json: { dispatches: [dispatch(200, "COMPLETED")], next_before: null },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "维修报修", exact: true }).click();
  await expect(page.getByText("工单 1", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更早工单" }).click();
  await expect(page.getByText("工单 100", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "车辆调度", exact: true }).click();
  await expect(
    page
      .getByRole("row")
      .filter({ hasText: "#1" })
      .getByRole("button", { name: "开始执行" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "加载更早调度任务" }).click();
  await expect(
    page.getByRole("cell", { name: "#200", exact: true }),
  ).toBeVisible();
});

test("ride history pagination preserves actionable rides, filtering and export", async ({
  page,
}) => {
  const ride = (id: number, status: string) => ({
    id,
    bike_code: `BIKE-${id}`,
    start_zone_name: "源站",
    end_zone_name: "目标站",
    status,
    distance_m: 400,
    amount_cents: 100,
    started_at: "2026-10-27T00:00:00Z",
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 2,
            name: "学生",
            email: "student@test.local",
            role: "STUDENT",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({
        json: {
          ...regressionDashboard,
          rides: [ride(101, "PAID")],
          rides_next_before: 101,
          actionable_rides: [ride(2, "RUNNING"), ride(1, "UNPAID")],
        },
      });
    if (url.pathname === "/api/rides") {
      if (url.searchParams.get("status") === "PAID")
        return route.fulfill({
          json: { rides: [ride(101, "PAID")], next_before: null },
        });
      expect(url.searchParams.get("before")).toBe("101");
      return route.fulfill({
        json: { rides: [ride(100, "PAID")], next_before: null },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "骑行与归还", exact: true }).click();
  await expect(page.getByText(/正在骑行 BIKE-2/)).toBeVisible();
  await expect(page.getByText(/订单 #1/)).toBeVisible();
  await page.getByRole("button", { name: "骑行订单", exact: true }).click();
  await page.getByRole("button", { name: "加载更早订单" }).click();
  await expect(
    page.getByText("#100 · BIKE-100", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("订单状态筛选").selectOption("PAID");
  await expect(
    page.getByText("#101 · BIKE-101", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "导出 CSV" })).toHaveAttribute(
    "href",
    "/api/rides/export.csv?status=PAID",
  );
});

test("carbon history pagination keeps the qualifying ride count", async ({
  page,
}) => {
  const entry = (id: number, type: string) => ({
    id,
    order_id: 42,
    entry_type: type,
    points: 1,
    carbon_kg: 0,
    rule_version: "carbon-v1",
    reason: `流水 ${id}`,
    created_at: "2026-10-27T00:00:00Z",
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 2,
            name: "学生",
            email: "student@test.local",
            role: "STUDENT",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({
        json: {
          ...regressionDashboard,
          carbon: {
            points: 11,
            carbon_kg: 0.21,
            distance_m: 1000,
            ride_count: 1,
            rule: {
              kg_per_km: "999999999999.99999999",
              points_per_km: "0.00000001",
              rule_version: "测试版",
            },
            entries: [entry(101, "ADJUSTMENT"), entry(100, "AWARD")],
            entries_next_before: 100,
          },
        },
      });
    if (url.pathname === "/api/carbon/entries") {
      expect(url.searchParams.get("before")).toBe("100");
      return route.fulfill({
        json: { entries: [entry(99, "ADJUSTMENT")], next_before: null },
      });
    }
    if (url.pathname === "/api/leaderboard")
      return route.fulfill({ json: { rows: [], me: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "碳积分", exact: true }).click();
  await expect(
    page.getByText(
      "当前模拟减排系数 999999999999.99999999 kg/km · 每公里 0.00000001 分 · 测试版",
    ),
  ).toBeVisible();
  const count = page.locator(".stat").filter({ hasText: "绿色行程" });
  await expect(count.locator("strong")).toHaveText("1");
  await page.getByRole("button", { name: "加载更早积分流水" }).click();
  await expect(page.getByText("流水 99", { exact: true })).toBeVisible();
  await expect(count.locator("strong")).toHaveText("1");
  await expect(
    page.getByRole("button", { name: "加载更早积分流水" }),
  ).toHaveCount(0);
});

test("administrator and operator can load older risk alerts", async ({
  page,
}) => {
  let role = "ADMIN";
  const risk = (id: number) => ({
    id,
    bike_code: `BIKE-${id}`,
    score: 30,
    level: "MEDIUM",
    status: "OPEN",
    reasons: [],
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "测试用户",
            email: "test@test.local",
            role,
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/risks") {
      if (url.searchParams.has("before")) {
        expect(url.searchParams.get("before")).toBe("101");
        return route.fulfill({
          json: { risks: [risk(100)], next_before: null },
        });
      }
      return route.fulfill({ json: { risks: [risk(101)], next_before: 101 } });
    }
    if (url.pathname === "/api/analytics")
      return route.fulfill({
        json: {
          hotspots: [],
          hourly: [],
          weekday: [],
          risks: [],
          risk_alerts: [risk(101)],
          risk_alerts_next_before: 101,
          inventory_series: [],
          snapshot_count: 0,
          suggestions: [],
          saved_suggestions: [],
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运营分析", exact: true }).click();
  await expect(page.getByLabel("风险 101 处置说明")).toBeVisible();
  await page.getByRole("button", { name: "加载更早风险记录" }).click();
  await expect(page.getByLabel("风险 100 处置说明")).toBeVisible();
  role = "OPERATOR";
  await page.reload();
  await page.getByRole("button", { name: "风险处置", exact: true }).click();
  await expect(page.getByLabel("风险 101 处置说明")).toBeVisible();
  await page.getByRole("button", { name: "加载更早风险记录" }).click();
  await expect(page.getByLabel("风险 100 处置说明")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "加载更早风险记录" }),
  ).toHaveCount(0);
});

test("reviewing an older risk keeps the loaded boundary when new alerts arrive", async ({
  page,
}) => {
  let resolved = false;
  const records = () =>
    (resolved
      ? [105, 104, 103, 102, 101, 100, 99]
      : [104, 103, 102, 101, 100, 99]
    ).map((id) => ({
      id,
      bike_code: `BIKE-${id}`,
      score: 30,
      level: "MEDIUM",
      status: id === 101 && resolved ? "RESOLVED" : "OPEN",
      reasons: [],
    }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 3,
            name: "运维员",
            email: "operator@test.local",
            role: "OPERATOR",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/risks/101/resolve") {
      resolved = true;
      return route.fulfill({ json: { id: 101, status: "RESOLVED" } });
    }
    if (url.pathname === "/api/risks") {
      const before = Number(url.searchParams.get("before") || Infinity);
      const all = records().filter((r) => r.id < before);
      const risks = all.slice(0, 2);
      return route.fulfill({
        json: { risks, next_before: all.length > 2 ? risks.at(-1)?.id : null },
      });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "风险处置", exact: true }).click();
  await page.getByRole("button", { name: "加载更早风险记录" }).click();
  const oldRow = page.getByRole("row").filter({ hasText: "BIKE-101" });
  await expect(oldRow).toBeVisible();
  await oldRow.getByRole("button", { name: "解决", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "BIKE-105" }),
  ).toBeVisible();
  await expect(oldRow).toContainText("已结束");
  await expect(
    page.getByRole("row").filter({ hasText: "BIKE-100" }),
  ).toBeVisible();
  for (const id of [105, 104, 103, 102, 101, 100])
    await expect(
      page.getByRole("row").filter({ hasText: `BIKE-${id}` }),
    ).toHaveCount(1);
});

test("复核较早订单后保留已加载范围并显示新订单", async ({ page }) => {
  let reviewed = false;
  const orders = () =>
    (reviewed ? [105, 104, 103, 102, 100] : [104, 103, 102, 101, 100]).map(
      (id) => ({
        id,
        user_name: `用户${id}`,
        bike_code: `BIKE-${id}`,
        distance_m: 1000,
        qualification_reason: "待复核",
      }),
    );
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/orders/101/qualification") {
      reviewed = true;
      return route.fulfill({
        json: { id: 101, qualification_status: "VALID" },
      });
    }
    if (url.pathname === "/api/admin/orders/review") {
      const before = Number(url.searchParams.get("before") || Infinity);
      const all = orders().filter((row) => row.id < before);
      const pageRows = all.slice(0, 2);
      return route.fulfill({
        json: {
          orders: pageRows,
          next_before: all.length > 2 ? pageRows.at(-1)?.id : null,
        },
      });
    }
    if (url.pathname === "/api/admin/users")
      return route.fulfill({ json: { users: [] } });
    if (url.pathname === "/api/admin/roads")
      return route.fulfill({ json: { roads: [] } });
    if (url.pathname === "/api/return-attempts")
      return route.fulfill({ json: { attempts: [], next_before: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await page.getByRole("button", { name: "加载更早待复核订单" }).click();
  const oldRow = page.getByRole("row").filter({ hasText: "BIKE-101" });
  await expect(oldRow).toBeVisible();
  await oldRow.getByRole("button", { name: "确认有效" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "BIKE-105" }),
  ).toBeVisible();
  await expect(oldRow).toHaveCount(0);
  for (const id of [105, 104, 103, 102, 100])
    await expect(
      page.getByRole("row").filter({ hasText: `BIKE-${id}` }),
    ).toHaveCount(1);
});

for (const [description, remaining] of [
  ["仍有更早页", [103, 101, 100]],
  ["缩短到一页", [103]],
] as const) {
  test(`连续刷新中复核队列先缩短再增长时保留已加载范围：${description}`, async ({
    page,
  }) => {
    let phase = 0;
    const ids = () =>
      phase === 0
        ? [105, 104, 103, 102, 101, 100]
        : phase === 1
          ? remaining
          : [107, 106, ...remaining];
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/auth/me")
        return route.fulfill({
          json: {
            user: {
              id: 1,
              name: "管理员",
              email: "admin@test.local",
              role: "ADMIN",
              status: "ACTIVE",
            },
          },
        });
      if (url.pathname === "/api/dashboard")
        return route.fulfill({ json: regressionDashboard });
      if (url.pathname === "/api/orders/102/qualification") {
        phase = 1;
        return route.fulfill({
          json: { id: 102, qualification_status: "VALID" },
        });
      }
      if (url.pathname === "/api/admin/users/200/status") {
        phase = 2;
        return route.fulfill({ json: { ok: true } });
      }
      if (url.pathname === "/api/admin/orders/review") {
        const before = Number(url.searchParams.get("before") || Infinity);
        const all = ids().filter((id) => id < before);
        const orders = all.slice(0, 2).map((id) => ({
          id,
          user_name: `用户${id}`,
          bike_code: `BIKE-${id}`,
          distance_m: 1000,
          qualification_reason: "待复核",
        }));
        return route.fulfill({
          json: {
            orders,
            next_before: all.length > 2 ? orders.at(-1)?.id : null,
          },
        });
      }
      if (url.pathname === "/api/admin/users")
        return route.fulfill({
          json: {
            users: [
              {
                id: 200,
                name: "待管理账户",
                email: "managed@example.test",
                role: "STUDENT",
                status: phase === 2 ? "SUSPENDED" : "ACTIVE",
              },
            ],
            next_before: null,
          },
        });
      if (url.pathname === "/api/admin/roads")
        return route.fulfill({ json: { roads: [] } });
      if (url.pathname === "/api/return-attempts")
        return route.fulfill({ json: { attempts: [], next_before: null } });
      return route.fulfill({ json: {} });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "基础资料", exact: true }).click();
    await page.getByRole("button", { name: "加载更早待复核订单" }).click();
    await page
      .getByRole("row")
      .filter({ hasText: "BIKE-102" })
      .getByRole("button", { name: "确认有效" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: "BIKE-102" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("row").filter({ hasText: "BIKE-103" }),
    ).toBeVisible();
    await page
      .getByRole("row")
      .filter({ hasText: "managed@example.test" })
      .getByRole("button", { name: "停用" })
      .click();
    await expect(
      page.getByRole("row").filter({ hasText: "BIKE-107" }),
    ).toBeVisible();
    await expect(
      page.getByRole("row").filter({ hasText: "BIKE-103" }),
    ).toBeVisible();
  });
}

test("管理较早账户后保留已加载范围并显示新账户", async ({ page }) => {
  let suspended = false;
  const users = () =>
    (suspended
      ? [106, 105, 104, 103, 102, 101]
      : [105, 104, 103, 102, 101]
    ).map((id) => ({
      id,
      name: `账户${id}`,
      email: `user${id}@example.test`,
      role: "STUDENT",
      status: id === 102 && suspended ? "SUSPENDED" : "ACTIVE",
    }));
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/admin/users/102/status") {
      suspended = true;
      return route.fulfill({ json: { ok: true } });
    }
    if (url.pathname === "/api/admin/users") {
      const before = Number(url.searchParams.get("before") || Infinity);
      const all = users().filter((row) => row.id < before);
      const rows = all.slice(0, 2);
      return route.fulfill({
        json: {
          users: rows,
          next_before: all.length > 2 ? rows.at(-1)?.id : null,
        },
      });
    }
    if (url.pathname === "/api/admin/roads")
      return route.fulfill({ json: { roads: [] } });
    if (url.pathname === "/api/return-attempts")
      return route.fulfill({ json: { attempts: [], next_before: null } });
    if (url.pathname === "/api/admin/orders/review")
      return route.fulfill({ json: { orders: [], next_before: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await page.getByRole("button", { name: "加载更早账户" }).click();
  const oldRow = page
    .getByRole("row")
    .filter({ hasText: "user102@example.test" });
  await expect(oldRow).toBeVisible();
  await oldRow.getByRole("button", { name: "停用" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "user106@example.test" }),
  ).toBeVisible();
  await expect(oldRow.getByRole("button", { name: "启用" })).toBeVisible();
  for (const id of [106, 105, 104, 103, 102, 101])
    await expect(
      page.getByRole("row").filter({ hasText: `user${id}@example.test` }),
    ).toHaveCount(1);
});

test("personal and administrator return histories load older records", async ({
  page,
}) => {
  let resolved = false;
  const attempt = (id: number, orderId: number) => ({
    id,
    order_id: orderId,
    bike_code: "TEST",
    zone_name: "源站",
    x: 10,
    y: 20,
    reason: "OUTSIDE_FENCE",
    location_source: "MAP_SIMULATION",
    review_status: id === 200 && resolved ? "RESOLVED" : "PENDING",
    review_note: id === 200 && resolved ? "复核已完成" : null,
    created_at: "2026-10-27T00:00:00Z",
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({
        json: {
          ...regressionDashboard,
          attempts: [attempt(101, 501)],
          attempts_next_before: 101,
        },
      });
    if (url.pathname === "/api/returns/200/review") {
      resolved = true;
      return route.fulfill({ json: { id: 200, review_status: "RESOLVED" } });
    }
    if (url.pathname === "/api/return-attempts") {
      if (url.searchParams.get("scope") === "own") {
        expect(url.searchParams.get("before")).toBe("101");
        return route.fulfill({
          json: { attempts: [attempt(100, 500)], next_before: null },
        });
      }
      if (url.searchParams.has("before")) {
        expect(url.searchParams.get("scope")).toBe("all");
        expect(url.searchParams.get("before")).toBe("201");
        return route.fulfill({
          json: { attempts: [attempt(200, 800)], next_before: null },
        });
      }
      return route.fulfill({
        json: { attempts: [attempt(201, 801)], next_before: 201 },
      });
    }
    if (url.pathname === "/api/admin/users")
      return route.fulfill({ json: { users: [] } });
    if (url.pathname === "/api/admin/roads")
      return route.fulfill({ json: { roads: [] } });
    if (url.pathname === "/api/admin/orders/review")
      return route.fulfill({ json: { orders: [] } });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "骑行订单", exact: true }).click();
  await expect(page.getByText("#501", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更早归还记录" }).click();
  await expect(page.getByText("#500", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "基础资料", exact: true }).click();
  await expect(page.getByText("#801 · TEST", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "加载更早归还记录" }).click();
  await expect(page.getByText("#800 · TEST", { exact: true })).toBeVisible();
  const oldRow = page.getByRole("row").filter({ hasText: "#800 · TEST" });
  await oldRow.getByRole("button", { name: "标记已处理" }).click();
  await expect(oldRow).toContainText("复核已完成");
  await expect(
    page.getByRole("button", { name: "加载更早归还记录" }),
  ).toHaveCount(0);
});

test("administrator can load older saved dispatch suggestions", async ({
  page,
}) => {
  const suggestion = (id: number) => ({
    id,
    source_name: "源站",
    target_name: "目标站",
    quantity: 1,
    borrow_count: 1,
    return_count: 0,
    desired_inventory: 4,
    algorithm_version: "demand-balance-v1",
    status: "OPEN",
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 1,
            name: "管理员",
            email: "admin@test.local",
            role: "ADMIN",
            status: "ACTIVE",
          },
        },
      });
    if (url.pathname === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (url.pathname === "/api/analytics/suggestions") {
      expect(url.searchParams.get("before")).toBe("101");
      return route.fulfill({
        json: { suggestions: [suggestion(100)], next_before: null },
      });
    }
    if (url.pathname === "/api/analytics")
      return route.fulfill({
        json: {
          hotspots: [],
          hourly: [],
          weekday: [],
          risks: [],
          risk_alerts: [],
          inventory_series: [],
          snapshot_count: 0,
          suggestions: [],
          saved_suggestions: [suggestion(101)],
          saved_suggestions_next_before: 101,
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "运营分析", exact: true }).click();
  await expect(page.getByLabel("建议 101 不执行原因")).toBeVisible();
  await page.getByRole("button", { name: "加载更早建议" }).click();
  await expect(page.getByLabel("建议 100 不执行原因")).toBeVisible();
  await expect(page.getByRole("button", { name: "加载更早建议" })).toHaveCount(
    0,
  );
});

test("administrator records why a dispatch suggestion is dismissed", async ({
  page,
}) => {
  const login = await page.request.post("/api/auth/login", {
    data: { email: "jia@qingxing.local", password: "Qingxing2026!" },
  });
  expect(login.ok()).toBeTruthy();
  const response = await page.request.post("/api/analytics/suggestions", {
    data: { days: 7 },
  });
  expect(response.ok()).toBeTruthy();
  const { suggestions } = await response.json();
  expect(suggestions.length).toBeGreaterThan(0);
  const id = suggestions[0].id;
  await page.goto("/");
  await page.getByRole("button", { name: "运营分析", exact: true }).click();
  const note = page.getByLabel(`建议 ${id} 不执行原因`);
  const reason = `现场库存已恢复，无需调度（建议 ${id}）`;
  await note.fill(reason);
  const row = page.getByRole("row").filter({ has: note });
  await row.getByRole("button", { name: "不执行", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("操作已保存");
  await expect(
    page.getByRole("cell", { name: reason, exact: true }),
  ).toBeVisible();
});

test("a new rider sees an unranked private summary", async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/me")
      return route.fulfill({
        json: {
          user: {
            id: 2,
            name: "新骑行者",
            email: "new@example.test",
            role: "STUDENT",
            status: "ACTIVE",
            leaderboard_alias: "新骑行者",
            leaderboard_visible: false,
          },
        },
      });
    if (path === "/api/dashboard")
      return route.fulfill({ json: regressionDashboard });
    if (path === "/api/leaderboard")
      return route.fulfill({
        json: {
          rows: [],
          me: { rank: null, points: 0, distance_m: 0, rides: 0, private: true },
        },
      });
    return route.fulfill({ json: {} });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "碳积分", exact: true }).click();
  await expect(page.getByText("暂无排名", { exact: true })).toBeVisible();
  await expect(page.getByText("仅自己可见", { exact: true })).toBeVisible();
  await expect(page.getByText("我的排名 #null")).toHaveCount(0);
});
