import test from "node:test";
import assert from "node:assert/strict";
import {
  findRoute,
  dispatchSuggestions,
  bikeRisks,
  aggregateHotspots,
  buildLeaderboard,
} from "../server/analytics.mjs";
test("route modes use weighted undirected paths and actual distance", () => {
  const nodes = [1, 2, 3].map((id) => ({ id }));
  const edges = [
    {
      from_node_id: 1,
      to_node_id: 3,
      distance_m: 10,
      safety_cost: 10,
      comfort_cost: 10,
    },
    {
      from_node_id: 1,
      to_node_id: 2,
      distance_m: 8,
      safety_cost: 1,
      comfort_cost: 1,
    },
    {
      from_node_id: 2,
      to_node_id: 3,
      distance_m: 8,
      safety_cost: 1,
      comfort_cost: 1,
    },
  ];
  assert.equal(findRoute(nodes, edges, 3, 1).distance_m, 10);
  assert.deepEqual(findRoute(nodes, edges, 1, 3, "safe").path, [1, 2, 3]);
  assert.equal(findRoute(nodes, edges, 1, 3, "comfortable").distance_m, 16);
  assert.equal(findRoute(nodes, edges, 1, 1).distance_m, 0);
  assert.throws(() => findRoute(nodes, [], 1, 3));
  assert.throws(() =>
    findRoute(nodes, [{ ...edges[0], distance_m: NaN }], 1, 3),
  );
});
test("dispatch shares supply and respects occupied and reserved capacity", () => {
  const zones = [
    {
      id: 1,
      name: "A",
      capacity: 20,
      available: 16,
      occupied: 16,
      reserved: 0,
    },
    { id: 2, name: "B", capacity: 10, available: 0, occupied: 8, reserved: 1 },
    { id: 3, name: "C", capacity: 10, available: 0, occupied: 0, reserved: 0 },
  ];
  const result = dispatchSuggestions(zones);
  assert.ok(result.length);
  assert.ok(
    result
      .filter((s) => s.target_zone_id === 2)
      .reduce((n, s) => n + s.quantity, 0) <= 1,
  );
  assert.ok(result.reduce((n, s) => n + s.quantity, 0) <= 16);
  assert.ok(
    result.every((s) => Number.isInteger(s.quantity) && s.quantity > 0),
  );
  assert.deepEqual(dispatchSuggestions([]), []);
});
test("risk explains repeated recent faults and maintenance gap", () => {
  const now = new Date("2026-10-04T00:00:00Z");
  const result = bikeRisks(
    [{ id: 1, code: "B1", last_service_at: "2026-01-01" }],
    [1, 2, 3].map((id) => ({
      id,
      bike_id: 1,
      fault_type: "BRAKE",
      created_at: "2026-10-01",
    })),
    now,
  )[0];
  assert.equal(result.level, "HIGH");
  assert.ok(result.reasons.some((s) => s.includes("BRAKE")));
  assert.ok(result.reasons.length >= 3);
});
test("hotspots clip short intervals, skip gaps, use occupied fullness and Shanghai events", () => {
  const now = new Date("2026-10-04T00:10:00Z");
  const zones = [{ id: 1, name: "A", capacity: 10 }];
  const snapshots = [
    {
      zone_id: 1,
      available: 1,
      occupied: 10,
      capacity: 10,
      captured_at: "2026-10-04T00:00:00Z",
    },
    {
      zone_id: 1,
      available: 5,
      occupied: 5,
      capacity: 10,
      captured_at: "2026-10-04T00:04:00Z",
    },
    {
      zone_id: 1,
      available: 1,
      occupied: 10,
      capacity: 10,
      captured_at: "2026-10-04T00:20:00Z",
    },
  ];
  const r = aggregateHotspots(
    zones,
    [
      {
        start_zone_id: 1,
        started_at: "2026-10-04T00:00:00Z",
        end_zone_id: 1,
        ended_at: "2026-10-04T00:03:00Z",
      },
    ],
    snapshots,
    7,
    now,
  );
  assert.equal(r.hotspots[0].coverage_minutes, 4);
  assert.equal(r.hotspots[0].shortage_minutes, 4);
  assert.equal(r.hotspots[0].full_minutes, 4);
  assert.equal(r.hourly[8].borrow_count, 1);
  assert.equal(r.weekday.find((x) => x.weekday === 0).return_count, 1);
  assert.equal(r.snapshot_count, 2);
});
test("leaderboard uses Shanghai Monday and joins ledger only to qualifying paid rides", () => {
  const now = new Date("2026-10-05T01:00:00Z");
  const users = [
    { id: 1, name: "张小明" },
    { id: 2, name: "李四" },
  ];
  const rides = [
    {
      id: 1,
      user_id: 1,
      status: "PAID",
      ended_at: "2026-10-04T16:00:00Z",
      distance_m: 1000,
    },
    {
      id: 2,
      user_id: 1,
      status: "PAID",
      ended_at: "2026-10-04T15:59:59Z",
      distance_m: 2000,
    },
    {
      id: 3,
      user_id: 2,
      status: "ENDED",
      ended_at: "2026-10-05T00:00:00Z",
      distance_m: 3000,
    },
  ];
  const r = buildLeaderboard(
    users,
    rides,
    [
      { order_id: 1, points: 10, carbon_kg: 0.21 },
      { order_id: 2, points: 20 },
      { order_id: 3, points: 30 },
    ],
    "week",
    "points",
    now,
  );
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].points, 10);
  assert.equal(r.rows[0].rides, 1);
  assert.notEqual(r.rows[0].name, users[0].name);
});
test("hotspot reporting boundary clips a predecessor and never extends last sample", () => {
  const now = new Date("2026-10-04T00:00:00Z");
  const r = aggregateHotspots(
    [{ id: 1, name: "A" }],
    [],
    [
      {
        zone_id: 1,
        available: 0,
        occupied: 0,
        capacity: 10,
        captured_at: "2026-09-26T23:58:00Z",
      },
      {
        zone_id: 1,
        available: 0,
        occupied: 0,
        capacity: 10,
        captured_at: "2026-09-27T00:02:00Z",
      },
      {
        zone_id: 1,
        available: 0,
        occupied: 0,
        capacity: 0,
        captured_at: "2026-10-03T23:59:00Z",
      },
    ],
    7,
    now,
  );
  assert.equal(r.hotspots[0].coverage_minutes, 2);
  assert.equal(r.hotspots[0].shortage_minutes, 2);
  assert.equal(r.hotspots[0].full_minutes, 0);
  assert.equal(r.hotspots[0].peak_hour, null);
});
test("leaderboard monthly boundary and ties are deterministic and future rows excluded", () => {
  const users = [
    { id: 2, name: "B" },
    { id: 1, name: "A" },
  ];
  const rides = [
    {
      id: 1,
      user_id: 2,
      status: "PAID",
      ended_at: "2026-09-30T16:00:00Z",
      distance_m: 100,
    },
    {
      id: 2,
      user_id: 1,
      status: "PAID",
      ended_at: "2026-10-01T01:00:00Z",
      distance_m: 100,
    },
    {
      id: 3,
      user_id: 1,
      status: "PAID",
      ended_at: "2026-09-30T15:59:59Z",
      distance_m: 1000,
    },
    {
      id: 4,
      user_id: 1,
      status: "PAID",
      ended_at: "2026-11-01T00:00:00Z",
      distance_m: 1000,
    },
  ];
  const r = buildLeaderboard(
    users,
    rides,
    [],
    "month",
    "distance",
    new Date("2026-10-04"),
  );
  assert.deepEqual(
    r.rows.map((r) => [r.user_id, r.rank, r.distance_m]),
    [
      [1, 1, 100],
      [2, 1, 100],
    ],
  );
});
test("demand changes dispatch allocation and empty inputs are safe", () => {
  const zones = [
    { id: 1, capacity: 20, occupied: 15, available: 15, reserved: 0 },
    { id: 2, capacity: 20, occupied: 2, available: 2, reserved: 0 },
  ];
  const baseline = dispatchSuggestions(zones);
  const adjusted = dispatchSuggestions(zones, [
    { zone_id: 2, borrow_count: 30, return_count: 0 },
  ]);
  assert.ok(
    adjusted.reduce((n, s) => n + s.quantity, 0) >=
      baseline.reduce((n, s) => n + s.quantity, 0),
  );
  assert.deepEqual(bikeRisks([], []), []);
  assert.deepEqual(buildLeaderboard([], [], []).rows, []);
  assert.equal(aggregateHotspots([], [], []).snapshot_count, 0);
});

