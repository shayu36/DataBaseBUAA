import { cloneElement, isValidElement } from "react";
import { Leaf, ArrowUpRight } from "lucide-react";
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
export { CampusMap } from "./CampusMap";
