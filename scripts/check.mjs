import { createPool } from "../server/db.mjs";
const pool = createPool(
  process.argv[2]
    ? {
        database: process.argv[2],
        user: process.env.DB_ADMIN_USER,
        password: process.env.DB_ADMIN_PASSWORD,
      }
    : {},
);
const checks = [
  [
    "停车区占用及预留不超容",
    "SELECT COUNT(*) errors FROM v_zone_inventory WHERE occupied+reserved>capacity OR available>occupied",
  ],
  [
    "骑行订单与车辆状态一一对应",
    "SELECT COUNT(*) errors FROM bikes b WHERE (b.status='RIDING')<>(EXISTS(SELECT 1 FROM ride_orders r WHERE r.bike_id=b.id AND r.status='RUNNING')) OR (b.status='RIDING' AND b.current_zone_id IS NOT NULL)",
  ],
  [
    "可借车辆都有停车区且没有开放维修单",
    "SELECT COUNT(*) errors FROM bikes b WHERE status='AVAILABLE' AND (current_zone_id IS NULL OR EXISTS(SELECT 1 FROM maintenance_tickets t WHERE t.bike_id=b.id AND t.status<>'COMPLETED'))",
  ],
  [
    "成功支付与订单状态金额一致",
    "SELECT COUNT(*) errors FROM ride_orders r LEFT JOIN payments p ON p.order_id=r.id WHERE (r.status='PAID')<>(p.id IS NOT NULL) OR (p.id IS NOT NULL AND p.amount_cents<>r.amount_cents)",
  ],
  [
    "积分只授予成功支付订单且符合里程规则",
    "SELECT COUNT(*) errors FROM ride_orders r LEFT JOIN carbon_ledger c ON c.order_id=r.id WHERE (r.status='PAID')<>(c.id IS NOT NULL) OR (c.id IS NOT NULL AND (c.distance_m<>r.distance_m OR c.points<>FLOOR(r.distance_m/100) OR c.carbon_kg<>ROUND(r.distance_m*0.00021,4)))",
  ],
  [
    "调度车辆只属于一个未完成任务",
    "SELECT COUNT(*) errors FROM (SELECT d.bike_id FROM dispatch_bikes d JOIN dispatch_tasks t ON t.id=d.task_id WHERE t.status IN ('PENDING','IN_PROGRESS') GROUP BY d.bike_id HAVING COUNT(*)>1) x",
  ],
  [
    "调度状态与车辆位置一致",
    "SELECT COUNT(*) errors FROM dispatch_tasks t JOIN dispatch_bikes d ON d.task_id=t.id JOIN bikes b ON b.id=d.bike_id WHERE t.status IN ('PENDING','IN_PROGRESS') AND (b.status<>'DISPATCHING' OR (t.status='PENDING' AND NOT(b.current_zone_id<=>t.source_zone_id)) OR (t.status='IN_PROGRESS' AND b.current_zone_id IS NOT NULL))",
  ],
  [
    "调度中车辆有对应活动任务",
    "SELECT COUNT(*) errors FROM bikes b WHERE b.status='DISPATCHING' AND NOT EXISTS(SELECT 1 FROM dispatch_bikes d JOIN dispatch_tasks t ON t.id=d.task_id WHERE d.bike_id=b.id AND t.status IN ('PENDING','IN_PROGRESS'))",
  ],
  [
    "维修状态与开放工单相符",
    "SELECT COUNT(*) errors FROM bikes b WHERE (b.status='MAINTENANCE' AND NOT EXISTS(SELECT 1 FROM maintenance_tickets t WHERE t.bike_id=b.id AND t.status<>'COMPLETED')) OR (EXISTS(SELECT 1 FROM maintenance_tickets t WHERE t.bike_id=b.id AND t.status<>'COMPLETED') AND b.status NOT IN ('MAINTENANCE','RIDING'))",
  ],
  [
    "所有调度任务有车辆明细",
    "SELECT COUNT(*) errors FROM dispatch_tasks t WHERE NOT EXISTS(SELECT 1 FROM dispatch_bikes d WHERE d.task_id=t.id)",
  ],
];
const c = await pool.getConnection();
try {
  await c.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
  let errors = 0;
  for (const [name, sql] of checks) {
    const [[r]] = await c.query(sql);
    errors += Number(r.errors);
    console.log((r.errors === 0 ? "PASS " : "FAIL ") + name + ": " + r.errors);
  }
  const [[totals]] = await c.query(
    "SELECT DATABASE() db,(SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM bikes) bikes,(SELECT COUNT(*) FROM ride_orders) rides,(SELECT COUNT(*) FROM payments) payments",
  );
  console.log(JSON.stringify(totals));
  await c.commit();
  if (errors) process.exitCode = 1;
} finally {
  c.release();
  await pool.end();
}
