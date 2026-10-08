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
            系统会同时提交定位采集时间和来源。圈外、定位过期或车位已满时会记录尝试并保留骑行订单。
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
                captured_at: new Date().toISOString(),
                location_source: "MAP_SIMULATION",
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
          { label: "定位来源", render: (r) => r.location_source || "历史数据" },
          {
            label: "复核状态",
            render: (r) => <Badge value={r.review_status || "PENDING"} />,
          },
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
function InventoryChart({ series, zones }: { series: Row[]; zones: Row[] }) {
  if (!series?.length) return <Empty text="所选区间没有库存快照" />;
  const zoneIds = [...new Set(series.map((s) => Number(s.zone_id)))].slice(
      0,
      6,
    ),
    times = series.map((s) => new Date(s.captured_at).getTime()),
    start = Math.min(...times),
    end = Math.max(...times),
    maximum = Math.max(
      1,
      ...series.map((s) => Number(s.capacity || s.available)),
    ),
    colors = ["#315fb7", "#e8753d", "#7552ad", "#1d8b82", "#d04f77", "#947120"],
    x = (time: any) =>
      55 +
      ((new Date(time).getTime() - start) / Math.max(1, end - start)) * 790,
    y = (value: any) => 185 - (Number(value) / maximum) * 145;
  return (
    <div className="inventory-chart">
      <svg
        viewBox="0 0 900 225"
        role="img"
        aria-label="停车区可用车辆库存时间序列"
      >
        <line x1="55" y1="40" x2="55" y2="185" />
        <line x1="55" y1="185" x2="845" y2="185" />
        <text x="18" y="45">
          {maximum} 辆
        </text>
        <text x="30" y="190">
          0
        </text>
        {zoneIds.map((zoneId, index) => {
          const points = series
            .filter((s) => Number(s.zone_id) === zoneId)
            .sort(
              (a, b) =>
                new Date(a.captured_at).getTime() -
                new Date(b.captured_at).getTime(),
            )
            .map((s) => `${x(s.captured_at)},${y(s.available)}`)
            .join(" ");
          return (
            <polyline
              key={zoneId}
              points={points}
              fill="none"
              stroke={colors[index]}
              strokeWidth="3"
            />
          );
        })}
        <text x="55" y="212">
          {new Date(start).toLocaleString("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
          })}
        </text>
        <text x="845" y="212" textAnchor="end">
          {new Date(end).toLocaleString("zh-CN", {
            month: "numeric",
            day: "numeric",
            hour: "2-digit",
          })}
        </text>
      </svg>
      <div className="chart-legend">
        {zoneIds.map((id, index) => (
          <span key={id}>
            <i style={{ background: colors[index] }} />
            {zones.find((z) => z.id === id)?.name || `停车区 ${id}`}
          </span>
        ))}
      </div>
      <p className="muted">
        折线表示各停车区快照中的可借车辆数；断档不补值，详细覆盖率见下表。
      </p>
    </div>
  );
}
export function Analytics({ d, run }: Props) {
  const today = new Date().toISOString().slice(0, 10),
    weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10),
    [scope, setScope] = useState("preset"),
    [days, setDays] = useState(7),
    [start, setStart] = useState(weekAgo),
    [end, setEnd] = useState(today),
    [dayType, setDayType] = useState("ALL"),
    [startHour, setStartHour] = useState(0),
    [endHour, setEndHour] = useState(24),
    [zoneId, setZoneId] = useState(0);
  const filter =
      scope === "preset"
        ? { days }
        : {
            start,
            end,
            dayType,
            startHour,
            endHour,
            ...(zoneId ? { zoneId } : {}),
          },
    query = new URLSearchParams(
      Object.entries(filter).map(([k, v]) => [k, String(v)]),
    ).toString();
  const parseReasons = (value: any) => {
    if (Array.isArray(value)) return value;
    try {
      return JSON.parse(value || "[]");
    } catch {
      return [];
    }
  };
  return (
    <>
      <section className="panel analytics-filter">
        <div className="section-head">
          <div>
            <h2>热点分析条件</h2>
            <p className="muted">
              北京时间统计；库存持续时长只按有效快照区间计算。
            </p>
          </div>
          <div className="tabs">
            <button
              className={scope === "preset" ? "" : "secondary"}
              onClick={() => setScope("preset")}
            >
              快速周期
            </button>
            <button
              className={scope === "custom" ? "" : "secondary"}
              onClick={() => setScope("custom")}
            >
              自定义筛选
            </button>
          </div>
        </div>
        <div className="form-row">
          {scope === "preset" ? (
            <Field label="统计周期">
              <select
                value={days}
                onChange={(e) => setDays(Number(e.target.value))}
              >
                <option value={7}>近 7 日</option>
                <option value={30}>近 30 日</option>
              </select>
            </Field>
          ) : (
            <>
              <Field label="开始日期">
                <input
                  type="date"
                  value={start}
                  onChange={(e) => setStart(e.target.value)}
                />
              </Field>
              <Field label="结束日期">
                <input
                  type="date"
                  value={end}
                  onChange={(e) => setEnd(e.target.value)}
                />
              </Field>
              <Field label="日期类型">
                <select
                  value={dayType}
                  onChange={(e) => setDayType(e.target.value)}
                >
                  <option value="ALL">全部日期</option>
                  <option value="WEEKDAY">仅工作日</option>
                  <option value="WEEKEND">仅周末</option>
                </select>
              </Field>
              <Field label="开始小时">
                <input
                  type="number"
                  min="0"
                  max="23"
                  value={startHour}
                  onChange={(e) => setStartHour(Number(e.target.value))}
                />
              </Field>
              <Field label="结束小时">
                <input
                  type="number"
                  min="1"
                  max="24"
                  value={endHour}
                  onChange={(e) => setEndHour(Number(e.target.value))}
                />
              </Field>
              <Field label="停车区">
                <select
                  value={zoneId}
                  onChange={(e) => setZoneId(Number(e.target.value))}
                >
                  <option value={0}>全部停车区</option>
                  {d.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                    </option>
                  ))}
                </select>
              </Field>
            </>
          )}
        </div>
      </section>
      <Remote path={"/analytics?" + query} refreshKey={d}>
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
              <InventoryChart
                series={v.inventory_series || []}
                zones={d.zones}
              />
              <div className="inventory-strip">
                {(v.hotspots || []).slice(0, 6).map((h: any) => (
                  <article key={h.zone_id}>
                    <strong>{h.name}</strong>
                    <span>
                      {h.borrow_count} 借 / {h.return_count} 还
                    </span>
                    <i
                      style={{
                        width: Math.min(100, h.coverage_ratio * 100) + "%",
                      }}
                    />
                    <small>
                      快照覆盖率 {(h.coverage_ratio * 100).toFixed(0)}%
                    </small>
                  </article>
                ))}
              </div>
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
              <div className="section-head">
                <div>
                  <h2>可追溯调度建议</h2>
                  <p className="muted">
                    保存生成窗口、库存基线、需求量和算法版本，确认时再次校验车位。
                  </p>
                </div>
                <button onClick={() => run("/analytics/suggestions", filter)}>
                  生成并保存本次建议
                </button>
              </div>
              {!v.suggestions.length && <Empty text="当前没有可执行调度建议" />}
              {v.suggestions.map((s: any, i: number) => (
                <div className="list-row" key={i}>
                  <div>
                    <strong>
                      {s.source_name} → {s.target_name} · {s.quantity} 辆
                    </strong>
                    <p className="muted">{s.reason}</p>
                  </div>
                  <Badge value="PREVIEW" />
                </div>
              ))}
              <h3>已保存建议</h3>
              <Table
                rows={v.saved_suggestions || []}
                columns={[
                  {
                    label: "建议",
                    render: (r) =>
                      r.source_name +
                      " → " +
                      r.target_name +
                      " · " +
                      r.quantity +
                      " 辆",
                  },
                  {
                    label: "依据",
                    render: (r) =>
                      `借 ${r.borrow_count} / 还 ${r.return_count} · 目标库存 ${r.desired_inventory}`,
                  },
                  { label: "版本", render: (r) => r.algorithm_version },
                  { label: "状态", render: (r) => <Badge value={r.status} /> },
                  {
                    label: "操作",
                    render: (r) =>
                      r.status === "OPEN" ? (
                        <button
                          className="tiny"
                          onClick={() =>
                            run("/dispatches/from-suggestion/" + r.id, {})
                          }
                        >
                          复核并创建任务
                        </button>
                      ) : (
                        "已处理"
                      ),
                  },
                ]}
              />
            </section>
            <section className="panel">
              <div className="section-head">
                <div>
                  <h2>车辆风险预警与处置</h2>
                  <p className="muted">
                    基于报修次数、复发类型与维修间隔的可解释规则，非学习模型。
                  </p>
                </div>
                <button onClick={() => run("/risks/refresh", {})}>
                  运行规则并保存告警
                </button>
              </div>
              <Table
                rows={v.risk_alerts || []}
                columns={[
                  { label: "车辆", render: (r) => r.bike_code },
                  { label: "风险分", render: (r) => r.score },
                  {
                    label: "等级 / 状态",
                    render: (r) => (
                      <>
                        <Badge value={r.level} /> <Badge value={r.status} />
                      </>
                    ),
                  },
                  {
                    label: "判定原因",
                    render: (r) => (
                      <ul>
                        {parseReasons(r.reasons).map((s: any, i: number) => (
                          <li key={i}>
                            {typeof s === "string"
                              ? s
                              : s.message ||
                                s.label ||
                                s.reason ||
                                JSON.stringify(s)}
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                  {
                    label: "处置",
                    render: (r) =>
                      ["RESOLVED", "DISMISSED"].includes(r.status) ? (
                        "已结束"
                      ) : (
                        <div className="actions">
                          <button
                            className="tiny"
                            onClick={() =>
                              run("/risks/" + r.id + "/acknowledge", {
                                note: "已核对风险规则与历史工单",
                              })
                            }
                          >
                            确认
                          </button>
                          <button
                            className="tiny secondary"
                            onClick={() =>
                              run("/risks/" + r.id + "/create_ticket", {
                                note: "依据风险告警创建检查工单",
                              })
                            }
                          >
                            生成工单
                          </button>
                          <button
                            className="tiny secondary"
                            onClick={() =>
                              run("/risks/" + r.id + "/resolve", {
                                note: "现场检查完成，风险已处置",
                              })
                            }
                          >
                            解决
                          </button>
                        </div>
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
      <div className="route-options">
        {[
          ["shortest", "最短路线", "以可通行距离为主要依据"],
          ["safe", "安全优先", "综合交叉口、照明与机动车混行"],
          ["comfortable", "舒适优先", "综合坡度、路面与遮阴"],
        ].map(([key, title, detail]) => (
          <Remote
            key={key}
            path={"/routes?from=" + from + "&to=" + to + "&mode=" + key}
          >
            {(route) => (
              <button
                className={
                  mode === key ? "route-option active" : "route-option"
                }
                onClick={() => setMode(key)}
              >
                <span>{title}</span>
                <strong>{(route.distance_m / 1000).toFixed(2)} km</strong>
                <small>
                  {route.duration_minutes} 分钟 · {detail}
                </small>
              </button>
            )}
          </Remote>
        ))}
      </div>
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
              <h2>路线依据与途经道路</h2>
              <p>{v.explanation}</p>
              <div className="route-facts">
                <span>
                  交叉口风险合计{" "}
                  <strong>{v.attribute_totals.intersection_risk}</strong>
                </span>
                <span>
                  机动车较多路段{" "}
                  <strong>{v.attribute_totals.motor_heavy_edges}</strong>
                </span>
                <span>
                  较粗糙路段 <strong>{v.attribute_totals.rough_edges}</strong>
                </span>
                <span>
                  高遮阴路段 <strong>{v.attribute_totals.shaded_edges}</strong>
                </span>
              </div>
              <p>
                {v.path
                  .map(
                    (id: number) =>
                      v.nodes.find((n: Row) => n.id === id)?.name || id,
                  )
                  .join(" → ")}
              </p>
              <p className="muted">
                道路属性来源：课程演示模拟数据；封闭和禁骑道路不会参与计算。
              </p>
              <Table
                rows={v.segments}
                columns={[
                  {
                    label: "路段",
                    render: (r) =>
                      `${v.nodes.find((n: Row) => n.id === r.from_node_id)?.name} → ${v.nodes.find((n: Row) => n.id === r.to_node_id)?.name}`,
                  },
                  {
                    label: "方向 / 状态",
                    render: (r) => `${r.direction} / ${r.status}`,
                  },
                  {
                    label: "长度 / 坡度",
                    render: (r) =>
                      `${r.distance_m} m / ${Number(r.slope_percent).toFixed(1)}%`,
                  },
                  {
                    label: "路面 / 交通",
                    render: (r) => `${r.surface} / ${r.traffic_mix}`,
                  },
                  {
                    label: "遮阴 / 照明",
                    render: (r) => `${r.shade_level} / ${r.lighting_level}`,
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
export function Carbon({ d, user, run }: Props) {
  const [period, setPeriod] = useState("week"),
    [metric, setMetric] = useState("points"),
    [alias, setAlias] = useState(user.leaderboard_alias || "骑行者"),
    [visible, setVisible] = useState(Boolean(user.leaderboard_visible));
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
          <div>
            <h2>自愿参与的校园绿色排行榜</h2>
            <p className="muted">
              默认不公开真实姓名；你可以设置公开昵称并随时退出展示。
            </p>
          </div>
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
            <>
              {v.me && (
                <div className="leaderboard-me">
                  <span>{v.me.private ? "仅自己可见" : "已参与公开榜单"}</span>
                  <strong>我的排名 #{v.me.rank}</strong>
                  <small>
                    {v.me.points} 分 · {(v.me.distance_m / 1000).toFixed(2)} km
                  </small>
                </div>
              )}
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
            </>
          )}
        </Remote>
        <form
          className="privacy-form"
          onSubmit={(e) => {
            e.preventDefault();
            run("/profile/leaderboard", { alias, visible });
          }}
        >
          <Field label="榜单昵称">
            <input
              minLength={2}
              maxLength={20}
              value={alias}
              onChange={(e) => setAlias(e.target.value)}
            />
          </Field>
          <label className="check-line">
            <input
              type="checkbox"
              checked={visible}
              onChange={(e) => setVisible(e.target.checked)}
            />
            将昵称和统计结果显示在公开榜单
          </label>
          <button>保存隐私设置</button>
        </form>
      </section>
      <section className="panel">
        <h2>我的碳积分流水</h2>
        <p className="muted">
          发放与人工调整均新增流水，不覆盖历史记录；每条记录保留规则版本和原因。
        </p>
        <Table
          rows={d.carbon.entries}
          columns={[
            { label: "关联订单", render: (r) => "#" + r.order_id },
            { label: "类型", render: (r) => <Badge value={r.entry_type} /> },
            {
              label: "积分变动",
              render: (r) => (r.points > 0 ? "+" : "") + r.points,
            },
            {
              label: "减排变动",
              render: (r) =>
                (Number(r.carbon_kg) > 0 ? "+" : "") +
                Number(r.carbon_kg).toFixed(4) +
                " kg",
            },
            {
              label: "规则 / 原因",
              render: (r) => (
                <>
                  <code>{r.rule_version}</code>
                  <br />
                  <small>{r.reason}</small>
                </>
              ),
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
    [roads, setRoads] = useState<Row[]>([]),
    [road, setRoad] = useState<any>(),
    [attempts, setAttempts] = useState<Row[]>([]),
    [reviews, setReviews] = useState<Row[]>([]),
    [adjustOrder, setAdjustOrder] = useState(""),
    [adjustPoints, setAdjustPoints] = useState(0),
    [adjustCarbon, setAdjustCarbon] = useState(0),
    [adjustReason, setAdjustReason] = useState("课程演示人工校正"),
    [userError, setUserError] = useState("");
  useEffect(() => {
    Promise.all([
      api("/admin/users"),
      api("/admin/roads"),
      api("/return-attempts"),
      api("/admin/orders/review"),
    ])
      .then(([u, r, a, q]) => {
        setUsers(u.users);
        setRoads(r.roads || []);
        setAttempts(a.attempts || []);
        setReviews(q.orders || []);
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
      <section className="panel">
        <div className="section-head">
          <div>
            <h2>校园路网属性维护</h2>
            <p className="muted">
              方向、禁骑状态、坡度、路面、遮阴、照明和混行属性会直接影响三种路线方案。
            </p>
          </div>
        </div>
        {road && (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run("/admin/roads", road)) setRoad(undefined);
            }}
          >
            <h3>
              编辑路段 #{road.id} · {road.from_name} → {road.to_name}
            </h3>
            <div className="form-row">
              <Field label="方向">
                <select
                  value={road.direction}
                  onChange={(e) =>
                    setRoad({ ...road, direction: e.target.value })
                  }
                >
                  {["BOTH", "FORWARD", "REVERSE"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="通行状态">
                <select
                  value={road.status}
                  onChange={(e) => setRoad({ ...road, status: e.target.value })}
                >
                  {["OPEN", "CLOSED", "NO_RIDE"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="坡度 %">
                <input
                  type="number"
                  step="0.1"
                  min="-30"
                  max="30"
                  value={road.slope_percent}
                  onChange={(e) =>
                    setRoad({ ...road, slope_percent: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="路面">
                <select
                  value={road.surface}
                  onChange={(e) =>
                    setRoad({ ...road, surface: e.target.value })
                  }
                >
                  {["SMOOTH", "AVERAGE", "ROUGH"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="遮阴 0–5">
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={road.shade_level}
                  onChange={(e) =>
                    setRoad({ ...road, shade_level: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="照明 0–5">
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={road.lighting_level}
                  onChange={(e) =>
                    setRoad({ ...road, lighting_level: Number(e.target.value) })
                  }
                />
              </Field>
              <Field label="交通混行">
                <select
                  value={road.traffic_mix}
                  onChange={(e) =>
                    setRoad({ ...road, traffic_mix: e.target.value })
                  }
                >
                  {["BIKE_ONLY", "MIXED", "MOTOR_HEAVY"].map((v) => (
                    <option key={v}>{v}</option>
                  ))}
                </select>
              </Field>
              <Field label="交叉口风险 0–5">
                <input
                  type="number"
                  min="0"
                  max="5"
                  value={road.intersection_risk}
                  onChange={(e) =>
                    setRoad({
                      ...road,
                      intersection_risk: Number(e.target.value),
                    })
                  }
                />
              </Field>
            </div>
            <button>保存路网属性</button>
          </form>
        )}
        <Table
          rows={roads}
          columns={[
            { label: "路段", render: (r) => `${r.from_name} → ${r.to_name}` },
            {
              label: "方向 / 状态",
              render: (r) => `${r.direction} / ${r.status}`,
            },
            {
              label: "坡度 / 路面",
              render: (r) =>
                `${Number(r.slope_percent).toFixed(1)}% / ${r.surface}`,
            },
            {
              label: "交通 / 风险",
              render: (r) => `${r.traffic_mix} / ${r.intersection_risk}`,
            },
            { label: "属性来源", render: (r) => r.attribute_source },
            {
              label: "操作",
              render: (r) => (
                <button
                  className="tiny secondary"
                  onClick={() => setRoad({ ...r })}
                >
                  编辑
                </button>
              ),
            },
          ]}
        />
      </section>
      <section className="panel">
        <h2>电子围栏违规复核</h2>
        <Table
          rows={attempts}
          columns={[
            {
              label: "订单 / 车辆",
              render: (r) => `#${r.order_id} · ${r.bike_code}`,
            },
            {
              label: "停车区 / 坐标",
              render: (r) => `${r.zone_name} · ${r.x}, ${r.y}`,
            },
            {
              label: "原因 / 来源",
              render: (r) => `${r.reason} / ${r.location_source || "历史"}`,
            },
            { label: "状态", render: (r) => <Badge value={r.review_status} /> },
            {
              label: "操作",
              render: (r) =>
                r.review_status === "PENDING" ? (
                  <div className="actions">
                    <button
                      className="tiny"
                      onClick={() =>
                        run("/returns/" + r.id + "/review", {
                          action: "RESOLVE",
                          note: "已核对定位时间、坐标与停车区范围",
                        })
                      }
                    >
                      标记已处理
                    </button>
                    <button
                      className="tiny secondary"
                      onClick={() =>
                        run("/returns/" + r.id + "/review", {
                          action: "DISMISS",
                          note: "复核后确认该记录无需继续处理",
                        })
                      }
                    >
                      撤销记录
                    </button>
                  </div>
                ) : (
                  r.review_note
                ),
            },
          ]}
        />
      </section>
      <section className="panel">
        <h2>异常行程资格复核</h2>
        <p className="muted">
          短时间内出现异常长距离的订单不会立即发放积分，经人工确认后再记入流水。
        </p>
        <Table
          rows={reviews}
          columns={[
            {
              label: "订单 / 用户",
              render: (r) => `#${r.id} · ${r.user_name}`,
            },
            {
              label: "车辆 / 里程",
              render: (r) =>
                `${r.bike_code} · ${(r.distance_m / 1000).toFixed(2)} km`,
            },
            { label: "异常依据", render: (r) => r.qualification_reason },
            {
              label: "操作",
              render: (r) => (
                <div className="actions">
                  <button
                    className="tiny"
                    onClick={() =>
                      run("/orders/" + r.id + "/qualification", {
                        decision: "VALID",
                        reason: "人工复核确认行程数据有效",
                      })
                    }
                  >
                    确认有效
                  </button>
                  <button
                    className="tiny secondary"
                    onClick={() =>
                      run("/orders/" + r.id + "/qualification", {
                        decision: "EXCLUDED",
                        reason: "人工复核确认不参与积分统计",
                      })
                    }
                  >
                    排除
                  </button>
                </div>
              ),
            },
          ]}
        />
      </section>
      <section className="panel">
        <h2>碳积分人工调整</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run("/carbon/adjustments", {
              order_id: Number(adjustOrder),
              points_change: adjustPoints,
              carbon_kg_change: adjustCarbon,
              reason: adjustReason,
              idempotency_key: `manual-${adjustOrder}-${Date.now()}`,
            });
          }}
        >
          <div className="form-row">
            <Field label="已支付订单 ID">
              <input
                required
                type="number"
                min="1"
                value={adjustOrder}
                onChange={(e) => setAdjustOrder(e.target.value)}
              />
            </Field>
            <Field label="积分变动">
              <input
                type="number"
                value={adjustPoints}
                onChange={(e) => setAdjustPoints(Number(e.target.value))}
              />
            </Field>
            <Field label="减排变动 kg">
              <input
                type="number"
                step="0.0001"
                value={adjustCarbon}
                onChange={(e) => setAdjustCarbon(Number(e.target.value))}
              />
            </Field>
            <Field label="调整原因">
              <input
                required
                minLength={2}
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
              />
            </Field>
          </div>
          <button disabled={adjustPoints === 0 && adjustCarbon === 0}>
            新增调整流水
          </button>
        </form>
      </section>
    </>
  );
}
