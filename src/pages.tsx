import { useEffect, useState } from "react";
import { Bike } from "lucide-react";
import { api } from "./api";
import {
  Badge,
  CampusMap,
  Empty,
  Field,
  Stat,
  Table,
  date,
  money,
} from "./components";
import type { Dashboard, Row, User } from "./types";
type Props = {
  d: Dashboard;
  user: User;
  run: (path: string, body: any) => Promise<boolean>;
};
export function Overview({ d }: Props) {
  return (
    <>
      <div className="hero">
        <div>
          <span className="eyebrow">BEIHANG · XUEYUAN ROAD CAMPUS</span>
          <h2>
            风经过校园，
            <br />
            也经过你的每一程。
          </h2>
          <p>从北航主楼到新主楼，在学院路校区找到附近的自行车。</p>
          <span className="hero-tag">学院路校区 · 绿色出行从青行开始 ↗</span>
        </div>
        <div className="hero-bike">
          <Bike size={190} strokeWidth={1.1} />
          <span>
            QINGXING
            <br />
            CAMPUS CYCLING
          </span>
        </div>
      </div>
      <div className="stats">
        <Stat
          label="可用自行车"
          value={d.summary.available_bikes}
          detail={"全校共 " + d.summary.total_bikes + " 辆"}
        />
        <Stat
          label="今日骑行"
          value={d.summary.today_rides}
          detail={"当前 " + d.summary.active_rides + " 人正在骑行"}
        />
        <Stat
          label="累计模拟减排"
          value={Number(d.summary.carbon_kg).toFixed(2) + " kg"}
          detail="基于已支付行程估算"
        />
        <Stat
          label="待处理报修"
          value={d.summary.open_tickets}
          detail="维护让每一程更安心"
        />
      </div>
      <div className="overview-grid">
        <CampusMap zones={d.zones} bikes={d.bikes} />
        <section className="panel">
          <div className="section-head">
            <h2>停车区一览</h2>
            <span>{d.zones.length} 个站点</span>
          </div>
          {d.zones.map((z) => (
            <div className="zone-card" key={z.id}>
              <div>
                <strong>{z.name}</strong>
                <small>{z.location}</small>
              </div>
              <b>
                {z.available}
                <small>辆可借</small>
              </b>
              <div className="capacity">
                <i
                  style={{
                    width: Math.min(100, (z.occupied / z.capacity) * 100) + "%",
                  }}
                />
              </div>
              <small>
                {z.occupied}/{z.capacity} 已占用 · {z.reserved} 预留
              </small>
            </div>
          ))}
        </section>
      </div>
    </>
  );
}
export function Rides({ d, run }: Props) {
  const [zone, setZone] = useState(d.zones[0]?.id || 0),
    [x, setX] = useState(d.zones[0]?.x || 0),
    [y, setY] = useState(d.zones[0]?.y || 0),
    [mode, setMode] = useState("shortest");
  const active = d.rides.find((r) => r.status === "RUNNING");
  return (
    <>
      <div className="two-col">
        <section className="panel">
          <h2>选择一辆，开始出发</h2>
          <p className="muted">
            每开始 30 分钟 ¥1.00，最低 ¥1.00。里程由服务器路网估算。
          </p>
          <div className="bike-grid">
            {d.bikes
              .filter((b) => b.status === "AVAILABLE")
              .map((b) => (
                <article className="bike-card" key={b.id}>
                  <span className="bike-symbol">🚲</span>
                  <strong>{b.code}</strong>
                  <small>{b.zone_name}</small>
                  <button
                    disabled={!!active}
                    onClick={() => run("/rides/start", { bike_id: b.id })}
                  >
                    借用自行车 ↗
                  </button>
                </article>
              ))}
          </div>
        </section>
        <section className="panel">
          <h2>归还到停车区</h2>
          {active ? (
            <p className="notice">
              正在骑行 {active.bike_code} · {date(active.started_at)}
            </p>
          ) : (
            <p className="muted">
              借车后可在这里结束行程。点击地图站点会填入站点中心坐标。
            </p>
          )}
          <Field label="归还停车区">
            <select
              value={zone}
              onChange={(e) => {
                const z = d.zones.find((z) => z.id === Number(e.target.value));
                if (z) {
                  setZone(z.id);
                  setX(z.x);
                  setY(z.y);
                }
              }}
            >
              {d.zones.map((z) => (
                <option key={z.id} value={z.id}>
                  {z.name}（空位{" "}
                  {Math.max(0, z.capacity - z.occupied - z.reserved)}）
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label="归还横坐标（米）">
              <input
                type="number"
                value={x}
                onChange={(e) => setX(Number(e.target.value))}
              />
            </Field>
            <Field label="归还纵坐标（米）">
              <input
                type="number"
                value={y}
                onChange={(e) => setY(Number(e.target.value))}
              />
            </Field>
          </div>
          <Field label="行程路线偏好">
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="shortest">最短路线</option>
              <option value="safe">安全优先</option>
              <option value="comfortable">舒适优先</option>
            </select>
          </Field>
          <p className="muted">
            圈外或车位已满时，服务器会记录尝试并保留骑行订单，请重新选择停车位置。
          </p>
          <button
            disabled={!active}
            onClick={() =>
              active &&
              run("/rides/" + active.id + "/return", {
                zone_id: zone,
                x,
                y,
                route_mode: mode,
              })
            }
          >
            确认归还
          </button>
        </section>
      </div>
      <CampusMap
        zones={d.zones}
        bikes={d.bikes}
        onSelect={(z) => {
          setZone(z.id);
          setX(z.x);
          setY(z.y);
        }}
        onPoint={(a, b) => {
          setX(a);
          setY(b);
        }}
      />
      <section className="panel">
        <h2>待支付订单</h2>
        {d.rides
          .filter((r) => r.status === "UNPAID")
          .map((r) => (
            <div className="list-row" key={r.id}>
              <span>
                订单 #{r.id} · {r.bike_code} · {money(r.amount_cents)}
              </span>
              <button
                onClick={() =>
                  run("/rides/" + r.id + "/pay", {
                    idempotency_key: "qingxing-order-" + r.id,
                  })
                }
              >
                模拟支付
              </button>
            </div>
          ))}
        {!d.rides.some((r) => r.status === "UNPAID") && (
          <Empty text="没有待支付订单" />
        )}
      </section>
    </>
  );
}
export function Orders({ d }: Props) {
  const [filter, setFilter] = useState("ALL");
  const rows = d.rides.filter((r) => filter === "ALL" || r.status === filter);
  function csv() {
    const keys = [
      "id",
      "bike_code",
      "start_zone_name",
      "end_zone_name",
      "status",
      "distance_m",
      "amount_cents",
    ];
    const safe = (v: any) => {
      const s = String(v ?? "");
      return (
        '"' + (/^[=+\-@]/.test(s) ? "'" + s : s).replaceAll('"', '""') + '"'
      );
    };
    const blob = new Blob(
      [
        "\ufeff" +
          [
            keys.join(","),
            ...rows.map((r) => keys.map((k) => safe(r[k])).join(",")),
          ].join("\r\n"),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "青行骑行订单.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <section className="panel">
      <div className="section-head">
        <h2>每一程，都有记录</h2>
        <div className="actions">
          <select
            aria-label="订单状态筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="ALL">全部状态</option>
            {["RUNNING", "UNPAID", "PAID"].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          <button className="secondary" onClick={csv}>
            导出 CSV
          </button>
        </div>
      </div>
      <Table
        rows={rows}
        columns={[
          {
            label: "订单 / 车辆",
            render: (r) => (
              <strong>
                #{r.id} · {r.bike_code}
              </strong>
            ),
          },
          {
            label: "起点 → 终点",
            render: (r) =>
              r.start_zone_name + " → " + (r.end_zone_name || "骑行中"),
          },
          { label: "开始时间", render: (r) => date(r.started_at) },
          {
            label: "估算里程",
            render: (r) =>
              (Number(r.distance_m || 0) / 1000).toFixed(2) + " km",
          },
          { label: "金额", render: (r) => money(r.amount_cents) },
          { label: "状态", render: (r) => <Badge value={r.status} /> },
        ]}
      />
      <h3>电子围栏归还尝试</h3>
      <Table
        rows={d.attempts}
        columns={[
          { label: "订单", render: (r) => "#" + r.order_id },
          { label: "坐标（米）", render: (r) => r.x + ", " + r.y },
          { label: "拒绝原因", render: (r) => r.reason },
          { label: "时间", render: (r) => date(r.created_at) },
        ]}
      />
    </section>
  );
}
export function Maintenance({ d, user, run }: Props) {
  const [bike, setBike] = useState(d.bikes[0]?.id || 0),
    [fault, setFault] = useState("BRAKE"),
    [desc, setDesc] = useState(""),
    [staff, setStaff] = useState(d.staff[0]?.id || 0),
    [result, setResult] = useState("");
  return (
    <>
      <section className="panel">
        <h2>发现问题，交给我们</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run("/maintenance", {
              bike_id: bike,
              fault_type: fault,
              description: desc,
            });
          }}
        >
          <div className="form-row">
            <Field label="车辆">
              <select
                value={bike}
                onChange={(e) => setBike(Number(e.target.value))}
              >
                {d.bikes.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.code}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="故障类型">
              <select value={fault} onChange={(e) => setFault(e.target.value)}>
                {Object.entries({
                  BRAKE: "刹车",
                  TIRE: "轮胎",
                  LOCK: "车锁",
                  CHAIN: "链条",
                  OTHER: "其他",
                }).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="问题描述">
            <textarea
              required
              minLength={3}
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              placeholder="请描述故障发生位置与具体情况"
            />
          </Field>
          <button>提交报修</button>
        </form>
      </section>
      <section className="panel">
        <h2>维护工单</h2>
        {user.role !== "STUDENT" && (
          <div className="form-row">
            <Field label="负责员工">
              <select
                value={staff}
                onChange={(e) => setStaff(Number(e.target.value))}
              >
                {d.staff
                  .filter((s) => s.job !== "DISPATCH")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="维修结果">
              <input
                value={result}
                onChange={(e) => setResult(e.target.value)}
                placeholder="完成前填写实际维修结果"
              />
            </Field>
          </div>
        )}
        <Table
          rows={d.tickets}
          columns={[
            {
              label: "车辆 / 故障",
              render: (r) => r.bike_code + " · " + r.fault_type,
            },
            { label: "描述", render: (r) => r.description },
            { label: "负责人", render: (r) => r.staff_name || "待分配" },
            { label: "状态", render: (r) => <Badge value={r.status} /> },
            {
              label: "结果 / 操作",
              render: (r) => (
                <div className="actions">
                  {r.result}
                  {user.role === "ADMIN" &&
                    !["COMPLETED", "CANCELLED"].includes(r.status) && (
                      <button
                        className="tiny"
                        onClick={() =>
                          run("/maintenance/" + r.id + "/assign", {
                            staff_id: staff,
                          })
                        }
                      >
                        分配
                      </button>
                    )}
                  {user.role !== "STUDENT" &&
                    r.staff_id &&
                    r.status !== "COMPLETED" && (
                      <button
                        className="tiny"
                        disabled={!result.trim()}
                        onClick={() =>
                          run("/maintenance/" + r.id + "/complete", { result })
                        }
                      >
                        完成维修
                      </button>
                    )}
                </div>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
export function Dispatch({ d, user, run }: Props) {
  const [source, setSource] = useState(d.zones[0]?.id || 0),
    [target, setTarget] = useState(d.zones[1]?.id || 0),
    [staff, setStaff] = useState(d.staff[0]?.id || 0),
    [selected, setSelected] = useState<number[]>([]);
  return (
    <>
      {user.role === "ADMIN" && (
        <section className="panel">
          <h2>创建调度任务</h2>
          <div className="form-row">
            {[
              ["来源停车区", source, setSource],
              ["目标停车区", target, setTarget],
            ].map(([label, val, set]: any) => (
              <Field key={label} label={label}>
                <select
                  value={val}
                  onChange={(e) => {
                    set(Number(e.target.value));
                    setSelected([]);
                  }}
                >
                  {d.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </Field>
            ))}
            <Field label="调度员工">
              <select
                value={staff}
                onChange={(e) => setStaff(Number(e.target.value))}
              >
                {d.staff
                  .filter((s) => s.job !== "MAINTENANCE")
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <div className="checkboxes">
            {d.bikes
              .filter(
                (b) => b.current_zone_id === source && b.status === "AVAILABLE",
              )
              .map((b) => (
                <label key={b.id}>
                  <input
                    type="checkbox"
                    checked={selected.includes(b.id)}
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, b.id]
                          : selected.filter((v) => v !== b.id),
                      )
                    }
                  />
                  {b.code}
                </label>
              ))}
          </div>
          <button
            disabled={!selected.length || source === target}
            onClick={() =>
              run("/dispatches", {
                source_zone_id: source,
                target_zone_id: target,
                staff_id: staff,
                bike_ids: selected,
              })
            }
          >
            确认调度 {selected.length} 辆
          </button>
        </section>
      )}
      <section className="panel">
        <h2>调度任务</h2>
        <Table
          rows={d.dispatches}
          columns={[
            { label: "任务", render: (r) => "#" + r.id },
            {
              label: "路径",
              render: (r) => r.source_name + " → " + r.target_name,
            },
            { label: "车辆", render: (r) => r.bike_ids.join(", ") },
            { label: "负责人", render: (r) => r.staff_name || "待分配" },
            { label: "状态", render: (r) => <Badge value={r.status} /> },
            {
              label: "操作",
              render: (r) => (
                <div className="actions">
                  {user.role === "ADMIN" && r.status === "PENDING" && (
                    <button
                      className="tiny"
                      onClick={() =>
                        run("/dispatches/" + r.id + "/assign", {
                          staff_id: staff,
                        })
                      }
                    >
                      分配员工
                    </button>
                  )}
                  {r.status === "PENDING" && (
                    <button
                      className="tiny"
                      onClick={() => run("/dispatches/" + r.id + "/start", {})}
                    >
                      开始执行
                    </button>
                  )}
                  {r.status === "IN_PROGRESS" && (
                    <button
                      className="tiny"
                      onClick={() =>
                        run("/dispatches/" + r.id + "/complete", {})
                      }
                    >
                      确认完成
                    </button>
                  )}
                  {user.role === "ADMIN" && r.status === "PENDING" && (
                    <button
                      className="tiny secondary"
                      onClick={() => run("/dispatches/" + r.id + "/cancel", {})}
                    >
                      取消
                    </button>
                  )}
                </div>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
export function Remote({
  path,
  children,
  refreshKey,
}: {
  path: string;
  children: (v: any) => React.ReactNode;
  refreshKey?: unknown;
}) {
  const [data, setData] = useState<any>(),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setData(undefined);
    setError("");
    api(path)
      .then((v) => {
        if (live) setData(v);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [path, refreshKey]);
  return error ? (
    <div className="error" role="alert">
      {error}
    </div>
  ) : data ? (
    children(data)
  ) : (
    <div className="loading">正在读取数据…</div>
  );
}
export function Analytics({ d, run }: Props) {
  const [days, setDays] = useState(7);
  return (
    <>
      <div className="toolbar">
        <p>演示历史＋运行期间每分钟实测快照；时长按有覆盖样本估算。</p>
        <select
          aria-label="统计周期"
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
        >
          <option value={7}>近 7 日</option>
          <option value={30}>近 30 日</option>
        </select>
      </div>
      <Remote path={"/analytics?days=" + days} refreshKey={d}>
        {(v) => (
          <>
            <section className="panel">
              <h2>借还车小时分布</h2>
              <p className="muted">北京时间 · {v.snapshot_count} 条库存快照</p>
              <div className="chart">
                {v.hourly.map((h: any) => (
                  <div
                    key={h.hour}
                    title={
                      h.hour +
                      "时：借 " +
                      h.borrow_count +
                      " / 还 " +
                      h.return_count
                    }
                  >
                    <div className="bars">
                      <i
                        style={{
                          height: Math.max(
                            2,
                            (h.borrow_count /
                              Math.max(
                                1,
                                ...v.hourly.map((x: any) =>
                                  Math.max(x.borrow_count, x.return_count),
                                ),
                              )) *
                              140,
                          ),
                        }}
                      />
                      <b
                        style={{
                          height: Math.max(
                            2,
                            (h.return_count /
                              Math.max(
                                1,
                                ...v.hourly.map((x: any) =>
                                  Math.max(x.borrow_count, x.return_count),
                                ),
                              )) *
                              140,
                          ),
                        }}
                      />
                    </div>
                    <small>{h.hour}</small>
                  </div>
                ))}
              </div>
              <p className="muted">深绿：借车 · 浅绿：还车</p>
            </section>
            <section className="panel">
              <h2>停车区热点与覆盖</h2>
              <Table
                rows={v.hotspots}
                columns={[
                  { label: "站点", render: (r) => r.name },
                  {
                    label: "借 / 还",
                    render: (r) => r.borrow_count + " / " + r.return_count,
                  },
                  {
                    label: "高峰小时",
                    render: (r) =>
                      r.peak_hour === null ? "无记录" : r.peak_hour + " 时",
                  },
                  {
                    label: "缺车 / 满车（分钟）",
                    render: (r) => r.shortage_minutes + " / " + r.full_minutes,
                  },
                  {
                    label: "采样覆盖（分钟）",
                    render: (r) => r.coverage_minutes,
                  },
                ]}
              />
              <p className="muted">
                只统计间隔不超过 5 分钟的相邻快照，缺失时段不视为正常。
              </p>
              <h3>工作日分布</h3>
              <Table
                rows={v.weekday}
                columns={[
                  {
                    label: "星期",
                    render: (r) =>
                      ["日", "一", "二", "三", "四", "五", "六"][r.weekday],
                  },
                  { label: "借车", render: (r) => r.borrow_count },
                  { label: "还车", render: (r) => r.return_count },
                ]}
              />
            </section>
            <section className="panel">
              <h2>智能调度建议</h2>
              {!v.suggestions.length && <Empty text="当前没有可执行调度建议" />}
              {v.suggestions.map((s: any, i: number) => (
                <div className="list-row" key={i}>
                  <div>
                    <strong>
                      {s.source_name} → {s.target_name} · {s.quantity} 辆
                    </strong>
                    <p className="muted">{s.reason}</p>
                  </div>
                  <button
                    onClick={() =>
                      run("/dispatches", {
                        source_zone_id: s.source_zone_id,
                        target_zone_id: s.target_zone_id,
                        bike_ids: d.bikes
                          .filter(
                            (b) =>
                              b.current_zone_id === s.source_zone_id &&
                              b.status === "AVAILABLE",
                          )
                          .slice(0, s.quantity)
                          .map((b) => b.id),
                      })
                    }
                  >
                    确认创建任务
                  </button>
                </div>
              ))}
            </section>
            <section className="panel">
              <h2>车辆风险预警</h2>
              <p className="muted">
                基于报修次数、复发类型与维修间隔的可解释规则，非学习模型。
              </p>
              <Table
                rows={v.risks}
                columns={[
                  { label: "车辆", render: (r) => r.code },
                  { label: "风险分", render: (r) => r.score },
                  { label: "等级", render: (r) => r.level },
                  {
                    label: "判定原因",
                    render: (r) => (
                      <ul>
                        {r.reasons.map((s: string) => (
                          <li key={s}>{s}</li>
                        ))}
                      </ul>
                    ),
                  },
                ]}
              />
            </section>
          </>
        )}
      </Remote>
    </>
  );
}
export function Routes({ d }: Props) {
  const [from, setFrom] = useState(d.zones[0]?.id || 0),
    [to, setTo] = useState(d.zones[1]?.id || 0),
    [mode, setMode] = useState("shortest");
  return (
    <>
      <section className="panel">
        <h2>选一条适合你的路</h2>
        <div className="form-row">
          {[
            ["出发停车区", from, setFrom],
            ["目的停车区", to, setTo],
          ].map(([label, val, set]: any) => (
            <Field key={label} label={label}>
              <select value={val} onChange={(e) => set(Number(e.target.value))}>
                {d.zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name}
                  </option>
                ))}
              </select>
            </Field>
          ))}
          <Field label="路线模式">
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="shortest">最短路线</option>
              <option value="safe">安全优先</option>
              <option value="comfortable">舒适优先</option>
            </select>
          </Field>
        </div>
      </section>
      <Remote
        path={"/routes?from=" + from + "&to=" + to + "&mode=" + mode}
        refreshKey={d}
      >
        {(v) => (
          <>
            <div className="route-result">
              <strong>{(v.distance_m / 1000).toFixed(2)} km</strong>
              <span>预计 {v.duration_minutes} 分钟 · Dijkstra 路网估算</span>
            </div>
            <CampusMap zones={d.zones} bikes={d.bikes} route={v} />
            <section className="panel">
              <h2>途经道路节点</h2>
              <p>
                {v.path
                  .map(
                    (id: number) =>
                      v.nodes.find((n: Row) => n.id === id)?.name || id,
                  )
                  .join(" → ")}
              </p>
            </section>
          </>
        )}
      </Remote>
    </>
  );
}
export function Carbon({ d }: Props) {
  const [period, setPeriod] = useState("week"),
    [metric, setMetric] = useState("points");
  return (
    <>
      <div className="hero carbon-hero">
        <div>
          <span className="eyebrow">EVERY RIDE COUNTS</span>
          <h2>
            把轻盈的足迹，
            <br />
            留给更绿的校园。
          </h2>
          <p>模拟减排系数 0.21 kg/km</p>
        </div>
        <strong>
          {d.carbon.points}
          <small>我的碳积分</small>
        </strong>
      </div>
      <div className="stats">
        <Stat
          label="累计模拟减排"
          value={Number(d.carbon.carbon_kg).toFixed(2) + " kg"}
          detail="仅已支付订单计入"
        />
        <Stat
          label="累计估算里程"
          value={(d.carbon.distance_m / 1000).toFixed(2) + " km"}
          detail="服务器路网估算"
        />
        <Stat
          label="绿色行程"
          value={d.carbon.entries.length}
          detail="每公里 10 分，取整"
        />
      </div>
      <section className="panel">
        <div className="section-head">
          <h2>校园绿色排行榜</h2>
          <div className="actions">
            <select
              aria-label="排行榜周期"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            >
              <option value="week">本周</option>
              <option value="month">本月</option>
            </select>
            <select
              aria-label="排行榜指标"
              value={metric}
              onChange={(e) => setMetric(e.target.value)}
            >
              <option value="points">积分</option>
              <option value="distance">里程</option>
              <option value="rides">骑行次数</option>
            </select>
          </div>
        </div>
        <Remote
          path={"/leaderboard?period=" + period + "&metric=" + metric}
          refreshKey={d}
        >
          {(v) => (
            <Table
              rows={v.rows}
              columns={[
                { label: "排名", render: (r) => "#" + r.rank },
                { label: "骑行者", render: (r) => r.name },
                { label: "次数", render: (r) => r.rides },
                {
                  label: "里程",
                  render: (r) => (r.distance_m / 1000).toFixed(2) + " km",
                },
                { label: "积分", render: (r) => r.points },
                {
                  label: "模拟减排",
                  render: (r) => Number(r.carbon_kg).toFixed(2) + " kg",
                },
              ]}
            />
          )}
        </Remote>
      </section>
      <section className="panel">
        <h2>我的碳积分账本</h2>
        <Table
          rows={d.carbon.entries}
          columns={[
            { label: "关联订单", render: (r) => "#" + r.order_id },
            { label: "积分", render: (r) => "+" + r.points },
            {
              label: "模拟减排",
              render: (r) => Number(r.carbon_kg).toFixed(2) + " kg",
            },
            { label: "记录时间", render: (r) => date(r.created_at) },
          ]}
        />
      </section>
    </>
  );
}
export function Schema() {
  return (
    <Remote path="/schema">
      {(v) => (
        <>
          <section className="panel">
            <div className="section-head">
              <h2>8 个核心实体，完整业务闭环</h2>
              <a
                className="button"
                href="/api/report"
                target="_blank"
                rel="noreferrer"
              >
                查看课程报告 ↗
              </a>
            </div>
            <p className="muted">
              用户、车辆、停车区、骑行订单、支付、员工、调度任务、维护工单。
            </p>
            <a href="/docs/ER图.svg" target="_blank" rel="noreferrer">
              打开完整 E-R 图 ↗
            </a>
            <div className="entity-grid">
              {v.entities.map((e: any) => (
                <article key={e.table}>
                  <strong>{e.name}</strong>
                  <code>{e.table}</code>
                  <p>{e.description}</p>
                  <small>{e.count} 条记录</small>
                  <details>
                    <summary>查看字段与约束</summary>
                    {e.columns.map((c: any) => (
                      <p key={c.name}>
                        <code>{c.name}</code> · {c.type} {c.key}{" "}
                        {c.nullable ? "可空" : "非空"}
                      </p>
                    ))}
                  </details>
                </article>
              ))}
            </div>
          </section>
          <section className="panel">
            <h2>核心关系</h2>
            <Table
              rows={v.relationships}
              columns={[
                { label: "联系", render: (r) => r.name },
                { label: "实体", render: (r) => r.from + " → " + r.to },
                { label: "基数", render: (r) => r.cardinality },
                { label: "业务语义", render: (r) => r.description },
              ]}
            />
            <h3>数据库对象</h3>
            {Object.entries(v.objects).map(([k, items]: any) => (
              <p key={k}>
                <strong>{k}</strong> · {items.join("、") || "无"}
              </p>
            ))}
          </section>
        </>
      )}
    </Remote>
  );
}
export function Admin({ d, run }: Props) {
  const [kind, setKind] = useState("zones"),
    [edit, setEdit] = useState<any>({});
  const [users, setUsers] = useState<Row[]>([]),
    [userError, setUserError] = useState("");
  useEffect(() => {
    api("/admin/users")
      .then((v) => {
        setUsers(v.users);
        setUserError("");
      })
      .catch((e) => setUserError(e.message));
  }, [d]);
  const fields =
    kind === "zones"
      ? ["name", "location", "x", "y", "radius", "capacity"]
      : kind === "bikes"
        ? ["code", "zone_id"]
        : ["name", "phone", "email", "password"];
  const defaults: any = {
    zones: { status: "ACTIVE", radius: 50, capacity: 20, x: 100, y: 100 },
    bikes: { status: "AVAILABLE", zone_id: d.zones[0]?.id },
    staff: { job: "BOTH", status: "ACTIVE" },
  };
  return (
    <>
      <section className="panel">
        <div className="tabs">
          {[
            ["zones", "停车区"],
            ["bikes", "车辆"],
            ["staff", "员工"],
          ].map(([k, v]) => (
            <button
              key={k}
              className={kind === k ? "" : "secondary"}
              onClick={() => {
                setKind(k);
                setEdit({});
              }}
            >
              {v}管理
            </button>
          ))}
        </div>
        <h2>{edit.id ? "编辑 #" + edit.id : "新增资料"}</h2>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const payload = { ...defaults[kind], ...edit };
            if (kind === "bikes" && payload.deployed_at) {
              payload.deployed_at = String(payload.deployed_at).slice(0, 10);
            }
            if (kind === "staff" && edit.id && !payload.password) {
              delete payload.password;
            }
            if (await run("/admin/" + kind, payload)) setEdit({});
          }}
        >
          <div className="form-row">
            {fields.map((f) => (
              <Field
                key={f}
                label={
                  (
                    {
                      name: "名称",
                      location: "位置说明",
                      x: "横坐标（米）",
                      y: "纵坐标（米）",
                      radius: "围栏半径（米）",
                      capacity: "容量",
                      code: "车辆编号",
                      zone_id: "所在停车区 ID",
                      phone: "电话",
                      email: "登录邮箱",
                      password: "密码（编辑时可留空）",
                    } as any
                  )[f]
                }
              >
                <input
                  required={f !== "password" || !edit.id}
                  type={
                    ["x", "y", "radius", "capacity", "zone_id"].includes(f)
                      ? "number"
                      : f === "password"
                        ? "password"
                        : f === "email"
                          ? "email"
                          : "text"
                  }
                  value={edit[f] ?? defaults[kind][f] ?? ""}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      [f]: ["x", "y", "radius", "capacity", "zone_id"].includes(
                        f,
                      )
                        ? Number(e.target.value)
                        : e.target.value,
                    })
                  }
                />
              </Field>
            ))}
            <Field label="状态">
              <select
                value={edit.status || defaults[kind].status}
                onChange={(e) => setEdit({ ...edit, status: e.target.value })}
              >
                {(kind === "zones"
                  ? ["ACTIVE", "CLOSED"]
                  : kind === "bikes"
                    ? ["AVAILABLE", "RETIRED"]
                    : ["ACTIVE", "OFF_DUTY"]
                ).map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </select>
            </Field>
            {kind === "staff" && (
              <Field label="岗位">
                <select
                  value={edit.job || "BOTH"}
                  onChange={(e) => setEdit({ ...edit, job: e.target.value })}
                >
                  {["DISPATCH", "MAINTENANCE", "BOTH"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
            )}
          </div>
          <button>保存资料</button>
        </form>
        <Table
          rows={
            kind === "zones" ? d.zones : kind === "bikes" ? d.bikes : d.staff
          }
          columns={[
            { label: "编号", render: (r) => r.id },
            { label: "名称", render: (r) => r.name || r.code },
            { label: "状态", render: (r) => <Badge value={r.status} /> },
            {
              label: "操作",
              render: (r) => (
                <button
                  className="tiny secondary"
                  onClick={() => setEdit({ ...r, zone_id: r.current_zone_id })}
                >
                  编辑
                </button>
              ),
            },
          ]}
        />
      </section>
      <section className="panel">
        <h2>用户账户管理</h2>
        {userError && (
          <div className="error" role="alert">
            {userError}
          </div>
        )}
        <Table
          rows={users}
          columns={[
            { label: "姓名", render: (r) => r.name },
            { label: "邮箱", render: (r) => r.email },
            { label: "角色", render: (r) => r.role },
            { label: "状态", render: (r) => <Badge value={r.status} /> },
            {
              label: "操作",
              render: (r) => (
                <button
                  className="tiny secondary"
                  onClick={() =>
                    run("/admin/users/" + r.id + "/status", {
                      status: r.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE",
                    })
                  }
                >
                  {r.status === "ACTIVE" ? "停用" : "启用"}
                </button>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
