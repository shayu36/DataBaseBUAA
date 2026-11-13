import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  BatteryFull,
  Bike,
  Check,
  ChevronRight,
  History,
  Leaf,
  LogOut,
  MapPin,
  Monitor,
  RefreshCw,
  Settings,
  Signal,
  Smartphone,
  UnlockKeyhole,
  Wifi,
} from "lucide-react";
import { api } from "../api";
import { money } from "../components";
import type { Dashboard, Row, User } from "../types";
import logo from "../assets/qingxing-logo-puhuiti-bold.png";
import { PhoneMap } from "./PhoneMap";
import "./phone.css";

type Props = {
  d?: Dashboard;
  user: User;
  busy: boolean;
  stale?: boolean;
  error: string;
  notice: string;
  run: (path: string, body: unknown) => Promise<boolean>;
  refresh: () => Promise<boolean>;
  logout: () => Promise<void>;
  onExit: () => void;
};
type Tab = "home" | "history" | "carbon" | "settings";
const usable = (z?: Row) =>
  !!z && z.status === "ACTIVE" && !Number(z.restricted);
const freeSpaces = (z: Row) =>
  Math.max(0, Number(z.capacity) - Number(z.occupied) - Number(z.reserved));
const formatDate = (s: string) =>
  s
    ? new Date(s).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";

function RideClock({ started }: { started: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const elapsed =
    Math.max(0, Math.floor((now - new Date(started).getTime()) / 1000)) || 0;
  return (
    <strong className="phone-timer">
      {String(Math.floor(elapsed / 60)).padStart(2, "0")}
      <span>:</span>
      {String(elapsed % 60).padStart(2, "0")}
    </strong>
  );
}

function RideHistory({
  d,
  onPay,
}: {
  d: Dashboard;
  onPay: (id: number) => void;
}) {
  const [older, setOlder] = useState<Row[]>([]);
  const [cursor, setCursor] = useState(d.rides_next_before);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    setOlder([]);
    setCursor(d.rides_next_before);
    setLoading(false);
    setError("");
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [d]);
  const rows = [
    ...d.rides,
    ...older.filter((r) => !d.rides.some((n) => n.id === r.id)),
  ];
  return (
    <section className="phone-section phone-history">
      <div className="phone-section-title">
        <h2>骑行记录</h2>
        <span>{rows.length} 笔已加载</span>
      </div>
      {!rows.length && (
        <div className="phone-empty">
          <History />
          <strong>第一程，从这里开始</strong>
          <p>完成借车后，行程会出现在这里</p>
        </div>
      )}
      {rows.map((ride) => (
        <article className="phone-order" key={ride.id}>
          <div>
            <strong>{ride.bike_code || `订单 #${ride.id}`}</strong>
            <span className={`phone-status status-${ride.status}`}>
              {{
                RUNNING: "骑行中",
                UNPAID: "待支付",
                PAID: "已支付",
                CANCELLED: "已取消",
              }[ride.status as string] || ride.status}
            </span>
          </div>
          <small>{formatDate(ride.started_at)}</small>
          <p>
            {ride.start_zone_name || "借车停车点"}
            <ArrowRight size={13} />
            {ride.end_zone_name ||
              (ride.status === "RUNNING" ? "尚未归还" : "已归还")}
          </p>
          <div>
            <span>订单 #{ride.id}</span>
            <strong>
              {ride.status === "RUNNING" ? "计费中" : money(ride.amount_cents)}
            </strong>
          </div>
          {ride.status === "UNPAID" && (
            <button className="phone-primary" onClick={() => onPay(ride.id)}>
              模拟支付 {money(ride.amount_cents)}
            </button>
          )}
        </article>
      ))}
      {error && (
        <p role="alert" className="phone-alert">
          {error}
        </p>
      )}
      {cursor != null && (
        <button
          className="phone-secondary phone-wide"
          disabled={loading}
          onClick={async () => {
            if (controller.current) return;
            const request = new AbortController();
            controller.current = request;
            setLoading(true);
            setError("");
            try {
              const result = await api("/rides?before=" + cursor, undefined, {
                signal: request.signal,
              });
              if (request.signal.aborted) return;
              setOlder((current) => [
                ...current,
                ...result.rides.filter(
                  (r: Row) => !current.some((p) => p.id === r.id),
                ),
              ]);
              setCursor(result.next_before);
            } catch (e) {
              if (!request.signal.aborted) setError((e as Error).message);
            } finally {
              if (controller.current === request) {
                controller.current = null;
                setLoading(false);
              }
            }
          }}
        >
          {loading ? "正在加载" : "加载更早记录"}
        </button>
      )}
    </section>
  );
}

