import { sql } from "./sql-statements.mjs";
import express from "express";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppError,
  errorCodes,
  readSnapshot,
  translateDatabaseError,
} from "./db.mjs";
import { authenticate, login, register, issueCookie, logout } from "./auth.mjs";
import {
  startRide,
  returnRide,
  payRide,
  reportFault,
  maintenanceAction,
  createDispatch,
  dispatchAction,
  routeGraph,
  routesForGraph,
  requireAdmin,
} from "./business.mjs";
import { idSchema } from "./validation.mjs";
import { saveZone, saveBike, saveStaff, setUserStatus } from "./admin.mjs";
import { dashboard, analytics, leaderboard } from "./read-model.mjs";
import {
  reportFilterSchema,
  createDispatchSuggestions,
  listDispatchSuggestions,
  confirmDispatchSuggestion,
  dismissDispatchSuggestion,
} from "./operations.mjs";
import { refreshRiskAlerts, actOnRisk, listRiskAlerts } from "./risks.mjs";
import { saveRoad } from "./roads.mjs";
import { reviewReturnAttempt, listReturnAttempts } from "./returns.mjs";
import {
  reviewOrderQualification,
  adjustCarbon,
  listCarbonEntries,
} from "./carbon.mjs";
import { updateLeaderboardProfile } from "./profile.mjs";
import {
  rideHistory,
  paymentHistory,
  exportRides,
  dispatchHistory,
  ticketHistory,
} from "./history.mjs";
import { schemaInfo } from "./schema-info.mjs";
import { pageById } from "./pagination.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const publicDocuments = new Set(["ER图.svg", "数据库课程设计报告.html"]);
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
      if (
        (req.get("origin") &&
          req.get("origin") !== "http://" + req.get("host")) ||
        req.get("sec-fetch-site") === "cross-site"
      )
        return res
          .status(403)
          .json({ error: "请求来源无效", code: "INVALID_ORIGIN" });
    }
    next();
  });
  app.get("/api/health", async (_req, res) => {
    await pool.query(sql("health"));
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
  const rideFilter = z
    .enum(["ALL", "RUNNING", "UNPAID", "PAID"])
    .default("ALL");
  app.get("/api/rides", async (req, res) => {
    const { before, status } = z
      .object({ before: idSchema.optional(), status: rideFilter })
      .parse(req.query);
    res.json(await rideHistory(pool, req.user, status, before));
  });
  app.get("/api/rides/export.csv", async (req, res) => {
    const { status } = z.object({ status: rideFilter }).parse(req.query);
    await exportRides(pool, req.user, status, res);
  });
  app.get("/api/payments", async (req, res) => {
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    res.json(await paymentHistory(pool, req.user, before));
  });
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
  app.get("/api/maintenance", async (req, res) => {
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    res.json(await ticketHistory(pool, req.user, before));
  });
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
  app.get("/api/dispatches", async (req, res) => {
    if (req.user.role === "STUDENT")
      throw new AppError("没有调度查看权限", "FORBIDDEN", 403);
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    res.json(await dispatchHistory(pool, before));
  });
  app.post("/api/dispatches/from-suggestion/:id", async (req, res) =>
    res
      .status(201)
      .json(
        await confirmDispatchSuggestion(
          pool,
          req.user,
          req.params.id,
          req.body?.staff_id,
        ),
      ),
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
  app.get("/api/admin/roads", async (req, res) => {
    requireAdmin(req.user);
    const [roads] = await pool.query(sql("admin_roads"));
    res.json({ roads });
  });
  app.post("/api/admin/roads", async (req, res) =>
    res.json(await saveRoad(pool, req.user, req.body)),
  );
  app.get("/api/admin/orders/review", async (req, res) => {
    requireAdmin(req.user);
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    const [orders] = await pool.query(sql("admin_review_orders"), [
      before ?? null,
      before ?? null,
    ]);
    res.json(pageById(orders, "orders"));
  });
  app.get("/api/admin/users", async (req, res) => {
    requireAdmin(req.user);
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    const [users] = await pool.query(sql("admin_users"), [
      before ?? null,
      before ?? null,
    ]);
    res.json(pageById(users, "users"));
  });
  app.get("/api/analytics", async (req, res) => {
    requireAdmin(req.user);
    res.json(await analytics(pool, reportFilterSchema.parse(req.query)));
  });
  app.post("/api/analytics/suggestions", async (req, res) =>
    res
      .status(201)
      .json(await createDispatchSuggestions(pool, req.user, req.body)),
  );
  app.post("/api/analytics/suggestions/:id/dismiss", async (req, res) =>
    res.json(
      await dismissDispatchSuggestion(pool, req.user, req.params.id, req.body),
    ),
  );
  app.get("/api/analytics/suggestions", async (req, res) => {
    requireAdmin(req.user);
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    res.json(await listDispatchSuggestions(pool, before));
  });
  app.post("/api/risks/refresh", async (req, res) =>
    res.json(await refreshRiskAlerts(pool, req.user)),
  );
  app.get("/api/risks", async (req, res) => {
    if (req.user.role === "STUDENT")
      throw new AppError("没有风险查看权限", "FORBIDDEN", 403);
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    res.json(await listRiskAlerts(pool, before));
  });
  app.post("/api/risks/:id/:action", async (req, res) =>
    res.json(
      await actOnRisk(
        pool,
        req.user,
        req.params.id,
        req.params.action,
        req.body,
      ),
    ),
  );
  app.get("/api/return-attempts", async (req, res) => {
    const { before, scope } = z
      .object({
        before: idSchema.optional(),
        scope: z.enum(["own", "all"]).optional(),
      })
      .parse(req.query);
    res.json(await listReturnAttempts(pool, req.user, before, scope));
  });
  app.post("/api/returns/:id/review", async (req, res) =>
    res.json(
      await reviewReturnAttempt(pool, req.user, req.params.id, req.body),
    ),
  );
  app.post("/api/orders/:id/qualification", async (req, res) =>
    res.json(
      await reviewOrderQualification(pool, req.user, req.params.id, req.body),
    ),
  );
  app.post("/api/carbon/adjustments", async (req, res) =>
    res.status(201).json(await adjustCarbon(pool, req.user, req.body)),
  );
  app.get("/api/carbon/entries", async (req, res) => {
    const { before } = z
      .object({ before: idSchema.optional() })
      .parse(req.query);
    res.json(await listCarbonEntries(pool, req.user, before));
  });
  app.post("/api/profile/leaderboard", async (req, res) =>
    res.json(await updateLeaderboardProfile(pool, req.user, req.body)),
  );
  app.get("/api/road-graph", async (_req, res) => {
    const [nodes, edges] = await readSnapshot(pool, routeGraph);
    res.json({ nodes, edges });
  });
  app.get("/api/routes", async (req, res) => {
    const mode = z
      .enum(["shortest", "safe", "comfortable", "all"])
      .default("shortest")
      .parse(req.query.mode);
    const from = idSchema.parse(req.query.from);
    const to = idSchema.parse(req.query.to);
    const graph = await readSnapshot(pool, routeGraph);
    res.json(routesForGraph(graph, from, to, mode));
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
        req.user.id,
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
  app.get("/docs/:document", (req, res, next) => {
    if (!publicDocuments.has(req.params.document)) return next();
    res.sendFile(path.join(root, "docs", req.params.document));
  });
  app.use("/docs", (_req, res) => res.status(404).send("文件不存在"));
  app.use(
    express.static(path.join(root, "dist"), {
      setHeaders(res, filename) {
        if (
          path.dirname(filename) === path.join(root, "dist", "assets") &&
          /-[A-Za-z0-9_-]{8}\.[A-Za-z0-9]+$/.test(path.basename(filename))
        )
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist", "index.html")),
  );
  app.use((e, _req, res, next) => {
    if (res.headersSent) return next(e);
    e = translateDatabaseError(e);
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
    if (e.type === "encoding.unsupported")
      return res.status(415).json({
        error: "不支持该请求内容编码",
        code: "UNSUPPORTED_CONTENT_ENCODING",
      });
    if (e.type === "charset.unsupported")
      return res
        .status(415)
        .json({ error: "不支持该字符编码", code: "UNSUPPORTED_CHARSET" });
    if (
      e.status === 400 &&
      e.expose === true &&
      typeof e.code === "string" &&
      (e.code.startsWith("Z_") || e.code.startsWith("ERR__ERROR_"))
    )
      return res
        .status(400)
        .json({ error: "压缩请求内容无效", code: "INVALID_COMPRESSED_BODY" });
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
    console.error(
      "[api]",
      e.code || e.name,
      e.message,
      ...(e instanceof AggregateError ? [errorCodes(e).join(", ")] : []),
    );
    res
      .status(500)
      .json({ error: "服务暂时不可用，请稍后重试", code: "INTERNAL_ERROR" });
  });
  return app;
}
