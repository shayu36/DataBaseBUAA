import campus from "../database/campus-map.json" with { type: "json" };

// Shared with the SVG map: every route endpoint uses the same local metre grid.
export async function installCampusRoads(c) {
  for (const n of campus.nodes)
    await c.query(
      "INSERT INTO road_nodes(id,name,x,y,zone_id) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE name=VALUES(name),x=VALUES(x),y=VALUES(y),zone_id=VALUES(zone_id)",
      [n.id, n.name, n.x, n.y, n.zone_id],
    );
  for (const e of campus.edges) {
    const attrs = {
      slope: ((e.id % 5) - 2) * 1.5,
      surface: e.id % 5 === 0 ? "ROUGH" : e.id % 2 === 0 ? "AVERAGE" : "SMOOTH",
      shade: Math.min(5, 2 + (e.id % 4)),
      lighting: 5 - (e.id % 3),
      traffic:
        e.id % 7 === 0 ? "MOTOR_HEAVY" : e.id % 3 === 0 ? "BIKE_ONLY" : "MIXED",
      risk: e.id % 4,
    };
    await c.query(
      "INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source) VALUES(?,?,?,?,?,'BOTH','OPEN',?,?,?,?,?,?,'SIMULATED_COURSE_DATA')",
      [
        e.from_node_id,
        e.to_node_id,
        e.distance_m,
        e.safety_cost,
        e.comfort_cost,
        attrs.slope,
        attrs.surface,
        attrs.shade,
        attrs.lighting,
        attrs.traffic,
        attrs.risk,
      ],
    );
  }
  await c.query(
    "INSERT INTO system_settings(name,value) VALUES('campus_map',JSON_OBJECT('version',?,'source',?))",
    [campus.version, campus.source],
  );
}

// Invoked inside the application's ledger lock and a single transaction.
// Only the known original demo layout may be migrated automatically.
export async function upgradeCampusMap(c) {
  const [[marker]] = await c.query(
    "SELECT value FROM system_settings WHERE name='campus_map'",
  );
  if (marker) {
    const value =
      typeof marker.value === "string"
        ? JSON.parse(marker.value)
        : marker.value;
    if (value.version !== campus.version)
      throw new Error(
        "Unknown campus map version; explicit migration required.",
      );
    return false;
  }
  const [[{ active }]] = await c.query(
    "SELECT (SELECT COUNT(*) FROM ride_orders WHERE status='RUNNING') + (SELECT COUNT(*) FROM dispatch_tasks WHERE status IN ('PENDING','IN_PROGRESS')) active",
  );
  if (active)
    throw new Error(
      "Campus map update requires no active rides or dispatches.",
    );
  const [zones] = await c.query(
    "SELECT id,name,x,y FROM parking_zones ORDER BY id",
  );
  const [nodes] = await c.query(
    "SELECT id,name,x,y,zone_id FROM road_nodes ORDER BY id",
  );
  const [edges] = await c.query(
    "SELECT from_node_id,to_node_id FROM road_edges ORDER BY from_node_id,to_node_id",
  );
  const legacy = [
    [1, "东门驿站", 160, 440],
    [2, "图书馆", 450, 180],
    [3, "教学楼", 760, 210],
    [4, "学生公寓", 210, 750],
    [5, "中心食堂", 530, 550],
    [6, "运动场", 850, 700],
  ];
  const expectedEdges = [
    [1, 2],
    [1, 4],
    [1, 7],
    [2, 3],
    [2, 7],
    [3, 8],
    [4, 5],
    [4, 7],
    [5, 6],
    [5, 7],
    [5, 8],
    [6, 8],
    [7, 8],
  ];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (
    !same(
      zones.map((z) => [z.id, z.name, Number(z.x), Number(z.y)]),
      legacy,
    ) ||
    !same(
      nodes.map((n) => [n.id, n.name, Number(n.x), Number(n.y), n.zone_id]),
      [
        ...legacy.map((z) => [...z, z[0]]),
        [7, "银杏路口", 420, 400, null],
        [8, "湖畔绿道", 730, 460, null],
      ],
    ) ||
    !same(
      edges.map((e) => [e.from_node_id, e.to_node_id]),
      expectedEdges,
    )
  )
    throw new Error(
      "Refusing to overwrite a customized map; explicit mapping required.",
    );
  for (const z of campus.zones)
    await c.query(
      "UPDATE parking_zones SET name=?,location=?,x=?,y=?,radius=35 WHERE id=?",
      [z.name, z.location, z.x, z.y, z.id],
    );
  // No other tables reference road_edges. Zone IDs and all settled ledgers remain intact.
  await c.query(
    "DELETE FROM road_edges WHERE from_node_id BETWEEN 1 AND 8 AND to_node_id BETWEEN 1 AND 8",
  );
  await installCampusRoads(c);
  return true;
}
