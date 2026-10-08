import { test, expect } from "@playwright/test";

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
test("admin can create and finish maintenance and dispatch tasks", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "管理员 · 贾鑫洋" }).click();
  await page.getByRole("button", { name: "登录青行", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "校园总览", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "维修报修", exact: true }).click();
  await page.getByLabel("车辆", { exact: true }).selectOption({ index: 1 });
  const description = "UI验收：后轮漏气 " + Date.now();
  await page.getByLabel("问题描述").fill(description);
  await page.getByRole("button", { name: "提交报修", exact: true }).click();
  const ticket = page.getByRole("row").filter({ hasText: description });
  await expect(ticket).toBeVisible();
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
      const mode = url.searchParams.get("mode") || "shortest";
      return route.fulfill({
        json: {
          mode,
          distance_m: mode === "shortest" ? 400 : 430,
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
        },
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
