import { useEffect, useId, useState } from "react";
import {
  Bike,
  MapPin,
  Minus,
  Plus,
  RotateCcw,
  ExternalLink,
} from "lucide-react";
import campus from "../../database/campus-map.json";
import type { Row, User } from "./types";

const landmarks = [
  { name: "主楼", x: 737, y: 263 },
  { name: "三号教学楼", x: 740, y: 104 },
  { name: "图书馆", x: 426, y: 123 },
  { name: "新主楼", x: 792, y: 637 },
  { name: "合一楼", x: 372, y: 439 },
  { name: "北航体育馆", x: 625, y: 562 },
  { name: "航空航天博物馆", x: 762, y: 414 },
  { name: "绿园", x: 405, y: 254 },
  { name: "家属区", x: 192, y: 861 },
  { name: "学院路", x: 850, y: 402 },
  { name: "知春路", x: 532, y: 933 },
];

export function CampusMap({
  zones,
  bikes,
  onSelect,
  route,
  role = "STUDENT",
  tickets = [],
  dispatches = [],
}: {
  zones: Row[];
  bikes: Row[];
  onSelect?: (z: Row) => void;
  route?: any;
  role?: User["role"];
  tickets?: Row[];
  dispatches?: Row[];
}) {
  const [selected, setSelected] = useState<number>();
  const [zoom, setZoom] = useState(1);
  const [mapStatus, setMapStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [layers, setLayers] = useState({
    roads: false,
    restrictions: true,
    tasks: role !== "STUDENT",
  });
  const id = useId();
  const maxX = campus.width;
  const maxY = campus.height;
  const nodes: Row[] = route?.nodes || campus.nodes;
  const edges: Row[] = route?.edges || campus.edges;
  const openEdges = edges.filter((edge) => edge.status !== "NO_RIDE");
  const forbiddenEdges = edges.filter((edge) => edge.status === "NO_RIDE");
  const selectedZone = zones.find((zone) => zone.id === selected);
  const taskZones = new Map<number, number>();
  const addTask = (zoneId: unknown) => {
    const id = Number(zoneId);
    if (id) taskZones.set(id, (taskZones.get(id) || 0) + 1);
  };
  for (const ticket of tickets) {
    if (ticket.status === "COMPLETED") continue;
    addTask(bikes.find((bike) => bike.id === ticket.bike_id)?.current_zone_id);
  }
  for (const task of dispatches) {
    if (!["PENDING", "IN_PROGRESS"].includes(task.status)) continue;
    addTask(task.source_zone_id);
    addTask(task.target_zone_id);
  }
  const mapLabel = {
    STUDENT: "学生骑行地图",
    ADMIN: "管理员运营地图",
    OPERATOR: "运维任务地图",
  }[role];
  const mapBadge = {
    STUDENT: "找车与还车",
    ADMIN: "全校运营态势",
    OPERATOR: "现场任务分布",
  }[role];
  const stationState = (zone: Row) => {
    if (zone.status === "CLOSED") return "closed";
    if (Number(zone.occupied) + Number(zone.reserved) >= Number(zone.capacity))
      return "full";
    if (Number(zone.available) <= 2) return "low";
    return "available";
  };
  const points = (route?.path || [])
    .map((id: number) => nodes.find((n) => n.id === id))
    .filter(Boolean)
    .map((n: Row) => `${n.x},${n.y}`)
    .join(" ");
  const select = (z: Row) => {
    setSelected(z.id);
    onSelect?.(z);
  };
  useEffect(() => setSelected(undefined), [zones.length]);
  return (
    <section
      className={`map-shell map-role-${role.toLowerCase()}`}
      aria-label={mapLabel}
    >
      <div className="map-title">
        <div>
          <span className="map-kicker">
            <MapPin size={14} /> BEIHANG UNIVERSITY
          </span>
          <h2>{campus.name}</h2>
        </div>
        <span className="map-live">{mapBadge}</span>
      </div>
      <div className="map-tools">
        <span>
          {role === "STUDENT"
            ? "选择停车点借车与还车；红色区域禁止骑行"
            : "点击停车点查看库存、容量和任务状态"}
        </span>
        <div className="map-zoom">
          <button
            className="secondary tiny"
            aria-label="缩小地图"
            disabled={zoom === 1}
            onClick={() => setZoom((z) => Math.max(1, z - 0.25))}
          >
            <Minus size={14} />
          </button>
          <output aria-label="地图缩放比例">{Math.round(zoom * 100)}%</output>
          <button
            className="secondary tiny"
            aria-label="放大地图"
            disabled={zoom >= 2}
            onClick={() => setZoom((z) => Math.min(2, z + 0.25))}
          >
            <Plus size={14} />
          </button>
          <button
            className="secondary tiny"
            aria-label="重置地图缩放"
            onClick={() => setZoom(1)}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>
      <div className="map-layer-controls" aria-label="地图图层">
        <strong>地图图层</strong>
        {[
          ["roads", "模拟路网"],
          ["restrictions", "禁行区域"],
          ...(role === "STUDENT" ? [] : [["tasks", "任务标记"]]),
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={layers[key as keyof typeof layers] ? "active" : ""}
            aria-pressed={layers[key as keyof typeof layers]}
            onClick={() =>
              setLayers((current) => ({
                ...current,
                [key]: !current[key as keyof typeof current],
              }))
            }
          >
            {label}
          </button>
        ))}
        <span>官方底图展示全校道路；家属区道路纳入骑行范围</span>
      </div>
      <div
        className="map-viewport"
        tabIndex={0}
        aria-label="可滚动地图，窄屏可左右滑动查看建筑"
      >
        <svg
          className="campus-svg"
          role="group"
          aria-label="北航学院路校区建筑、停车区和道路示意图"
          viewBox={`0 0 ${maxX} ${maxY}`}
          style={{ width: `${zoom * 100}%`, minWidth: 660 * zoom }}
        >
          <title>北京航空航天大学学院路校区 · 建筑与停车点</title>
          <desc>
            北航官网2026年学院路校区平面图。停车点、可骑行路段与禁行范围为课程模拟标注。
          </desc>
          <defs>
            <pattern
              id={`${id}-restricted`}
              width="12"
              height="12"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="12" height="12" fill="#fff1ed" />
              <rect width="4" height="12" fill="#ef795f" opacity=".42" />
            </pattern>
          </defs>
          <rect width={maxX} height={maxY} fill="#f2f7f7" />
          <image
            href="/buaa-xueyuan-campus-map.jpg"
            x="-100"
            y="-150"
            width="2048"
            height="1161"
            aria-label="北航官网学院路校区平面图"
            onLoad={() => setMapStatus("ready")}
            onError={() => setMapStatus("error")}
          />
          {layers.roads && (
            <g className="map-roads-on-plan" fill="none" strokeLinecap="round">
              {openEdges.map((edge) => {
                const a = nodes.find((node) => node.id === edge.from_node_id);
                const b = nodes.find((node) => node.id === edge.to_node_id);
                return a && b ? (
                  <path
                    key={edge.id}
                    d={"M" + a.x + " " + a.y + " L" + b.x + " " + b.y}
                    stroke="#087f91"
                    strokeWidth="4"
                    strokeOpacity=".48"
                  />
                ) : null;
              })}
              {forbiddenEdges.map((edge) => {
                const a = nodes.find((node) => node.id === edge.from_node_id);
                const b = nodes.find((node) => node.id === edge.to_node_id);
                return a && b ? (
                  <path
                    key={"closed-" + edge.id}
                    d={"M" + a.x + " " + a.y + " L" + b.x + " " + b.y}
                    stroke="#d94b55"
                    strokeWidth="5"
                    strokeDasharray="9 7"
                  />
                ) : null;
              })}
            </g>
          )}
          <g className="map-official-labels">
            {landmarks.map((place) => (
              <g
                key={place.name}
                transform={"translate(" + place.x + " " + place.y + ")"}
              >
                <rect x="-74" y="-18" width="148" height="33" rx="13" />
                <text textAnchor="middle" y="5">
                  {place.name}
                </text>
              </g>
            ))}
          </g>
          {layers.restrictions &&
            campus.restricted_areas.map((area) => {
              const center = area.points.reduce(
                (sum, point) => ({ x: sum.x + point[0], y: sum.y + point[1] }),
                { x: 0, y: 0 },
              );
              center.x /= area.points.length;
              center.y /= area.points.length;
              return (
                <g key={area.id} className="map-restricted-area">
                  <title>
                    {area.name}：{area.reason}
                  </title>
                  <polygon
                    points={area.points
                      .map((point) => point.join(","))
                      .join(" ")}
                    fill={`url(#${id}-restricted)`}
                  />
                  <text x={center.x} y={center.y - 5} textAnchor="middle">
                    {area.name}
                  </text>
                  <text
                    className="restricted-sub"
                    x={center.x}
                    y={center.y + 16}
                    textAnchor="middle"
                  >
                    禁止骑行 · 请沿外围道路绕行
                  </text>
                </g>
              );
            })}
          <g className="map-compass" transform="translate(123 91)">
            <path d="M0 40 L10 11 L20 40 L10 33Z" fill="#344b65" />
            <text x="10" y="4" textAnchor="middle">
              N 北
            </text>
          </g>
          <g className="map-gate">
            <text x="560" y="101" textAnchor="middle">
              北门
            </text>
            <text x="920" y="298" textAnchor="end">
              东门 · 学院路侧
            </text>
            <text x="560" y="962" textAnchor="middle">
              南门
            </text>
          </g>
          {points && (
            <>
              <polyline
                points={points}
                fill="none"
                stroke="#fff"
                strokeWidth="14"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <polyline
                className="map-route"
                points={points}
                fill="none"
                stroke="#f07837"
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}
          {zones.map((z) => {
            const state = stationState(z);
            const remaining = Math.max(
              0,
              Number(z.capacity) - Number(z.occupied) - Number(z.reserved),
            );
            const taskCount = taskZones.get(Number(z.id)) || 0;
            return (
              <g
                key={z.id}
                className={`map-station station-${state}${selected === z.id ? " is-selected" : ""}`}
                tabIndex={0}
                role="button"
                aria-pressed={selected === z.id}
                aria-label={`${z.name}，可借 ${z.available} 辆，剩余车位 ${remaining} 个${taskCount ? `，关联任务 ${taskCount} 项` : ""}`}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    select(z);
                  }
                }}
                onClick={(e) => {
                  e.stopPropagation();
                  select(z);
                }}
              >
                <title>
                  {z.name} · {z.location} · 可借 {z.available} 辆 · 剩余车位{" "}
                  {remaining} 个
                </title>
                {layers.tasks && taskCount > 0 && (
                  <>
                    <circle
                      className="station-task-halo"
                      cx={z.x}
                      cy={z.y}
                      r="31"
                    />
                    <text
                      className="station-task-count"
                      x={Number(z.x) + 25}
                      y={Number(z.y) - 21}
                    >
                      {taskCount}
                    </text>
                  </>
                )}
                <circle
                  className="station-fence"
                  cx={z.x}
                  cy={z.y}
                  r={z.radius}
                />
                <circle className="station-marker" cx={z.x} cy={z.y} r="21" />
                <text
                  x={z.x}
                  y={Number(z.y) + 7}
                  textAnchor="middle"
                  fontSize="20"
                  fontWeight="700"
                  fill="#fff"
                >
                  {z.available}
                </text>
                <rect
                  className="station-label"
                  x={Number(z.x) - Math.max(58, z.name.length * 10 + 9)}
                  y={Number(z.y) + 28}
                  width={Math.max(116, z.name.length * 20 + 18)}
                  height="31"
                  rx="8"
                />
                <text
                  x={z.x}
                  y={Number(z.y) + 50}
                  textAnchor="middle"
                  fontSize="19"
                  fill="#254778"
                >
                  {z.name}
                </text>
              </g>
            );
          })}
        </svg>
        {mapStatus !== "ready" && (
          <div className="map-image-status" role="status">
            {mapStatus === "loading" ? (
              <span>正在加载北航学院路校区平面图…</span>
            ) : (
              <span>
                校区图未能加载。请使用右侧停车点列表，或
                <a href={campus.planSource} target="_blank" rel="noreferrer">
                  查看北航官网原图
                </a>
                。
              </span>
            )}
          </div>
        )}
      </div>
      <div className="map-legend">
        <span>
          <i className="legend-academic" />
          教学 / 科研
        </span>
        <span>
          <i className="legend-living" />
          学生生活
        </span>
        <span>
          <i className="legend-dining" />
          餐饮
        </span>
        <span>
          <i className="legend-culture" />
          文体 / 场馆
        </span>
        <span>
          <i className="legend-station" />
          车源充足
        </span>
        <span>
          <i className="legend-low" />
          车辆紧张
        </span>
        <span>
          <i className="legend-full" />
          车位已满
        </span>
        <span>
          <i className="legend-restricted" />
          禁行区域
        </span>
      </div>
      <div
        className={`map-selection${selectedZone ? " has-selection" : ""}`}
        aria-live="polite"
      >
        <Bike size={16} />
        {selectedZone ? (
          <div className="station-detail">
            <div>
              <strong>{selectedZone.name}</strong>
              <small>{selectedZone.location}</small>
            </div>
            <dl>
              <div>
                <dt>可借</dt>
                <dd>{selectedZone.available} 辆</dd>
              </div>
              <div>
                <dt>剩余车位</dt>
                <dd>
                  {Math.max(
                    0,
                    Number(selectedZone.capacity) -
                      Number(selectedZone.occupied) -
                      Number(selectedZone.reserved),
                  )}{" "}
                  个
                </dd>
              </div>
              <div>
                <dt>已占用</dt>
                <dd>
                  {selectedZone.occupied}/{selectedZone.capacity}
                </dd>
              </div>
              <div>
                <dt>预留</dt>
                <dd>{selectedZone.reserved} 个</dd>
              </div>
              {role !== "STUDENT" && (
                <div>
                  <dt>关联任务</dt>
                  <dd>{taskZones.get(Number(selectedZone.id)) || 0} 项</dd>
                </div>
              )}
            </dl>
            <p>
              {role === "STUDENT"
                ? "借车前核对车源，归还前核对剩余车位。"
                : role === "ADMIN"
                  ? "可结合容量、故障与调度状态安排运营处理。"
                  : "到站前核对工单与调度任务，完成后及时回填。"}
            </p>
          </div>
        ) : (
          <span>
            全校 {zones.length} 个停车点 ·{" "}
            {bikes.filter((b) => b.status === "AVAILABLE").length} 辆可借
          </span>
        )}
        <span className="map-scroll-hint">可缩放 · 窄屏可横向滑动</span>
      </div>
      <p className="map-source">
        <a href={campus.source} target="_blank" rel="noreferrer">
          北航官方校区地图 <ExternalLink size={11} />
        </a>
        <a href={campus.planSource} target="_blank" rel="noreferrer">
          学院路校区平面图 <ExternalLink size={11} />
        </a>
        <span>{campus.note}</span>
      </p>
    </section>
  );
}
