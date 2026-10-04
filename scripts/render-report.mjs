import { readFile, writeFile } from "node:fs/promises";
import { marked } from "marked";
const docs = new URL("../docs/", import.meta.url);
const boxes = [
  [
    80,
    150,
    "用户",
    "users",
    ["PK id · UK email / phone", "账户昵称 · 角色 · 状态"],
  ],
  [
    650,
    150,
    "骑行订单",
    "ride_orders",
    [
      "PK id · FK user / bike",
      "FK start_zone / end_zone",
      "费用分 · 估算里程 · 状态",
    ],
  ],
  [
    1220,
    150,
    "支付记录",
    "payments",
    ["PK id · UK order_id", "UK idempotency_key", "金额分 · SIMULATED"],
  ],
  [
    80,
    580,
    "自行车",
    "bikes",
    ["PK id · UK code", "FK current_zone_id（可空）", "状态 · 投放 / 维修时间"],
  ],
  [
    650,
    580,
    "停车区",
    "parking_zones",
    ["PK id · UK name", "圆心 x / y · radius", "capacity · status"],
  ],
  [
    1220,
    580,
    "调度任务",
    "dispatch_tasks",
    [
      "PK id · FK staff_id（可空）",
      "FK source_zone / target_zone",
      "状态 · 创建 / 执行时间",
    ],
  ],
  [
    80,
    1010,
    "维修工单",
    "maintenance_tickets",
    ["PK id · FK bike / reporter", "FK staff_id（可空）", "故障 · 结果 · 状态"],
  ],
  [
    1220,
    1010,
    "运维人员",
    "staff",
    ["PK id · UK/FK user_id", "同步姓名 · 联系电话", "工种 · 值勤状态"],
  ],
];
// Separate routed edges retain dual-role relationships. Labels include minimum participation.
const edges = [
  ["M380 190H650", 515, 180, "创建订单 1 : N"],
  ["M190 580V460H695V330", 425, 452, "使用车辆 1 : N"],
  ["M650 630H380", 515, 620, "当前停放 0..1 : N"],
  ["M740 580V330", 735, 420, "骑行起点 1 : N"],
  ["M870 580V330", 875, 500, "骑行终点 0..1 : N"],
  ["M950 210H1220", 1085, 200, "支付结算 1 : 0..1"],
  ["M1320 1010V760", 1320, 885, "执行调度 0..1 : N"],
  ["M950 620H1220", 1085, 610, "调出 1 : N"],
  ["M950 700H1220", 1085, 690, "调入 1 : N"],
  ["M1220 740H1080V835H230V760", 670, 825, "包含车辆 M : N · dispatch_bikes"],
  ["M80 240H35V1080H80", 35, 940, "提交报修 1 : N"],
  ["M230 760V1010", 230, 895, "发生故障 1 : N"],
  ["M1220 1090H380", 800, 1080, "负责维修 0..1 : N"],
];
const escape = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1340" viewBox="0 0 1600 1340" role="img" aria-labelledby="title desc"><title id="title">青行校园共享自行车：八实体、十一项命名联系、十三条角色边</title><desc id="desc">用户创建骑行订单，订单使用自行车，车辆当前停放停车区；订单分别有骑行起点和终点，且最多一笔支付。运维执行调度，停车区分别调出和调入，调度包含多辆车并通过关联表表达多对多。用户提交报修，车辆发生故障，运维负责维修。运行中车辆位置与结束站、待分配员工可空。</desc><style>text{font-family:'Microsoft YaHei','Segoe UI',sans-serif}.edge{fill:none;stroke:#63948d;stroke-width:2.5;stroke-linejoin:round}.label{font-size:17px;fill:#215b51;font-weight:600;paint-order:stroke;stroke:#f3f8f7;stroke-width:10px;stroke-linejoin:round}.field{font-size:16px;fill:#45616b}</style><rect width="1600" height="1340" fill="#f3f8f7"/><text x="80" y="60" font-size="32" font-weight="700" fill="#153d39">青行 Qingxing · 校园共享自行车 E-R 图</text><text x="80" y="97" font-size="19" fill="#55766e">8 核心实体 / 11 命名联系 / 13 角色边 · 16 物理表 = 8 + 1 关联 + 7 支持</text>${edges.map(([path]) => `<path d="${path}" class="edge"/>`).join("")}${edges.map(([, x, y, label]) => `<text x="${x}" y="${y}" text-anchor="middle" class="label" ${label.startsWith("提交报修") ? `transform="rotate(-90 ${x} ${y})"` : ""}>${escape(label)}</text>`).join("")}${boxes.map(([x, y, title, name, fields]) => `<g><rect x="${x}" y="${y}" width="300" height="180" rx="14" fill="white" stroke="#bbd2ce" stroke-width="1.5"/><rect x="${x}" y="${y}" width="300" height="54" rx="14" fill="#174940"/><rect x="${x}" y="${y + 30}" width="300" height="24" fill="#174940"/><text x="${x + 18}" y="${y + 35}" font-size="22" fill="white" font-weight="700">${title}</text><text x="${x + 18}" y="${y + 80}" font-size="17" fill="#258974">${name}</text>${fields.map((f, i) => `<text x="${x + 18}" y="${y + 108 + i * 27}" class="field">${escape(f)}</text>`).join("")}</g>`).join("")}<rect x="80" y="1230" width="1440" height="82" rx="12" fill="#e3eeea"/><text x="100" y="1260" font-size="17" fill="#355d53">PK 主键 · FK 外键 · UK 非空唯一键；0..1 表示子记录可以暂未关联父端，N 端可没有历史记录。</text><text x="100" y="1290" font-size="17" fill="#355d53">起点 / 终点、调出 / 调入分别为两条边；账户绑定与支持表外键见完整报告；可空 UNIQUE 不等于全表候选码。</text></svg>`;
await writeFile(new URL("ER图.svg", docs), svg);
const markdown = await readFile(new URL("数据库课程设计报告.md", docs), "utf8");
let html = await marked.parse(markdown);
// Embed the local SVG; the resulting printable report does not depend on external assets.
html = html.replace(
  /<img[^>]*src="ER图\.svg"[^>]*>/g,
  `<figure aria-label="实体关系图">${svg}</figure>`,
);
let section = 0;
const toc = [];
html = html.replace(/<h([123])>(.*?)<\/h\1>/g, (_, level, title) => {
  const id = `section-${++section}`;
  if (level === "2") toc.push(`<a href="#${id}">${title}</a>`);
  return `<h${level} id="${id}">${title}</h${level}>`;
});
const page = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>青行 Qingxing · 数据库课程设计报告</title><style>*{box-sizing:border-box}body{margin:0;background:#edf4f1;color:#213d37;font:15px/1.85 'Microsoft YaHei','Segoe UI',sans-serif}aside{position:fixed;inset:0 auto 0 0;width:260px;padding:30px 24px;background:#174940;overflow:auto;color:#d8ebe2}aside strong{display:block;font-size:24px;margin-bottom:24px}aside a{display:block;color:inherit;text-decoration:none;font-size:12px;padding:7px 0}main{margin:35px 35px 35px 295px;padding:50px;background:white;max-width:1150px;border-top:5px solid #58a98b}h1{font-size:30px}h2{margin-top:42px;padding-top:20px;border-top:1px solid #d5e4df;color:#174940}h3{color:#34775f}table{width:100%;border-collapse:collapse;font-size:12px;margin:20px 0}th,td{border:1px solid #d4e2dc;padding:8px;text-align:left;overflow-wrap:anywhere}th{background:#eaf3ee}pre{background:#eff5f2;padding:18px;overflow:auto;white-space:pre-wrap;font:12px/1.7 Consolas,monospace}code{font-family:Consolas,monospace;font-size:.9em}figure{margin:20px 0}svg{display:block;width:100%;height:auto}a{color:#227257}.print{position:fixed;right:25px;bottom:25px;padding:12px 20px;border:0;border-radius:8px;background:#174940;color:white;cursor:pointer}@media(max-width:1050px){aside{display:none}main{margin:15px;padding:25px}table{display:block;overflow:auto}}@media print{@page{size:A4;margin:16mm}body{background:white;font-size:10pt}aside,.print{display:none}main{margin:0;padding:0;max-width:none;border:0}h1{font-size:22pt}h2{font-size:16pt;break-after:avoid}h3{break-after:avoid}table{font-size:8pt}tr{break-inside:avoid}figure{break-before:page;break-after:page}svg{max-height:250mm}pre{font-size:8pt}a{color:inherit;text-decoration:none}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body><aside><strong>青行 Qingxing</strong>${toc.join("")}</aside><main>${html}</main><button class="print" onclick="window.print()">打印报告</button></body></html>`;
await writeFile(new URL("数据库课程设计报告.html", docs), page);
console.log(
  "Rendered docs/ER图.svg and docs/数据库课程设计报告.html (embedded SVG, no PDF)",
);
