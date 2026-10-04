import { cloneElement, isValidElement, useEffect, useState } from "react";
import { Bike, MapPin, Leaf, ArrowUpRight } from "lucide-react";
import type { Row } from "./types";
export const money = (v: number) => "¥" + (Number(v || 0) / 100).toFixed(2);
export const date = (v: string) =>
  v ? new Date(v).toLocaleString("zh-CN") : "—";
const labels: Record<string, string> = {
  AVAILABLE: "可借用",
  RUNNING: "骑行中",
  UNPAID: "待支付",
  PAID: "已支付",
  PENDING: "待处理",
  IN_PROGRESS: "执行中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  MAINTENANCE: "维修中",
  DISPATCHING: "调度中",
  RETIRED: "已退役",
  ACTIVE: "启用",
  CLOSED: "关闭",
  SUSPENDED: "已停用",
  OPEN: "待分配",
  ASSIGNED: "已分配",
};
export function Badge({ value }: { value: string }) {
  return <span className={"badge s-" + value}>{labels[value] || value}</span>;
}
export function Empty({ text = "暂无记录" }: { text?: string }) {
  return (
    <div className="empty">
      <Leaf size={28} />
      <p>{text}</p>
    </div>
  );
}
export function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail: string;
}) {
  return (
    <article className="stat">
      <span>
        {label}
        <ArrowUpRight size={16} />
      </span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {isValidElement(children)
        ? cloneElement(children as React.ReactElement<any>, {
            "aria-label": label,
          })
        : children}
    </label>
  );
}
export function Table({
  rows,
  columns,
}: {
  rows: Row[];
  columns: { label: string; render: (r: Row) => React.ReactNode }[];
}) {
  return rows.length ? (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i}>
              {columns.map((c) => (
                <td key={c.label}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <Empty />
  );
}
export function CampusMap({
  zones,
  bikes,
  onSelect,
  onPoint,
  route,
}: {
  zones: Row[];
  bikes: Row[];
  onSelect?: (z: Row) => void;
  onPoint?: (x: number, y: number) => void;
  route?: any;
}) {
  const [selected, setSelected] = useState<number>();
  const maxX = Math.max(
    1000,
    ...zones.map((z) => Number(z.x) + Number(z.radius) + 100),
  );
  const maxY = Math.max(
    700,
    ...zones.map((z) => Number(z.y) + Number(z.radius) + 100),
  );
  const nodes = route?.nodes || [];
  const points = (route?.path || [])
    .map((id: number) => nodes.find((n: Row) => n.id === id))
    .filter(Boolean)
    .map((n: Row) => n.x + "," + n.y)
    .join(" ");
  useEffect(() => setSelected(undefined), [zones.length]);
  return (
    <div className="map-shell">
      <div className="map-title">
        <span>
          <MapPin size={16} /> 校园出行地图
        </span>
        <span className="map-live">本地米制示意图</span>
      </div>
      <svg
        role="group"
        aria-label="校园停车区地图，点击站点选择，点击空白设置归还坐标"
        viewBox={"0 0 " + maxX + " " + maxY}
        onClick={(e) => {
          const p = e.currentTarget.createSVGPoint();
          p.x = e.clientX;
          p.y = e.clientY;
          const m = e.currentTarget.getScreenCTM();
          if (m) {
            const c = p.matrixTransform(m.inverse());
            onPoint?.(Math.round(c.x), Math.round(c.y));
          }
        }}
      >
        <defs>
          <pattern
            id="grid"
            width="40"
            height="40"
            patternUnits="userSpaceOnUse"
          >
            <path d="M40 0H0V40" fill="none" stroke="#dbe5d8" strokeWidth="1" />
          </pattern>
        </defs>
        <rect width={maxX} height={maxY} fill="#eaf0e3" />
        <rect width={maxX} height={maxY} fill="url(#grid)" />
        <path
          d={
            "M0 " +
            maxY * 0.5 +
            " Q " +
            maxX * 0.3 +
            " " +
            maxY * 0.4 +
            " " +
            maxX +
            " " +
            maxY * 0.6 +
            " M" +
            maxX * 0.45 +
            " 0 L" +
            maxX * 0.5 +
            " " +
            maxY
          }
          fill="none"
          stroke="#fffdf3"
          strokeWidth="32"
        />
        <path
          d={
            "M0 " +
            maxY * 0.5 +
            " Q " +
            maxX * 0.3 +
            " " +
            maxY * 0.4 +
            " " +
            maxX +
            " " +
            maxY * 0.6 +
            " M" +
            maxX * 0.45 +
            " 0 L" +
            maxX * 0.5 +
            " " +
            maxY
          }
          fill="none"
          stroke="#d2d6c8"
          strokeWidth="2"
          strokeDasharray="7 7"
        />
        <ellipse
          cx={maxX * 0.79}
          cy={maxY * 0.23}
          rx={maxX * 0.14}
          ry={maxY * 0.13}
          fill="#c9ded9"
        />
        <text x={maxX * 0.76} y={maxY * 0.23} fill="#66857b" fontSize="16">
          静心湖
        </text>
        {[
          { x: 0.15, y: 0.14, t: "教学园区" },
          { x: 0.62, y: 0.72, t: "学生生活区" },
          { x: 0.12, y: 0.76, t: "运动场" },
        ].map((b) => (
          <g key={b.t}>
            <rect
              x={maxX * b.x}
              y={maxY * b.y}
              width="130"
              height="68"
              rx="10"
              fill="#dedccb"
              stroke="#cecbb9"
            />
            <text
              x={maxX * b.x + 18}
              y={maxY * b.y + 40}
              fontSize="16"
              fill="#7b7d6b"
            >
              {b.t}
            </text>
          </g>
        ))}
        {route?.edges?.map((edge: Row) => {
          const a = nodes.find((n: Row) => n.id === edge.from_node_id),
            b = nodes.find((n: Row) => n.id === edge.to_node_id);
          return a && b ? (
            <line
              key={edge.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="#bfcfbd"
              strokeWidth="4"
            />
          ) : null;
        })}
        {points && (
          <polyline
            points={points}
            fill="none"
            stroke="#e49b35"
            strokeWidth="9"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        {zones.map((z) => (
          <g
            key={z.id}
            tabIndex={0}
            role="button"
            aria-label={z.name + "，可借 " + z.available + " 辆"}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSelected(z.id);
                onSelect?.(z);
              }
            }}
            onClick={(e) => {
              e.stopPropagation();
              setSelected(z.id);
              onSelect?.(z);
            }}
          >
            <circle
              cx={z.x}
              cy={z.y}
              r={z.radius}
              fill={selected === z.id ? "#b6d6b3" : "#c7dfbf"}
              fillOpacity=".5"
              stroke="#719976"
              strokeDasharray="5 5"
            />
            <circle
              cx={z.x}
              cy={z.y}
              r="19"
              fill={z.status === "CLOSED" ? "#8a9289" : "#225b43"}
            />
            <text
              x={z.x}
              y={Number(z.y) + 6}
              textAnchor="middle"
              fontSize="16"
              fill="white"
            >
              {z.available}
            </text>
            <rect
              x={Number(z.x) - 65}
              y={Number(z.y) + 28}
              width="130"
              height="26"
              rx="6"
              fill="#fffff5"
            />
            <text
              x={z.x}
              y={Number(z.y) + 46}
              textAnchor="middle"
              fontSize="13"
              fill="#234c3b"
            >
              {z.name}
            </text>
          </g>
        ))}
      </svg>
      <div className="map-legend">
        <span>
          <i /> 停车区电子围栏
        </span>
        <span>
          <Bike size={15} />{" "}
          {bikes.filter((b) => b.status === "AVAILABLE").length} 辆可借
        </span>
        <span>点击空白位置设定坐标 · 单位：米</span>
      </div>
    </div>
  );
}
