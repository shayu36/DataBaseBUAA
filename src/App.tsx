import { useEffect, useState } from "react";
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
  { id: "admin", name: "基础资料", icon: Settings, roles: ["ADMIN"] },
  { id: "schema", name: "数据库设计", icon: Database },
];
function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [register, setRegister] = useState(false),
    [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
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
        <span className="eyebrow">YOUR CAMPUS. YOUR WAY.</span>
        <h1>让校园的每一程，更轻盈。</h1>
        <p>
          从图书馆到课堂，从宿舍到操场。
          <br />
          一辆自行车，连接校园里的美好日常。
        </p>
        <div className="login-illustration">
          <div className="sun" />
          <div className="hill" />
          <Bike size={220} strokeWidth={1.2} />
          <span>RIDE A LITTLE. CHANGE A LOT.</span>
        </div>
        <small>校园共享自行车课程系统 · 本地地图 / 模拟支付 / 模拟碳积分</small>
      </section>
      <section className="login-form">
        <div>
          <span className="eyebrow">WELCOME TO QINGXING</span>
          <h2>{register ? "加入青行" : "欢迎回来"}</h2>
          <p className="muted">登录，开启你的绿色校园生活。</p>
          <div className="tabs">
            <button
              className={!register ? "" : "secondary"}
              onClick={() => setRegister(false)}
            >
              登录
            </button>
            <button
              className={register ? "" : "secondary"}
              onClick={() => setRegister(true)}
            >
              注册学生账户
            </button>
          </div>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
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
                minLength={8}
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
                }}
              >
                {label}
              </button>
            ))}
          </div>
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
  const refresh = async () => {
    setBusy(true);
    try {
      setD(await api("/dashboard"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
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
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(path, body);
      await refresh();
      setNotice("操作已保存，页面已刷新。");
      return true;
    } catch (e) {
      setError((e as Error).message);
      await refresh();
      setError((e as Error).message);
      return false;
    } finally {
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
      routes: Routes,
      carbon: Carbon,
      admin: Admin,
    } as any
  )[page];
  return (
    <div className="app">
      <aside className="sidebar">
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
            <button
              aria-label="退出登录"
              onClick={async () => {
                try {
                  await api("/auth/logout", {});
                  setUser(undefined);
                  setD(undefined);
                  setPage("overview");
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <span className="breadcrumb">青行校园 / {current.name}</span>
            <h1>{current.name}</h1>
          </div>
          <div className="header-right">
            <span className="date">
              {new Date().toLocaleDateString("zh-CN", {
                month: "long",
                day: "numeric",
                weekday: "long",
              })}
            </span>
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
        <div className="page-content" aria-busy={busy}>
          {page === "schema" ? (
            <Schema />
          ) : props && Page ? (
            <Page {...props} />
          ) : (
            <div className="loading">正在读取校园数据…</div>
          )}
        </div>
        <footer>
          青行 Qingxing · 校园共享自行车系统<span>轻盈出发，自在抵达。</span>
        </footer>
      </main>
    </div>
  );
}
