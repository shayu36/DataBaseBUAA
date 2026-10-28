# Campus Map and Station Ride Implementation Plan

> **For agentic workers:** Execute these tasks inline using executing-plans. Steps use checkbox syntax for tracking.

**Goal:** Replace the inaccurate campus diagram with the current Beihang official Xueyuan Road campus plan and make student borrowing/return station driven.

**Architecture:** The 2026 Beihang campus plan renders real campus roads and landmarks locally. The app retains a versioned illustrative cycling graph and no-ride rules. Simulated returns derive coordinates from the selected parking zone on the server.

**Tech Stack:** React 19, Vite 7, Express 5, MySQL 8, Playwright and node:test.

**Spec:** `docs/superpowers/specs/2026-10-28-campus-map-and-station-rides-design.md`

## Global Constraints

- Preserve user changes in the dirty worktree and historical ride/payment/carbon rows.
- The browser uses the current official campus plan as a local background with a source link; no map API key is needed.
- Main Building / Building 3 and Library areas are no-ride; family-area roads remain rideable.
- Student borrowing and return use parking zones, not coordinate controls.

---

### Task 1: Station-only simulated return

**Files:** `backend/business.mjs`, `frontend/src/pages.tsx`, `tests/business.test.mjs`, `tests/ui.spec.ts`.

**Interfaces:** `POST /api/rides/:id/return` accepts `{zone_id,route_mode,location_source:'MAP_SIMULATION'}` without x/y; explicit x/y stays supported. Existing `run` callback is unchanged.

- [x] Add a business test that starts a ride, posts a zone-only simulated return, and checks the order's return evidence equals the selected zone centre. Run the test and observe a validation failure because x/y is required.
- [x] Add a Playwright test that selects a parking zone to borrow from, sees only its available bikes, and returns to a zone without coordinate controls. Run it and observe failure.
- [x] Make `returnRide` load selected zone coordinates in its transaction when x/y is absent and source is `MAP_SIMULATION`; pass derived values to both existing return procedures. Reject missing x/y for other sources. Re-run business test.
- [x] Filter borrow cards by selected zone, retain bike choice, remove x/y fields and arbitrary `onPoint` selection, and submit zone-only returns. Re-run Playwright test.

### Task 2: Actual campus geography and route rules

**Files:** `database/campus-map.json`, `backend/analytics.mjs`, `database/procedures/campus.sql`, `frontend/src/CampusMap.tsx`, `tests/campus.test.mjs`.

**Interfaces:** Map v3 owns named roads, station coordinates, landmarks, forbidden polygons and road segments. Routing continues through `findRoute(nodes, edges, fromId, toId, mode)`.

- [x] Replace rectilinear-only graph assertions with tests for family-road connectivity, station-node alignment and exclusion of NO_RIDE edges.
- [x] Align v3 station coordinates and overlays to the 2026 official campus plan, retain source attribution and distinguish illustrative values. Remove the invalid PDF source reference.
- [x] Introduce explicit v2-to-v3 migration checks in `sp_upgrade_campus_map`, refusing active rides/dispatches and customized graphs; preserve historical ledgers. Run campus migration tests.
- [x] Render the official image with the parking zones, route graph layer and restricted overlays. Re-run targeted route and map tests.

### Task 3: Official campus plan presentation

**Files:** `frontend/src/CampusMap.tsx`, `frontend/src/styles.css`, `frontend/public/`, `README.md`, `tests/ui.spec.ts`.

**Interfaces:** `CampusMap` renders the official plan locally and retains role, zone selection and task props. No AK is required.

- [x] Add a UI test for the official plan source, building labels, station selection and zoom behavior.
- [x] Overlay markers, simulated route graph, task badges and no-ride polygons on the official campus image. Keep the source link visible.
- [x] Inspect the rendered student map visually with the local server.

### Task 4: Documentation and completion checks

**Files:** `README.md`, `docs/数据库课程设计报告.md`, `tests/ui.spec.ts`, `tests/campus.test.mjs`.

- [x] Document station return semantics, graph provenance, family roads, restricted areas and limitations.
- [x] Run targeted red-green tests, 24 Playwright tests, 139 database tests, TypeScript/Vite build and integrity checks; inspect the local browser roles and return workflow.
- [x] Check git diff and ensure existing local files remain intact.

### Task 5: Beihang themed login cover

**Files:** `frontend/src/App.tsx`, `frontend/src/styles.css`, `frontend/public/`, `tests/ui.spec.ts`.

- [x] Add a browser assertion that the login page displays 青行 and 北航学院路校区, preserves demo identity login, and does not show the reference university name. Run red for the new design cues.
- [x] Use the Beihang admissions page's Xueyuan Road Main Building photograph as the cover image, with visible source attribution.
- [x] Rework the login split-screen and responsive CSS around that photograph; retain keyboard accessibility and the current form behavior. Run login and mobile browser tests.