function PhoneContent({
  d,
  user,
  run,
  refresh,
  logout,
  onExit,
}: Props & { d: Dashboard }) {
  const [tab, setTab] = useState<Tab>("home");
  const [zoneId, setZoneId] = useState(
    () =>
      d.zones.find((z) => usable(z) && Number(z.borrowable) > 0)?.id ||
      d.zones[0]?.id,
  );
  const [code, setCode] = useState("");
  const [localError, setLocalError] = useState("");
  const [limit, setLimit] = useState(6);
  const content = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const active = d.actionable_rides.find((r) => r.status === "RUNNING");
  const unpaid = d.actionable_rides.filter((r) => r.status === "UNPAID");
  const selected = d.zones.find((z) => z.id === zoneId);
  const canReturn = (z: Row) =>
    z.status === "ACTIVE" &&
    (!Number(z.restricted) || Number(z.id) === Number(active?.start_zone_id));
  const zonesById = new Map(d.zones.map((z) => [Number(z.id), z]));
  const available = d.bikes.filter(
    (b) =>
      b.status === "AVAILABLE" &&
      usable(zonesById.get(Number(b.current_zone_id))),
  );
  const nearby = [...available].sort((a, b) => {
    const distance = (bike: Row) => {
      const z = zonesById.get(Number(bike.current_zone_id));
      return z && selected
        ? Math.hypot(
            Number(z.x) - Number(selected.x),
            Number(z.y) - Number(selected.y),
          )
        : 0;
    };
    return distance(a) - distance(b) || a.id - b.id;
  });
  const chooseZone = (z: Row) => {
    setZoneId(z.id);
    setLimit(6);
    setLocalError("");
  };
  const switchTab = (next: Tab) => {
    setTab(next);
    setLocalError("");
    content.current?.scrollTo({ top: 0 });
  };
  const pay = (id: number) =>
    run(`/rides/${id}/pay`, { idempotency_key: "qingxing-order-" + id });
  return (
    <>
      <header className="phone-app-header">
        <button
          className="phone-brand"
          aria-label="骑行首页"
          onClick={() => switchTab("home")}
        >
          <img src={logo} alt="青行" />
          <span>共享单车</span>
        </button>
        <div className="phone-header-actions">
          <button
            aria-label="碳积分"
            aria-pressed={tab === "carbon"}
            onClick={() => switchTab("carbon")}
          >
            <Leaf size={19} />
          </button>
          <button
            aria-label="骑行记录"
            aria-pressed={tab === "history"}
            onClick={() => switchTab("history")}
          >
            <History size={20} />
          </button>
          <button
            aria-label="账户设置"
            aria-pressed={tab === "settings"}
            onClick={() => switchTab("settings")}
          >
            <Settings size={20} />
          </button>
          <button aria-label="退出登录" onClick={logout}>
            <LogOut size={19} />
          </button>
        </div>
      </header>
      <div className="phone-content" ref={content}>
        {tab !== "home" && (
          <button className="phone-back" onClick={() => switchTab("home")}>
            <ArrowLeft size={16} />
            返回骑行首页
          </button>
        )}
        {tab === "home" && (
          <>
            <div className="phone-campus-label">
              <MapPin size={14} />
              北航学院路校区<span>校园骑行</span>
            </div>
            <PhoneMap
              zones={d.zones}
              selected={selected}
              onSelect={chooseZone}
            />
            <section className="phone-section phone-unlock">
              <label className="phone-station-field">
                <span>{active ? "归还停车点" : "当前停车点"}</span>
                <select
                  aria-label={active ? "归还停车点" : "当前停车点"}
                  value={zoneId ?? ""}
                  onChange={(e) => {
                    const z = zonesById.get(Number(e.target.value));
                    if (z) chooseZone(z);
                  }}
                >
                  {!d.zones.length && <option value="">暂无停车点</option>}
                  {d.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name}
                      {!usable(z)
                        ? " · 暂停借车"
                        : active
                          ? ` · ${freeSpaces(z)} 个空位`
                          : ` · ${z.borrowable} 辆可借`}
                    </option>
                  ))}
                </select>
              </label>
              {!active ? (
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setLocalError("");
                    const value = code.trim().toLowerCase();
                    const bike = d.bikes.find(
                      (b) =>
                        b.code.toLowerCase() === value ||
                        String(b.id) === value.replace(/^#/, ""),
                    );
                    if (!bike) {
                      setLocalError("未找到该车辆，请核对车辆编号");
                      return;
                    }
                    if (
                      bike.status !== "AVAILABLE" ||
                      !usable(zonesById.get(Number(bike.current_zone_id)))
                    ) {
                      setLocalError("该车辆当前不可借用，请选择其他单车");
                      return;
                    }
                    if (Number(bike.current_zone_id) !== Number(zoneId)) {
                      setLocalError(
                        `车辆位于${zonesById.get(Number(bike.current_zone_id))?.name || "其他停车点"}，请先选择对应停车点`,
                      );
                      return;
                    }
                    if (unpaid.length) {
                      setLocalError("请先完成待支付订单");
                      return;
                    }
                    if (await run("/rides/start", { bike_id: bike.id }))
                      setCode("");
                  }}
                >
                  <label htmlFor="phone-bike-code">输入车辆编号开锁</label>
                  <div className="phone-unlock-row">
                    <input
                      id="phone-bike-code"
                      ref={input}
                      aria-label="车辆编号"
                      placeholder="如 QX-001 或车辆 ID"
                      value={code}
                      onChange={(e) => {
                        setCode(e.target.value);
                        setLocalError("");
                      }}
                      autoComplete="off"
                      required
                    />
                    <button
                      className="phone-primary"
                      disabled={!code.trim() || unpaid.length > 0}
                    >
                      <UnlockKeyhole size={16} />
                      开锁
                    </button>
                  </div>
                </form>
              ) : (
                <div className="phone-active-ride">
                  <div className="phone-section-title">
                    <span className="phone-live">
                      <i />
                      骑行中
                    </span>
                    <strong>{active.bike_code}</strong>
                  </div>
                  <RideClock started={active.started_at} />
                  <p>请将单车停入所选停车点后归还</p>
                  <button
                    className="phone-primary phone-wide"
                    disabled={
                      !selected ||
                      !canReturn(selected) ||
                      freeSpaces(selected) <= 0
                    }
                    onClick={() =>
                      selected &&
                      run(`/rides/${active.id}/return`, {
                        zone_id: selected.id,
                        route_mode: "shortest",
                        captured_at: new Date().toISOString(),
                        location_source: "MAP_SIMULATION",
                      })
                    }
                  >
                    确认归还
                    <ArrowRight size={16} />
                  </button>
                  {selected &&
                    (!canReturn(selected) || freeSpaces(selected) <= 0) && (
                      <p className="phone-alert">
                        该停车点暂不可归还，请选择开放且有空位的停车点
                      </p>
                    )}
                </div>
              )}
              {localError && (
                <p className="phone-alert" role="alert">
                  {localError}
                </p>
              )}
              <p className="phone-form-hint">
                <MapPin size={12} />
                停车点模拟定位{!active && " · 每开始 30 分钟 ¥1"}
              </p>
            </section>
            {unpaid.length > 0 && (
              <section className="phone-section">
                <h2>待支付订单</h2>
                {unpaid.map((ride) => (
                  <div className="phone-payment" key={ride.id}>
                    <p>
                      {ride.bike_code} <span>订单 #{ride.id}</span>
                    </p>
                    <button
                      className="phone-primary phone-wide"
                      onClick={() => pay(ride.id)}
                    >
                      模拟支付 {money(ride.amount_cents)}
                    </button>
                  </div>
                ))}
              </section>
            )}
            {!active && (
              <section className="phone-section phone-nearby">
                <div className="phone-section-title">
                  <h2>附近可用单车</h2>
                  <span>{available.length} 辆</span>
                </div>
                <p className="phone-list-caption">按所选停车点的图上距离排序</p>
                {!nearby.length && (
                  <div className="phone-empty">
                    <Bike />
                    <strong>暂时没有可借单车</strong>
                    <p>稍后刷新，或查看其他停车点</p>
                  </div>
                )}
                {nearby.slice(0, limit).map((bike) => (
                  <article className="phone-bike-row" key={bike.id}>
                    <span className="phone-bike-icon">
                      <Bike size={23} />
                    </span>
                    <div>
                      <strong>单车 {bike.code}</strong>
                      <small>
                        {zonesById.get(Number(bike.current_zone_id))?.name}
                        {Number(bike.current_zone_id) === Number(zoneId)
                          ? " · 同站可借"
                          : ""}
                      </small>
                    </div>
                    <button
                      aria-label={`选择 ${bike.code}`}
                      disabled={unpaid.length > 0}
                      onClick={() => {
                        const z = zonesById.get(Number(bike.current_zone_id));
                        if (z) chooseZone(z);
                        setCode(bike.code);
                        input.current?.focus();
                      }}
                    >
                      选择
                      <ChevronRight size={14} />
                    </button>
                  </article>
                ))}
                {limit < nearby.length && (
                  <button
                    className="phone-more"
                    onClick={() => setLimit((n) => n + 6)}
                  >
                    查看更多单车 <ChevronRight size={14} />
                  </button>
                )}
              </section>
            )}
            {active && (
              <div className="phone-ride-note">
                <Bike size={36} />
                <strong>慢一点，让校园的风追上你</strong>
                <p>遵守校园禁行规则，在指定停车点归还</p>
              </div>
            )}
          </>
        )}
        {tab === "history" && <RideHistory d={d} onPay={pay} />}
        {tab === "carbon" && (
          <section className="phone-section phone-carbon">
            <Leaf size={40} />
            <p>我的绿色足迹</p>
            <strong className="phone-points">
              {d.carbon.points || 0}
              <small>碳积分</small>
            </strong>
            <div className="phone-carbon-stats">
              <div>
                <strong>
                  {(Number(d.carbon.distance_m) / 1000).toFixed(2)}
                </strong>
                <span>估算里程 km</span>
              </div>
              <div>
                <strong>{Number(d.carbon.carbon_kg).toFixed(2)}</strong>
                <span>模拟减排 kg</span>
              </div>
            </div>
            <p className="phone-list-caption">有效且已支付的行程计入绿色足迹</p>
            <button
              className="phone-secondary"
              onClick={() => switchTab("history")}
            >
              查看骑行记录
              <ArrowRight size={15} />
            </button>
          </section>
        )}
        {tab === "settings" && (
          <section className="phone-section phone-profile">
            <span className="phone-profile-avatar">{user.name.slice(-1)}</span>
            <h2>{user.name}</h2>
            <p>{user.email}</p>
            <span className="phone-status status-PAID">校园骑行者</span>
            <dl>
              <div>
                <dt>所属校区</dt>
                <dd>北航学院路校区</dd>
              </div>
              <div>
                <dt>定位方式</dt>
                <dd>停车点模拟定位</dd>
              </div>
              <div>
                <dt>计费规则</dt>
                <dd>每开始 30 分钟 ¥1</dd>
              </div>
            </dl>
            <button className="phone-secondary phone-wide" onClick={refresh}>
              <RefreshCw size={16} />
              刷新账户数据
            </button>
            <button className="phone-secondary phone-wide" onClick={onExit}>
              <Monitor size={16} />
              打开电脑端
            </button>
            <button className="phone-text-button" onClick={logout}>
              退出当前账号
            </button>
          </section>
        )}
      </div>
      <nav className="phone-tabbar" aria-label="手机应用导航">
        {(
          [
            { id: "home", label: "骑行", icon: Bike },
            { id: "history", label: "行程", icon: History },
            { id: "carbon", label: "绿色足迹", icon: Leaf },
            { id: "settings", label: "我的", icon: Settings },
          ] as const
        ).map((item) => (
          <button
            key={item.id}
            aria-current={tab === item.id ? "page" : undefined}
            onClick={() => switchTab(item.id)}
          >
            <item.icon size={20} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}

export function PhonePreview(props: Props) {
  return (
    <div className="phone-stage">
      <header className="phone-stage-header">
        <a
          href="/"
          aria-label="青行电脑端"
          onClick={(e) => {
            e.preventDefault();
            if (!props.busy) props.onExit();
          }}
        >
          <img src={logo} alt="青行" />
          <span>QINGXING CAMPUS</span>
        </a>
        <button
          className="phone-desktop-link"
          disabled={props.busy}
          onClick={props.onExit}
        >
          <Monitor size={17} />
          返回电脑端
        </button>
      </header>
      <div className="phone-stage-layout">
        <aside className="phone-stage-intro">
          <span className="phone-intro-kicker">
            <Smartphone size={16} />
            青行手机 App 展示
          </span>
          <h1>
            轻盈出发
            <br />
            自在抵达<span>校园的每一站</span>
          </h1>
          <p>
            从教学楼到图书馆
            <br />
            把校园里的日常，连成一段好时光
          </p>
          <div className="phone-intro-steps">
            <div>
              <span>01</span>
              <p>
                <strong>找到身边的单车</strong>
                <small>选择校园停车点，查看可用车辆</small>
              </p>
            </div>
            <div>
              <span>02</span>
              <p>
                <strong>输入编号，轻松出发</strong>
                <small>借车、归还与订单同步到电脑端</small>
              </p>
            </div>
            <div>
              <span>03</span>
              <p>
                <strong>留下一点绿色</strong>
                <small>完成支付，积累你的校园绿色足迹</small>
              </p>
            </div>
          </div>
          <span className="phone-intro-campus">
            <MapPin size={15} />
            北京航空航天大学 · 学院路校区
          </span>
        </aside>
        <section className="phone-device" aria-label="青行手机 App">
          <div className="phone-hardware-bar" aria-hidden="true">
            <span>青行</span>
            <i />
            <span>
              <Signal size={13} />
              <Wifi size={13} />
              <BatteryFull size={17} />
            </span>
          </div>
          <div className="phone-feedback" aria-live="polite">
            {props.error && (
              <div className="phone-alert" role="alert">
                {props.error}
              </div>
            )}
            {props.notice && (
              <div className="phone-success" role="status">
                <Check size={15} />
                {props.notice}
              </div>
            )}
            {props.busy && (
              <div className="phone-sync" role="status">
                正在同步数据…
              </div>
            )}
            {props.stale && (
              <button
                className="phone-secondary phone-retry"
                disabled={props.busy}
                onClick={props.refresh}
              >
                <RefreshCw size={14} />
                刷新数据
              </button>
            )}
          </div>
          <fieldset
            className="phone-application"
            disabled={props.busy || props.stale}
            inert={props.busy || props.stale}
            aria-busy={props.busy}
          >
            {props.d ? (
              <PhoneContent {...props} d={props.d} />
            ) : (
              <div className="phone-empty">
                <RefreshCw size={28} />
                <p>{props.error ? "校园数据暂未加载" : "正在连接校园…"}</p>
                {props.error && (
                  <button className="phone-primary" onClick={props.refresh}>
                    重新加载
                  </button>
                )}
              </div>
            )}
          </fieldset>
          <div className="phone-home-indicator" aria-hidden="true">
            <span />
          </div>
        </section>
      </div>
      <footer className="phone-stage-footer">
        <span>QINGXING / CAMPUS RIDE</span>
        <span>
          <span className="phone-connection-dot" />
          与校园系统共享账户与数据
        </span>
      </footer>
    </div>
  );
}