test("custom hotspot filters use Beijing weekday, hour and station", () => {
  const result = aggregateHotspots(
    [
      { id: 1, name: "主楼", capacity: 10 },
      { id: 2, name: "体育场", capacity: 10 },
    ],
    [
      { start_zone_id: 1, started_at: "2026-10-08T00:30:00Z" },
      { start_zone_id: 1, started_at: "2026-10-08T04:30:00Z" },
      { start_zone_id: 2, started_at: "2026-10-08T00:30:00Z" },
    ],
    [],
    {
      start: "2026-10-08",
      end: "2026-10-08",
      dayType: "WEEKDAY",
      startHour: 8,
      endHour: 10,
      zoneId: 1,
    },
    new Date("2026-10-09T00:00:00Z"),
  );
  assert.equal(result.hotspots.length, 1);
  assert.equal(result.hotspots[0].borrow_count, 1);
  assert.equal(result.filter.timezone, "Asia/Shanghai");
});

test("route direction and road closures are enforced", () => {
  const nodes = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const edges = [
    {
      from_node_id: 1,
      to_node_id: 2,
      distance_m: 10,
      safety_cost: 0,
      comfort_cost: 0,
      direction: "FORWARD",
      status: "OPEN",
    },
    {
      from_node_id: 2,
      to_node_id: 3,
      distance_m: 10,
      safety_cost: 0,
      comfort_cost: 0,
      direction: "BOTH",
      status: "CLOSED",
    },
  ];
  assert.equal(findRoute(nodes, edges, 1, 2).distance_m, 10);
  assert.throws(() => findRoute(nodes, edges, 2, 1), /No route/);
  assert.throws(() => findRoute(nodes, edges, 1, 3), /No route/);
});
