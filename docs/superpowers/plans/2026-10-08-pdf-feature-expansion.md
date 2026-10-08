# PDF Feature Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete every runnable feature described in `后续拓展方向.pdf`, including persisted suggestion and risk workflows, qualified carbon transactions, privacy-aware rankings, enriched routes, and reviewable return attempts.

**Architecture:** Preserve the eight core business entities and extend the MySQL model with three support tables plus versioned fields on existing tables. Keep calculations in pure functions in `server/analytics.mjs`, put transactional workflows in focused service modules, expose validated Express endpoints, and present the flows through existing navigation sections.

**Tech Stack:** Node.js 22.12+, Express 5, MySQL 8.0.16+, mysql2, Zod 4, React 19, TypeScript 5.9, Vite 7, Node test runner, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-08-pdf-feature-expansion-design.md`

**Execution status (2026-10-08): COMPLETE.** All nine task outcomes are implemented and accepted. The final React work was consolidated into `src/pages.tsx` and `src/styles.css` instead of creating five thin feature wrapper files. Verification evidence: 58 Node/MySQL tests, 8 Playwright tests, production build, Prettier, 20 responsive screenshot checks, 15 live invariants, 27 SQL query groups, and an independent snapshot restore all pass. The detailed step boxes below remain the original planning record.

## Global Constraints

- Preserve the eight core entities: users, bikes, parking zones, ride orders, payments, staff, dispatch tasks, and maintenance tickets.
- Store timestamps in UTC and interpret report hours, weekdays, weeks, and months in Asia/Shanghai.
- Keep the map, positioning, road attributes, carbon output, and payments explicitly labeled as classroom simulations.
- Risk scoring remains explainable rule processing and must not claim predictive accuracy.
- All authorized mutations use `actorTransaction`; all administrative state changes create `audit_logs` rows.
- Existing users, bikes, orders, payments, maintenance history, dispatch history, and net carbon totals must survive migration.
- No new runtime dependencies are required.
- The workspace has no `.git` directory, so each task ends with a review checkpoint instead of a commit. If Git is initialized later, use the commit message shown in the checkpoint.

---

### Task 1: Versioned schema migration and data preservation

**Files:**
- Create: `server/feature-migrations.mjs`
- Create: `scripts/migrate-features.mjs`
- Modify: `database/schema.sql`
- Modify: `scripts/start.ps1`
- Modify: `scripts/seed.mjs`
- Modify: `scripts/sql.mjs`
- Modify: `tests/campus.test.mjs`
- Create: `tests/migrations.test.mjs`

**Interfaces:**
- Produces: `applyFeatureMigrations(connection): Promise<{ applied: string[] }>`.
- Produces: schema objects `dispatch_suggestions`, `risk_alerts`, and `carbon_transactions`.
- Consumes: `ledgerTransaction(pool, work)` from `server/db.mjs` and the existing legacy `carbon_ledger` table when migrating a populated database.

- [ ] **Step 1: Write migration preservation tests**

Add a test that creates the existing legacy schema and representative paid data, runs the migration twice, and checks that the second run is a no-op:

```js
test("feature migration preserves business rows and carbon totals and is idempotent", async () => {
  const before = await legacyCounts(pool);
  const first = await applyFeatureMigrations(pool);
  const second = await applyFeatureMigrations(pool);
  assert.ok(first.applied.length > 0);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(await businessCounts(pool), before.business);
  assert.deepEqual(await carbonTotals(pool), before.carbon);
});
```

Add checks for default private leaderboard settings, `VALID` historical paid orders, migrated `AWARD` entries, default open/bidirectional road attributes, and historical return attempts marked `PENDING` with source `MAP_SIMULATION`.

- [ ] **Step 2: Run the migration test and confirm the missing module failure**

Run: `node --test tests/migrations.test.mjs`

Expected: FAIL because `server/feature-migrations.mjs` does not exist.

- [ ] **Step 3: Extend the canonical schema**

Replace `carbon_ledger` with this append-only shape and add the other support objects to `database/schema.sql`:

```sql
CREATE TABLE carbon_transactions (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 order_id BIGINT UNSIGNED NOT NULL,
 entry_type ENUM('AWARD','ADJUSTMENT') NOT NULL,
 award_order_id BIGINT UNSIGNED GENERATED ALWAYS AS
   (CASE WHEN entry_type='AWARD' THEN order_id END) STORED UNIQUE,
 idempotency_key VARCHAR(100) NOT NULL UNIQUE,
 distance_m INT NOT NULL DEFAULT 0,
 points_change INT NOT NULL,
 carbon_kg_change DECIMAL(12,4) NOT NULL,
 factor_kg_per_km DECIMAL(5,3) NOT NULL,
 rule_version VARCHAR(30) NOT NULL,
 reason VARCHAR(300) NOT NULL,
 actor_id BIGINT UNSIGNED NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 FOREIGN KEY(order_id) REFERENCES ride_orders(id),
 FOREIGN KEY(actor_id) REFERENCES users(id)
) ENGINE=InnoDB;
```

Define `dispatch_suggestions` with source/target zone IDs, quantity, source and target inventory snapshots, demand window, reason, algorithm version, status, linked task, creator, created time, and resolved time. Define `risk_alerts` with bike ID, score, level, reasons JSON, ticket IDs JSON, fingerprint, rule version, status, recommendation, handler, timestamps, and a unique open fingerprint.

Add exact columns from the spec to `users`, `ride_orders`, `return_attempts`, and `road_edges`, including checks for coordinate pairs, review terminal fields, 0–5 attribute ranges, valid slope, and positive location capture time.

- [ ] **Step 4: Implement idempotent migration helpers**

Implement catalog checks and sequential migration steps:

```js
export async function applyFeatureMigrations(db) {
  const applied = [];
  await addMissingColumns(db, applied);
  await migrateCarbonLedger(db, applied);
  await createSupportTables(db, applied);
  await migrateHistoricalDefaults(db, applied);
  await replaceViewsAndTriggers(db, applied);
  await recordVersion(db, "pdf_expansion", 1);
  return { applied };
}
```

Use `information_schema.columns` and `information_schema.tables` rather than swallowing SQL errors. Move old `carbon_ledger` rows into `carbon_transactions` with `entry_type='AWARD'`, `rule_version='legacy-v1'`, and `idempotency_key=CONCAT('legacy-award-',order_id)`. Rename the legacy table to `carbon_ledger_legacy` only after row count and sum checks pass.

- [ ] **Step 5: Integrate migration into setup and startup**

Call `applyFeatureMigrations` after base DDL in `scripts/setup.mjs`/`scripts/sql.mjs`. Insert `node scripts/migrate-features.mjs` between setup and seeding in `scripts/start.ps1`. Make `seed.mjs` seed the expanded fields and new support data on a clean database.

- [ ] **Step 6: Verify migration and full fresh-schema compatibility**

Run:

```powershell
node --test tests/migrations.test.mjs tests/campus.test.mjs
node scripts/migrate-features.mjs
node scripts/check.mjs
```

Expected: all tests pass; live migration reports version 1; all existing invariants remain zero.

- [ ] **Step 7: Review checkpoint**

Inspect row counts and net points/carbon before and after. If Git becomes available, commit as `feat: add versioned expansion schema migration`.

### Task 2: Time-filtered hotspot analysis and persisted dispatch suggestions

**Files:**
- Modify: `server/analytics.mjs`
- Create: `server/operations.mjs`
- Modify: `server/app.mjs`
- Modify: `server/read-model.mjs`
- Modify: `tests/analytics.test.mjs`
- Create: `tests/operations.test.mjs`
- Modify: `tests/http.test.mjs`

**Interfaces:**
- Consumes: expanded schema from Task 1.
- Produces: `aggregateHotspots(zones, rides, snapshots, filter, now)` where `filter` contains `start`, `end`, `dayType`, `startHour`, `endHour`, and optional `zoneId`.
- Produces: `createDispatchSuggestions(pool, actor, filter)` and `confirmDispatchSuggestion(pool, actor, suggestionId, staffId?)`.

- [ ] **Step 1: Write hotspot filter tests**

Cover single-day Beijing boundaries, weekday/weekend selection, overnight-invalid hour ranges, station filtering, five-minute snapshot gaps, and empty coverage:

```js
const result = aggregateHotspots(zones, rides, snapshots, {
  start: "2026-10-08", end: "2026-10-08", dayType: "WEEKDAY",
  startHour: 7, endHour: 9, zoneId: 2,
}, new Date("2026-10-08T12:00:00Z"));
assert.equal(result.hotspots.length, 1);
assert.equal(result.filter.timezone, "Asia/Shanghai");
```

- [ ] **Step 2: Run analytics tests and confirm signature failures**

Run: `node --test tests/analytics.test.mjs`

Expected: FAIL for unsupported filter structure and missing inventory series.

- [ ] **Step 3: Implement filtered aggregation**

Add a normalizer that converts Beijing-local date/hour filters to UTC instants, rejects ranges longer than 31 days, and filters both events and snapshots. Return `inventory_series`, `coverage_ratio`, and a `methodology` object alongside existing aggregates. Keep the old `days=7|30` query as a compatibility shorthand.

- [ ] **Step 4: Write suggestion persistence and stale-confirmation tests**

Test that generation stores the inventory and demand basis, confirmation creates one task, concurrent confirmation creates only one task, and changed capacity or inventory marks the suggestion stale with a reason.

- [ ] **Step 5: Implement suggestion workflows**

Use `actorTransaction` and existing `createDispatch`:

```js
export function confirmDispatchSuggestion(pool, actor, suggestionId, staffId) {
  return actorTransaction(pool, actor, async (c) => {
    const suggestion = await lockOpenSuggestion(c, suggestionId);
    const current = await currentDispatchCapacity(c, suggestion);
    if (!stillValid(suggestion, current)) return markStale(c, suggestion, current);
    const task = await createDispatchInConnection(c, actor, suggestion, staffId);
    await linkConfirmedSuggestion(c, suggestion.id, task.id);
    return task;
  });
}
```

Refactor the existing dispatch function only enough to expose a connection-scoped helper; preserve all authorization, vehicle reservation, and capacity checks.

- [ ] **Step 6: Add validated endpoints and read models**

Add `GET /api/analytics` filters, `POST /api/analytics/suggestions`, `GET /api/analytics/suggestions`, and `POST /api/dispatches/from-suggestion/:id`. Define stable errors `INVALID_REPORT_RANGE`, `SUGGESTION_STALE`, and `SUGGESTION_NOT_OPEN`.

- [ ] **Step 7: Run focused and HTTP tests**

Run: `node --test tests/analytics.test.mjs tests/operations.test.mjs tests/http.test.mjs`

Expected: PASS with authenticated admin-only mutations and student denial.

- [ ] **Step 8: Review checkpoint**

Inspect one suggestion row before and after confirmation and verify the task contains the selected bikes. If Git becomes available, commit as `feat: persist filtered hotspot dispatch suggestions`.

### Task 3: Versioned risk alerts and maintenance disposition

**Files:**
- Modify: `server/analytics.mjs`
- Create: `server/risks.mjs`
- Modify: `server/app.mjs`
- Modify: `server/read-model.mjs`
- Create: `tests/risks.test.mjs`
- Modify: `tests/http.test.mjs`

**Interfaces:**
- Consumes: `bikeRisks(bikes, tickets, now)` and `risk_alerts` from Task 1.
- Produces: `refreshRiskAlerts(pool, actor, now): Promise<RiskAlert[]>`.
- Produces: `actOnRisk(pool, actor, id, action, input)` for `ACKNOWLEDGE`, `RESOLVE`, `DISMISS`, and `CREATE_TICKET`.

- [ ] **Step 1: Write rule-version and deduplication tests**

Test repeated same-type completed faults, duplicate open reports counted once, no-service history, short rides as a non-conclusive reason, stable fingerprints, and a second refresh that creates no duplicate open row.

- [ ] **Step 2: Run risk tests and confirm missing workflow failure**

Run: `node --test tests/risks.test.mjs`

Expected: FAIL because `server/risks.mjs` does not exist.

- [ ] **Step 3: Extend the pure risk evaluator**

Return structured reasons rather than only strings:

```js
{
  rule: "REPEAT_FAULT", points: 20,
  message: "BRAKE 同类型确认故障复发 2 次",
  ticket_ids: [12, 18]
}
```

Only completed or currently assigned/open unique fault groups count as confirmed evidence. Short rides add a low-weight `RIDE_ANOMALY_CLUE` reason and never change bike state.

- [ ] **Step 4: Implement refresh and disposition transactions**

Hash `{bikeId, ruleVersion, normalizedReasons}` for the fingerprint. Insert only medium/high alerts or configured thresholds. Restrict acknowledge/resolve/dismiss to admin or maintenance-capable active staff. `CREATE_TICKET` calls a connection-scoped maintenance helper and then links the ticket without closing the alert.

- [ ] **Step 5: Add risk endpoints and dashboard data**

Add `POST /api/risks/refresh`, `GET /api/risks`, and `POST /api/risks/:id/:action`. Return related ticket summaries and disposition history fields.

- [ ] **Step 6: Verify risk workflow**

Run: `node --test tests/risks.test.mjs tests/business.test.mjs tests/http.test.mjs`

Expected: PASS; confirmation alone leaves the bike rentable, while linked fault reporting moves it to maintenance through the existing workflow.

- [ ] **Step 7: Review checkpoint**

Inspect audit records for refresh, acknowledgment, ticket creation, and resolution. If Git becomes available, commit as `feat: add versioned vehicle risk workflow`.

### Task 4: Directed road status and explainable route comparison

**Files:**
- Modify: `database/campus-map.json`
- Modify: `server/analytics.mjs`
- Create: `server/roads.mjs`
- Modify: `server/app.mjs`
- Modify: `server/admin.mjs`
- Modify: `server/campus.mjs`
- Modify: `tests/analytics.test.mjs`
- Modify: `tests/admin.test.mjs`
- Modify: `tests/http.test.mjs`

**Interfaces:**
- Consumes: extended `road_edges` schema from Task 1.
- Produces: `findRoute(nodes, edges, fromId, toId, mode)` with `segments`, `explanation`, and `attribute_totals`.
- Produces: `saveRoad(pool, actor, input)` with status and attribute validation.

- [ ] **Step 1: Write graph behavior tests**

Test forward-only and reverse-only traversal, closed and no-ride exclusions, no-path errors, and distinct safe/comfortable choices based on attribute contributions. Assert historical route distances stored on orders remain unchanged after a road edit.

- [ ] **Step 2: Run route tests and confirm current undirected behavior fails**

Run: `node --test tests/analytics.test.mjs tests/admin.test.mjs`

Expected: FAIL because current graph inserts both directions and ignores status.

- [ ] **Step 3: Implement directed eligible graph construction**

Use a single edge-weight function:

```js
function edgeWeight(edge, mode) {
  if (mode === "shortest") return edge.distance_m;
  if (mode === "safe") return edge.distance_m *
    (1 + edge.safety_cost + edge.intersection_risk * .18 +
     trafficPenalty(edge.traffic_mix) + (5-edge.lighting_level) * .12);
  return edge.distance_m *
    (1 + edge.comfort_cost + surfacePenalty(edge.surface) +
     Math.abs(edge.slope_percent) * .04 + (5-edge.shade_level) * .08);
}
```

Skip `CLOSED` and `NO_RIDE`; add adjacency in allowed directions only. Return each segment's simulated attributes and the three largest explanation contributions.

- [ ] **Step 4: Seed deterministic campus attributes**

Add explicit values for every campus edge in `database/campus-map.json`. Mark all values with `attribute_source: "SIMULATED_COURSE_DATA"`. Keep every default edge open so current route pairs remain connected.

- [ ] **Step 5: Implement road maintenance transaction and endpoint**

Validate enum/range fields, require admin, update one edge, add an audit row with before/after JSON, and expose `POST /api/admin/roads`. Return `NO_ROUTE` as a 409 business error when closures disconnect selected stations.

- [ ] **Step 6: Run route, admin, and HTTP tests**

Run: `node --test tests/analytics.test.mjs tests/admin.test.mjs tests/http.test.mjs`

Expected: PASS with clear no-path responses and persisted audit details.

- [ ] **Step 7: Review checkpoint**

Close one non-critical edge in the test database, verify rerouting, reopen it, and verify the original path. If Git becomes available, commit as `feat: enrich and control campus road routing`.

### Task 5: Position freshness, successful return evidence, and violation review

**Files:**
- Modify: `server/business.mjs`
- Create: `server/returns.mjs`
- Modify: `server/app.mjs`
- Modify: `server/read-model.mjs`
- Modify: `tests/business.test.mjs`
- Create: `tests/returns.test.mjs`
- Modify: `tests/http.test.mjs`

**Interfaces:**
- Consumes: expanded order and return-attempt fields from Task 1.
- Produces: `returnRide(pool, actor, input)` accepting `x`, `y`, `captured_at`, `location_source`, and `route_mode`.
- Produces: `reviewReturnAttempt(pool, actor, id, action, note)`.

- [ ] **Step 1: Write location and review tests**

Cover exact fence boundary acceptance, non-finite/out-of-range coordinates, location before ride start, future location, location older than five minutes, successful evidence stored on the order, failed evidence stored on the attempt, student-private reads, and admin-only review.

- [ ] **Step 2: Run return tests and confirm missing fields**

Run: `node --test tests/business.test.mjs tests/returns.test.mjs`

Expected: FAIL for the missing capture metadata and review workflow.

- [ ] **Step 3: Validate position freshness before fence checks**

Normalize accepted sources to `MAP_SIMULATION`, `DEVICE_GPS`, or `MANUAL`. Reject invalid coordinates with `INVALID_LOCATION`; store stale attempts with `LOCATION_STALE`; reject timestamps more than 30 seconds in the future. Use `distance <= radius` so the boundary counts as inside.

- [ ] **Step 4: Persist successful and failed evidence atomically**

On success, store `return_x`, `return_y`, `location_captured_at`, and `location_source` on the order in the same transaction that releases the bike. On failure, persist the attempt and commit it while leaving the order and bike in running state, matching the existing rejected-return behavior.

- [ ] **Step 5: Implement review workflow and endpoints**

Add `GET /api/return-attempts` scoped by role and `POST /api/returns/:id/review` with `RESOLVE` or `DISMISS`. Require a 2–300 character note, set handler/time, and add an audit record. Review never completes the ride.

- [ ] **Step 6: Verify return regressions**

Run: `node --test tests/business.test.mjs tests/returns.test.mjs tests/http.test.mjs`

Expected: PASS for old geofence/capacity behavior and new freshness/review cases.

- [ ] **Step 7: Review checkpoint**

Confirm one stale attempt is visible to its student and admin but not another student. If Git becomes available, commit as `feat: retain and review return location evidence`.

### Task 6: Order qualification and append-only carbon transactions

**Files:**
- Create: `server/carbon.mjs`
- Modify: `server/business.mjs`
- Modify: `server/read-model.mjs`
- Modify: `server/app.mjs`
- Modify: `database/schema.sql`
- Modify: `tests/business.test.mjs`
- Create: `tests/carbon.test.mjs`
- Modify: `tests/http.test.mjs`

**Interfaces:**
- Consumes: `carbon_transactions` and order qualification fields from Task 1.
- Produces: `awardCarbonForOrder(c, orderId, actorId?)`, `reviewOrderQualification(pool, actor, orderId, decision, reason)`, and `adjustCarbon(pool, actor, input)`.
- Produces: net-carbon read model derived from signed transaction values.

- [ ] **Step 1: Write qualification and ledger tests**

Test one award per valid paid order, no award while under review, confirmation backfill, exclusion reversal, signed adjustment, idempotency key replay, insufficient negative adjustment rejection, rule version retention, and unchanged historical awards after settings change.

- [ ] **Step 2: Run carbon tests and confirm legacy assumptions fail**

Run: `node --test tests/carbon.test.mjs tests/business.test.mjs`

Expected: FAIL because the current ledger allows only one non-negative row per order and lacks qualification.

- [ ] **Step 3: Implement qualification classification**

Add a pure `classifyRideForCredit(order, route)` function. Mark only objectively suspicious duration/distance combinations as `UNDER_REVIEW`; otherwise `VALID`. The classifier returns reasons but never changes vehicle fault state or alleges misconduct.

- [ ] **Step 4: Implement award, review, reversal, and adjustment transactions**

Use `system_settings.carbon.rule_version`; calculate with Decimal and half-up rounding. `VALID` paid orders receive `AWARD`. Confirming a reviewed order inserts a missing award. Excluding an awarded order inserts an exact negative `ADJUSTMENT` referencing the original reason. Manual adjustments require admin, an idempotency key, a non-zero point or carbon change, and a reason.

- [ ] **Step 5: Replace carbon views and reads**

Update `v_user_carbon` and dashboard queries to sum `points_change` and `carbon_kg_change`. Return transaction type, reason, rule version, and actor in personal history. Keep JSON response aliases `points` and `carbon_kg` for UI compatibility.

- [ ] **Step 6: Add qualification and adjustment endpoints**

Add `POST /api/orders/:id/qualification` and `POST /api/carbon/adjustments`; return stable codes `ORDER_NOT_REVIEWABLE`, `CARBON_ALREADY_AWARDED`, and `INVALID_ADJUSTMENT`.

- [ ] **Step 7: Verify payment, carbon, and HTTP suites**

Run: `node --test tests/carbon.test.mjs tests/business.test.mjs tests/http.test.mjs`

Expected: PASS with one award per qualifying order and auditable net adjustments.

- [ ] **Step 8: Review checkpoint**

Compare migrated and current net totals, then trace an award and reversal to the order and audit log. If Git becomes available, commit as `feat: add qualified append-only carbon accounting`.

### Task 7: Privacy-aware leaderboard and personal rank

**Files:**
- Modify: `server/analytics.mjs`
- Create: `server/profile.mjs`
- Modify: `server/app.mjs`
- Modify: `server/read-model.mjs`
- Modify: `tests/analytics.test.mjs`
- Create: `tests/profile.test.mjs`
- Modify: `tests/http.test.mjs`

**Interfaces:**
- Consumes: valid orders and signed carbon transactions from Task 6.
- Produces: `buildLeaderboard(users, rides, transactions, period, metric, now, viewerId)` returning `{ rows, me, window }`.
- Produces: `updateLeaderboardProfile(pool, actor, { alias, visible })`.

- [ ] **Step 1: Write ranking privacy tests**

Cover private users excluded from public rows, current private user returned in `me`, nickname display, duplicate nickname allowance, week/month Beijing boundaries, invalid and unpaid orders excluded, adjustment occurrence-period attribution, and competition ranking ties.

- [ ] **Step 2: Run leaderboard tests and confirm privacy failures**

Run: `node --test tests/analytics.test.mjs tests/profile.test.mjs`

Expected: FAIL because current leaderboard displays all real names and has no `me` result.

- [ ] **Step 3: Implement privacy-aware aggregation**

Filter public rows by `leaderboard_visible=1`; aggregate `VALID` paid rides for rides/distance and period-local transactions for points. Rank all eligible values with competition rank, then return public rows and the viewer's private aggregate separately. Never expose email, phone, or hidden real names.

- [ ] **Step 4: Implement profile validation and endpoint**

Allow the logged-in user to set a 2–20 character alias and boolean visibility. Trim whitespace, reject control characters, and write an audit row. Add `POST /api/profile/leaderboard`; do not add an administrator override.

- [ ] **Step 5: Extend leaderboard endpoint response**

Return `{ rows, me, window: { start, end, timezone: "Asia/Shanghai" } }`. Preserve the existing `period` and `metric` query validation.

- [ ] **Step 6: Verify ranking and access behavior**

Run: `node --test tests/analytics.test.mjs tests/profile.test.mjs tests/http.test.mjs`

Expected: PASS with private-by-default output and visible personal rank.

- [ ] **Step 7: Review checkpoint**

Use two users to toggle visibility and verify the public list changes without changing totals or historical transactions. If Git becomes available, commit as `feat: add private leaderboard profiles and personal rank`.

### Task 8: React workflows for all expansion features

**Files:**
- Create: `src/features/AnalyticsExpansion.tsx`
- Create: `src/features/RiskWorkflow.tsx`
- Create: `src/features/RouteComparison.tsx`
- Create: `src/features/ReturnReview.tsx`
- Create: `src/features/CarbonExpansion.tsx`
- Modify: `src/pages.tsx`
- Modify: `src/App.tsx`
- Modify: `src/types.ts`
- Modify: `src/styles.css`
- Modify: `tests/ui.spec.ts`

**Interfaces:**
- Consumes: endpoints from Tasks 2–7 through existing `api(path, body?)`.
- Produces: focused feature components imported by `src/pages.tsx` without adding top-level navigation items.

- [ ] **Step 1: Write browser tests for the new workflows**

Add Playwright scenarios that:

```ts
test("admin filters hotspots and confirms a fresh suggestion", async ({ page }) => { /* exact labels and assertions */ });
test("operator acknowledges risk and opens a maintenance ticket", async ({ page }) => { /* status checks */ });
test("road closure explains a route detour", async ({ page }) => { /* distance and reason */ });
test("stale return location remains reviewable", async ({ page }) => { /* student/admin visibility */ });
test("private rider sees personal rank and can opt in", async ({ page }) => { /* public list changes */ });
```

Use API fixtures for destructive edge cases and one live end-to-end workflow per domain. Assert no console errors.

- [ ] **Step 2: Run the new UI tests and confirm missing controls**

Run: `$env:QINGXING_E2E_URL='http://127.0.0.1:5188'; npx playwright test -g 'hotspots|risk|detour|stale return|personal rank'`

Expected: FAIL because the named controls and views do not exist.

- [ ] **Step 3: Build analytics and risk components**

Implement labeled date, preset, day-type, hour, and station controls; an SVG inventory line chart with text summary; saved suggestion cards with `OPEN/STALE/CONFIRMED`; and risk cards with score, rule reasons, related tickets, recommendation, and role-appropriate actions. Refresh the parent dashboard after mutations.

- [ ] **Step 4: Build route comparison and road editor**

Request all three route modes for a selected pair, show distance/time cards and simulated attribute explanations, allow one mode to drive `CampusMap`, and show a clear no-path panel. Add the admin road table under Base Data with status/direction and numeric/select fields.

- [ ] **Step 5: Build return evidence and review UI**

Send an ISO capture timestamp and `MAP_SIMULATION` source with map returns. Show the latest capture time, stale-location errors, and the student's attempt history. Add the admin review table with status, reason, coordinates, capture time, source, note, and resolve/dismiss actions.

- [ ] **Step 6: Build qualification, carbon, and privacy UI**

Show qualification and distance source on order details. Add admin qualification review and adjustment forms. Render signed carbon entries with type/reason/rule version. Add nickname/visibility settings and a distinct “我的名次” card even when the user is private.

- [ ] **Step 7: Add accessible responsive styling**

Use the established blue/orange/purple/teal palette. Charts must include textual values; status is not conveyed by color alone; controls have labels; dialogs are avoided in favor of inline forms; 390px pages have no page-level horizontal overflow.

- [ ] **Step 8: Run focused UI, build, and formatting checks**

Run:

```powershell
npm run build
npm run format:check
$env:QINGXING_E2E_URL='http://127.0.0.1:5188'
npx playwright test
```

Expected: TypeScript build passes, formatting passes, and all browser tests pass.

- [ ] **Step 9: Review checkpoint**

Inspect desktop and 390px screenshots for each modified page and verify keyboard operation. If Git becomes available, commit as `feat: expose PDF expansion workflows in the UI`.

### Task 9: Documentation, database evidence, restore, and packaged delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/作业基本信息.md`
- Modify: `docs/数据库课程设计报告.md`
- Modify: `docs/测试报告.md`
- Modify: `docs/答辩演示指南.md`
- Modify: `docs/ER图.svg` through `scripts/render-report.mjs`
- Modify: `database/queries.sql`
- Modify: `scripts/check.mjs`
- Modify: `scripts/render-report.mjs`
- Modify: `scripts/screenshots.mjs`
- Modify: `scripts/package-project.py`
- Regenerate: `database/demo-snapshot.sql`
- Regenerate: `docs/数据库课程设计报告.html`
- Regenerate: `docs/evidence/*`
- Regenerate: `docs/screenshots/*`
- Regenerate: `deliverables/青行Qingxing_共享自行车数据库课程设计.zip`

