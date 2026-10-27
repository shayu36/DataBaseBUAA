import { readFile } from "node:fs/promises";
import { sql } from "./sql-statements.mjs";
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
  carbon_transactions: ["碳积分流水", "发放与调整组成的追加式积分账本"],
  dispatch_suggestions: ["调度建议", "供需分析依据、状态及正式任务来源"],
  risk_alerts: ["风险预警", "版本化车辆风险原因及处置记录"],
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
  const [columns] = await pool.query(sql("metadata_columns"));
  const [countsResult] = await pool.query("CALL sp_schema_counts()");
  const counts = new Map(
    countsResult[0].map((row) => [row.table_name, row.row_count]),
  );
  const columnsByTable = new Map();
  for (const column of columns) {
    const group = columnsByTable.get(column.table_name) || [];
    group.push({
      name: column.name,
      type: column.type,
      key: column.col_key,
      nullable: column.nullable === "YES",
    });
    columnsByTable.set(column.table_name, group);
  }
  const entities = Object.entries(descriptions).map(
    ([table, [name, description]]) => ({
      table,
      name,
      description,
      count: counts.get(table),
      columns: columnsByTable.get(table) || [],
    }),
  );
  const [v] = await pool.query(sql("metadata_views"));
  const [t] = await pool.query(sql("metadata_triggers"));
  const [p] = await pool.query(sql("metadata_routines"));
  let triggers = t.map((x) => x.name),
    source = "live information_schema";
  // Runtime user lacks TRIGGER permission. The verified installation catalogue
  // makes metadata visible without giving the HTTP app administrative access.
  if (!triggers.length) {
    const catalogue = new URL(
      "../.runtime/schema-objects.json",
      import.meta.url,
    );
    const text = await readFile(catalogue, "utf8").catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const snapshot = text ? JSON.parse(text) : null;
    const [[{ name }]] = await pool.query(sql("current_database"));
    if (snapshot?.database === name) {
      triggers = snapshot.triggers;
      source =
        "live columns/views/procedures; trigger catalogue verified at " +
        snapshot.generated_at;
    } else {
      source = "live columns/views/procedures; trigger catalogue unavailable";
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
