import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AppError } from "./db.mjs";
import { authenticate, login, register, issueCookie, logout } from "./auth.mjs";
import {
  startRide,
  returnRide,
  payRide,
  reportFault,
  maintenanceAction,
  createDispatch,
  dispatchAction,
  routeForZones,
  requireAdmin,
  idSchema,
} from "./business.mjs";
import { saveZone, saveBike, saveStaff, setUserStatus } from "./admin.mjs";
import { dashboard, analytics, leaderboard } from "./read-model.mjs";
import { schemaInfo } from "./schema-info.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
export function createApp(pool) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          "upgrade-insecure-requests": null,
          "connect-src": ["'self'"],
          "img-src": ["'self'", "data:"],
          "style-src": ["'self'", "'unsafe-inline'"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "24kb" }), cookieParser());
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const allowed = new Set([
        "http://" + req.get("host"),
        "http://127.0.0.1:5189",
        "http://localhost:5189",
      ]);
      if (
        (req.get("origin") && !allowed.has(req.get("origin"))) ||
        req.get("sec-fetch-site") === "cross-site"
      )
        return res
          .status(403)
          .json({ error: "请求来源无效", code: "INVALID_ORIGIN" });
    }
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({
      status: "ok",
      system: "campus-bike",
      database: "MySQL 8.0",
      mode: "simulation",
    });
  });
  const limiter = rateLimit({
    windowMs: 900000,
    limit: 80,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "登录尝试过多，请稍后重试", code: "RATE_LIMITED" },
  });
  app.post("/api/auth/login", limiter, async (req, res) => {
    const user = await login(pool, req.body);
    issueCookie(res, user);
    res.json({ user });
  });
  app.post("/api/auth/register", limiter, async (req, res) => {
    const user = await register(pool, req.body);
    issueCookie(res, user);
    res.status(201).json({ user });
  });
  app.post("/api/auth/logout", (_req, res) => {
    logout(res);
    res.json({ ok: true });
  });
  app.use("/api", authenticate(pool));
  app.get("/api/auth/me", (req, res) => res.json({ user: req.user }));
  app.get("/api/dashboard", async (req, res) =>
    res.json(await dashboard(pool, req.user)),
  );
  app.post("/api/rides/start", async (req, res) =>
    res.status(201).json(await startRide(pool, req.user, req.body)),
  );
  app.post("/api/rides/:id/return", async (req, res) =>
    res.json(await returnRide(pool, req.user, req.params.id, req.body)),
  );
  app.post("/api/rides/:id/pay", async (req, res) =>
    res.json(await payRide(pool, req.user, req.params.id, req.body)),
  );
  app.post("/api/maintenance", async (req, res) =>
    res.status(201).json(await reportFault(pool, req.user, req.body)),
  );
  app.post("/api/maintenance/:id/:action", async (req, res) =>
    res.json(
      await maintenanceAction(
        pool,
        req.user,
        req.params.id,
        req.params.action,
        req.body,
      ),
    ),
  );
  app.post("/api/dispatches", async (req, res) =>
    res.status(201).json(await createDispatch(pool, req.user, req.body)),
  );
  app.post("/api/dispatches/:id/:action", async (req, res) =>
    res.json(
      await dispatchAction(
        pool,
        req.user,
        req.params.id,
        req.params.action,
        req.body,
      ),
    ),
  );
  app.post("/api/admin/zones", async (req, res) =>
    res.json(await saveZone(pool, req.user, req.body)),
  );
  app.post("/api/admin/bikes", async (req, res) =>
    res.json(await saveBike(pool, req.user, req.body)),
  );
  app.post("/api/admin/staff", async (req, res) =>
    res.json(await saveStaff(pool, req.user, req.body)),
  );
  app.post("/api/admin/users/:id/status", async (req, res) =>
    res.json(await setUserStatus(pool, req.user, req.params.id, req.body)),
  );
  app.get("/api/admin/users", async (req, res) => {
    requireAdmin(req.user);
    const [users] = await pool.query(
      "SELECT id,name,email,phone,role,status,created_at FROM users ORDER BY id",
    );
    res.json({ users });
  });
  app.get("/api/analytics", async (req, res) =>
    res.json(
      await analytics(
        pool,
        Number(z.enum(["7", "30"]).default("7").parse(req.query.days)),
      ),
    ),
  );
  app.get("/api/routes", async (req, res) => {
    const mode = z
      .enum(["shortest", "safe", "comfortable"])
      .default("shortest")
      .parse(req.query.mode);
    res.json(
      await routeForZones(
        pool,
        idSchema.parse(req.query.from),
        idSchema.parse(req.query.to),
        mode,
      ),
    );
  });
  app.get("/api/leaderboard", async (req, res) =>
    res.json(
      await leaderboard(
        pool,
        z.enum(["week", "month"]).default("week").parse(req.query.period),
        z
          .enum(["points", "distance", "rides"])
          .default("points")
          .parse(req.query.metric),
      ),
    ),
  );
  app.get("/api/schema", async (_req, res) => res.json(await schemaInfo(pool)));
  app.get("/api/report", (_req, res) =>
    res.sendFile(path.join(root, "docs", "数据库课程设计报告.html")),
  );
  app.use("/api", (_req, res) =>
    res.status(404).json({ error: "接口不存在", code: "NOT_FOUND" }),
  );
  app.get("/docs/ER图.svg", (_req, res) =>
    res.sendFile(path.join(root, "docs", "ER图.svg")),
  );
  app.get("/docs/数据库课程设计报告.html", (_req, res) =>
    res.sendFile(path.join(root, "docs", "数据库课程设计报告.html")),
  );
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
  app.use((e, _req, res, _next) => {
    if (e instanceof z.ZodError)
      return res.status(400).json({
        error:
          "输入格式不正确：" +
          e.issues
            .map((i) => i.path.join(".") + " " + i.message)
            .slice(0, 3)
            .join("；"),
        code: "INVALID_INPUT",
      });
    if (e instanceof AppError)
      return res.status(e.status).json({ error: e.message, code: e.code });
    if (e.type === "entity.parse.failed")
      return res
        .status(400)
        .json({ error: "请求不是有效 JSON", code: "INVALID_JSON" });
    if (e.type === "entity.too.large")
      return res
        .status(413)
        .json({ error: "请求内容过大", code: "PAYLOAD_TOO_LARGE" });
    if (e.code === "ER_DUP_ENTRY")
      return res.status(409).json({
        error: "记录已存在或此业务正在处理中，请刷新后重试",
        code: "DUPLICATE",
      });
    if (
      [
        "ER_NO_REFERENCED_ROW_2",
        "ER_CHECK_CONSTRAINT_VIOLATED",
        "ER_SIGNAL_EXCEPTION",
      ].includes(e.code)
    )
      return res
        .status(409)
        .json({ error: "该操作不满足数据完整性约束", code: "CONSTRAINT" });
    console.error("[api]", e.code || e.name, e.message);
    res
      .status(500)
      .json({ error: "服务暂时不可用，请稍后重试", code: "INTERNAL_ERROR" });
  });
  return app;
}