**Interfaces:**
- Consumes: the complete expanded system from Tasks 1–8.
- Produces: a verified course-delivery archive with no local credentials or runtime database files.

- [ ] **Step 1: Extend invariant and SQL query evidence**

Add checks for one award per eligible order, transaction net totals, terminal review metadata, one confirmed suggestion per task, unique open risk fingerprints, road attribute ranges, and private leaderboard data not leaking into public output. Add SQL examples for filtered hotspots, risk history, suggestion lineage, road attributes, return review, carbon net ledger, and personal rank.

- [ ] **Step 2: Run all automated verification and save evidence**

Run:

```powershell
npm test
npm run build
npm run format:check
$env:QINGXING_E2E_URL='http://127.0.0.1:5188'
npm run test:e2e
npm run check
node scripts/run-queries.mjs
```

Expected: every command exits 0; invariants report zero violations; SQL query groups all execute.

- [ ] **Step 3: Update course documentation and ER/data dictionary**

Document the final table/view/trigger/procedure counts, every new field and relation, Beijing-time definitions, simulation limits, rule versions, transaction semantics, and role permissions. Explicitly state that all seven PDF directions are operational while learned fault prediction remains a research boundary requiring labeled real data.

- [ ] **Step 4: Render the report and capture visual evidence**

Run:

```powershell
npm run report
npm run screenshots
```

Expected: regenerated HTML and ER SVG; every desktop/mobile screenshot check reports no alerts and no page-level overflow.

- [ ] **Step 5: Refresh and independently restore the snapshot**

Run `npm run snapshot`, restore it into a new `campus_bike_restore_YYYYMMDD_expansion` database, run `scripts/check.mjs` against that database, and verify schema object counts and net carbon totals match the source database.

- [ ] **Step 6: Build and verify the final archive**

Run: `python scripts/package-project.py`

Expected: archive verification succeeds, `.env`, `.runtime`, `node_modules`, backups, and secret values are absent, while source, report, screenshots, snapshot, tests, and built frontend are present.

- [ ] **Step 7: Final review checkpoint**

Open `http://127.0.0.1:5188`, execute the answer-defense flow from hotspot selection through suggestion confirmation and distribution change, then demonstrate geofence review, risk disposition, route closure, carbon adjustment, and privacy-aware ranking. If Git becomes available, commit as `docs: deliver complete PDF expansion system`.
