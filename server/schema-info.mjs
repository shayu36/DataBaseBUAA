import { readFile } from "node:fs/promises";
const descriptions = {
  users: ["用户", "共享单车服务使用者及登录身份"],
  bikes: ["单车", "车辆投放、状态及当前停车区"],
  parking_zones: ["停车区", "容量和本地坐标电子围栏"],
  ride_orders: ["骑行订单", "一次借车到归还的业务记录"],
  payments: ["支付记录", "每单最多一条模拟成功支付"],
  staff: ["运维人员", "调度与维修人员档案"],
  dispatch_tasks: ["调度任务", "批量车辆搬运及执行状态"],
  maintenance_tickets: ["维修工单", "报修到维修完成的记录"],
  dispatch_bikes: ["调度车辆明细", "实现调度任务与单车的多对多联系"],
  zone_snapshots: ["库存快照", "定时采样用于缺车满车时长估算"],
  return_attempts: ["违规还车尝试", "围栏和容量校验失败留痕"],
  road_nodes: ["路网节点", "校园示意路网节点"],
  road_edges: ["道路边", "距离、安全、舒适权重"],
  carbon_ledger: ["碳积分流水", "已支付订单模拟减排及积分"],
  audit_logs: ["操作审计", "关键业务变更记录"],
  system_settings: ["系统参数", "种子标记及可审计规则"],
};
export const relationships = [
  ["创建订单", "users", "ride_orders", "1:N", "用户可以创建多笔订单"],
  ["使用车辆", "bikes", "ride_orders", "1:N", "单车在不同时间对应多笔订单"],
  [
    "当前停放",
    "parking_zones",
    "bikes",
    "1:N",
    "骑行或运输中车辆的当前停车区可空",
  ],
  [
    "骑行起点 / 终点",
    "parking_zones",
    "ride_orders",
    "两个 1:N",
    "借车点与还车点分别关联",
  ],
  [
    "支付结算",
    "ride_orders",
    "payments",
    "1:0..1",
    "每笔订单最多一条成功支付记录",
  ],
  ["执行调度", "staff", "dispatch_tasks", "1:N", "待分配任务的执行人员可空"],
  [
    "调出 / 调入",
    "parking_zones",
    "dispatch_tasks",
    "两个 1:N",
    "来源与目标分别关联",
  ],
  ["包含车辆", "dispatch_tasks", "bikes", "M:N", "通过 dispatch_bikes 实现"],
  ["提交报修", "users", "maintenance_tickets", "1:N", "用户可以提交多张工单"],
  [
    "发生故障",
    "bikes",
    "maintenance_tickets",
    "1:N",
    "同车不同时期可发生多次故障",
  ],
  [
    "负责维修",
    "staff",
    "maintenance_tickets",
    "1:N",
    "待分配工单的维修人员可空",
  ],
].map(([name, from, to, cardinality, description]) => ({
  name,
  from,
  to,
  cardinality,
  description,
}));
export async function schemaInfo(pool) {
  const [columns] = await pool.query(
    "SELECT TABLE_NAME table_name,COLUMN_NAME name,COLUMN_TYPE type,COLUMN_KEY col_key,IS_NULLABLE nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY ORDINAL_POSITION",
  );
  const entities = [];
  for (const [table, [name, description]] of Object.entries(descriptions)) {
    const [[{ count }]] = await pool.query(
      "SELECT COUNT(*) count FROM " + table,
    );
    entities.push({
      table,
      name,
      description,
      count,
      columns: columns
        .filter((c) => c.table_name === table)
        .map((c) => ({
          name: c.name,
          type: c.type,
          key: c.col_key,
          nullable: c.nullable === "YES",
        })),
    });
  }
  const [v] = await pool.query(
    "SELECT TABLE_NAME name FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE()",
  );
  const [t] = await pool.query(
    "SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE()",
  );
  const [p] = await pool.query(
    "SELECT ROUTINE_NAME name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE()",
  );
  let triggers = t.map((x) => x.name),
    source = "live information_schema";
  // Runtime user lacks TRIGGER permission. The verified installation catalogue
  // makes metadata visible without giving the HTTP app administrative access.
  if (!triggers.length) {
    const snapshot = JSON.parse(
      await readFile(new URL("./schema-objects.json", import.meta.url), "utf8"),
    );
    const [[{ name }]] = await pool.query("SELECT DATABASE() name");
    if (snapshot.database === name) {
      triggers = snapshot.triggers;
      source =
        "live columns/views/procedures; trigger catalogue verified at " +
        snapshot.generated_at;
    }
  }
  return {
    entities,
    relationships,
    object_catalogue_source: source,
    objects: {
      views: v.map((x) => x.name),
      triggers,
      procedures: p.map((x) => x.name),
    },
  };
}
