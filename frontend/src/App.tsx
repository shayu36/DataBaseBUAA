import { useEffect, useRef, useState } from "react";
import {
  Bike,
  LayoutDashboard,
  Map,
  ClipboardList,
  Wrench,
  Truck,
  ChartNoAxesCombined,
  Leaf,
  Database,
  Settings,
  LogOut,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { api } from "./api";
import { Field } from "./components";
import {
  Overview,
  Rides,
  Orders,
  Maintenance,
  Dispatch,
  Analytics,
  RiskAlerts,
  Routes,
  Carbon,
  Schema,
  Admin,
} from "./pages";
import type { User, Dashboard } from "./types";
const navigation = [
  { id: "overview", name: "校园总览", icon: LayoutDashboard },
  { id: "rides", name: "骑行与归还", icon: Bike },
  { id: "orders", name: "骑行订单", icon: ClipboardList },
  { id: "routes", name: "路线规划", icon: Map },
  { id: "carbon", name: "碳积分", icon: Leaf },
  { id: "maintenance", name: "维修报修", icon: Wrench },
  {
    id: "dispatch",
    name: "车辆调度",
    icon: Truck,
    roles: ["ADMIN", "OPERATOR"],
  },
  {
    id: "analytics",
    name: "运营分析",
    icon: ChartNoAxesCombined,
    roles: ["ADMIN"],
  },
  { id: "risks", name: "风险处置", icon: Wrench, roles: ["OPERATOR"] },
  { id: "admin", name: "基础资料", icon: Settings, roles: ["ADMIN"] },
  { id: "schema", name: "数据库设计", icon: Database },
];
function BeijingDate() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const day = 24 * 60 * 60 * 1000;
    const offset = 8 * 60 * 60 * 1000;
    let timer: number;
    const schedule = () => {
      window.clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      timer = window.setTimeout(schedule, day - ((current + offset) % day));
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, []);
  return (
    <span className="date">
      {new Date(now).toLocaleDateString("zh-CN", {
        timeZone: "Asia/Shanghai",
        month: "long",
        day: "numeric",
        weekday: "long",
      })}
    </span>
  );
}
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  return (
    <div className="login-page">
      <section className="login-story">
        <a className="brand" href="/">
          <span>
            <Bike size={29} />
          </span>
          <div>
            青行<small>QINGXING</small>
          </div>
        </a>
        <span className="eyebrow">BEIHANG · XUEYUAN ROAD CAMPUS</span>
        <h1>让校园的每一程，更轻盈。</h1>
        <p>
          从主楼到新主楼，从图书馆到体育场。
          <br />
          一辆自行车，连接校园里的美好日常。
        </p>
        <div className="login-illustration">
          <div className="sun" />
          <div className="hill" />
          <Bike size={220} strokeWidth={1.2} />
          <span>RIDE A LITTLE. CHANGE A LOT.</span>
        </div>
        <small>
          北航学院路校区共享自行车课程系统 · 校园地图 / 模拟支付 / 模拟碳积分
        </small>
      </section>
      <section className="login-form">
        <div>
          <span className="eyebrow">WELCOME TO QINGXING</span>
          <h2>{register ? "加入青行" : "欢迎回来"}</h2>
          <p className="muted">登录，开启你的绿色校园生活。</p>
          <fieldset className="login-controls" disabled={busy} aria-busy={busy}>
            <div className="tabs">
              <button
                className={!register ? "" : "secondary"}
                onClick={() => {
                  setRegister(false);
                  setError("");
                }}
              >
                登录
              </button>
              <button
                className={register ? "" : "secondary"}
                onClick={() => {
                  setRegister(true);
                  setError("");
                }}
              >
                注册学生账户
              </button>
            </div>
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (inFlight.current) return;
                inFlight.current = true;
                setBusy(true);
                setError("");
                try {
                  const v = await api(
                    register ? "/auth/register" : "/auth/login",
                    { email, password, ...(register ? { name, phone } : {}) },
                  );
                  onLogin(v.user);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  inFlight.current = false;
                  setBusy(false);
                }
              }}
            >
              {register && (
                <>
                  <Field label="姓名">
                    <input
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      autoComplete="name"
                    />
                  </Field>
                  <Field label="手机号码">
                    <input
                      required
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      autoComplete="tel"
                    />
                  </Field>
                </>
              )}
              <Field label="邮箱">
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  autoComplete="username"
                  placeholder="你的校园邮箱"
                />
              </Field>
              <Field label="密码">
                <input
                  required
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={register ? "new-password" : "current-password"}
                  minLength={register ? 8 : 1}
                />
              </Field>
              {error && (
                <div role="alert" className="error">
                  {error}
                </div>
              )}
              <button className="login-submit" disabled={busy}>
                {busy ? "正在连接…" : register ? "注册并进入校园" : "登录青行"}
                <ArrowRight size={18} />
              </button>
            </form>
            <div className="demo">
              <span>课堂演示 · 选择身份后点击登录</span>
              {[
                ["jia", "管理员 · 贾鑫洋"],
                ["ouyang", "学生 · 欧阳晨"],
                ["zheng", "运营员 · 郑一凡"],
                ["wang", "学生 · 王奕"],
              ].map(([id, label]) => (
                <button
                  className="secondary"
                  key={id}
                  onClick={() => {
                    setEmail(id + "@qingxing.local");
                    setPassword("Qingxing2026!");
                    setRegister(false);
                    setError("");
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </section>
    </div>
  );
}
export default function App() {
  const [user, setUser] = useState<User>(),
    [d, setD] = useState<Dashboard>(),
    [page, setPage] = useState("overview"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [initial, setInitial] = useState(true);
  const inFlight = useRef(false);
  const fetchDashboard = async () => {
    try {
      setD(await api("/dashboard"));
      setError("");
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    }
  };
  const refresh = async () => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setNotice("");
    try {
      return await fetchDashboard();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    api("/auth/me")
      .then((v) => setUser(v.user))
      .catch(() => {})
      .finally(() => setInitial(false));
  }, []);
  useEffect(() => {
    if (user) refresh();
  }, [user]);
  async function run(path: string, body: any) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, body);
      const refreshed = await fetchDashboard();
      setNotice(
        refreshed
          ? "操作已保存，页面已刷新。"
          : "操作已保存，但页面刷新失败；请点击刷新数据获取最新状态。",
      );
      return true;
    } catch (e) {
      await fetchDashboard();
      setError((e as Error).message);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function logout() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/auth/logout", {});
      setUser(undefined);
      setD(undefined);
      setPage("overview");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  if (initial) return <div className="loading full">正在连接青行…</div>;
  if (!user) return <Login onLogin={setUser} />;
  const current = navigation.find((n) => n.id === page)!;
  const props = d ? { d, user, run } : undefined;
  const Page = (
    {
      overview: Overview,
      rides: Rides,
      orders: Orders,
      maintenance: Maintenance,
      dispatch: Dispatch,
      analytics: Analytics,
      risks: RiskAlerts,
      routes: Routes,
      carbon: Carbon,
      admin: Admin,
    } as any
  )[page];
  return (
    <div className="app">
      <aside className="sidebar" inert={busy}>
        <a className="brand" href="/">
          <span>
            <Bike size={29} />
          </span>
          <div>
            青行<small>QINGXING</small>
          </div>
        </a>
        <span className="nav-label">校园出行 CAMPUS</span>
        <nav>
          {navigation
            .filter((n) => !n.roles || n.roles.includes(user.role))
            .map((n) => (
              <button
                key={n.id}
                className={page === n.id ? "active" : ""}
                onClick={() => {
                  setPage(n.id);
                  setNotice("");
                  setError("");
                }}
              >
                <n.icon size={19} />
                {n.name}
                {page === n.id && <span className="nav-dot" />}
              </button>
            ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="green-note">
            <Leaf size={22} />
            <strong>
              每一次骑行
              <br />
              都是绿色的选择
            </strong>
            <small>让校园，也让生活更轻盈。</small>
          </div>
          <div className="user-card">
            <span className="avatar">{user.name.slice(-1)}</span>
            <div>
              <strong>{user.name}</strong>
              <small>
                {
                  (
                    {
                      ADMIN: "校园管理员",
                      STUDENT: "校园骑行者",
                      OPERATOR: "运营工作人员",
                    } as any
                  )[user.role]
                }
              </small>
            </div>
            <button aria-label="退出登录" onClick={logout}>
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="breadcrumb">
              北航学院路校区 · 青行 / {current.name}
            </span>
            <h1>{current.name}</h1>
          </div>
          <div className="header-right">
            <BeijingDate />
            <button
              className="icon-btn"
              aria-label="刷新数据"
              onClick={refresh}
              disabled={busy}
            >
              <RefreshCw size={18} className={busy ? "spin" : ""} />
            </button>
            <span className="avatar">{user.name.slice(-1)}</span>
          </div>
        </header>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {busy && (
          <div className="loading-line" role="status">
            正在同步数据…
          </div>
        )}
        <fieldset
          className="page-content"
          aria-busy={busy}
          inert={busy}
          disabled={busy}
        >
          {page === "schema" ? (
            <Schema />
          ) : props && Page ? (
            <Page {...props} />
          ) : (
            <div className="loading">正在读取校园数据…</div>
          )}
        </fieldset>
        <footer>
          青行 Qingxing · 校园共享自行车系统<span>轻盈出发，自在抵达。</span>
        </footer>
      </main>
    </div>
  );
}
