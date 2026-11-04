import { useEffect, useId, useState } from "react";
import { Bike, MapPin, Minus, Plus, RotateCcw } from "lucide-react";
import campus from "../../database/campus-map.json";
import campusMap from "./assets/buaa-xueyuan-campus-map.jpg";
import { api } from "./api";
import type { Row, User } from "./types";

export function CampusMap({
  zones,
  bikes,
  onSelect,
  route,
  role = "STUDENT",
  tickets = [],
  dispatches = [],
  graphRefresh,
}: {
  zones: Row[];
  bikes: Row[];
  onSelect?: (z: Row) => void;
  route?: any;
  role?: User["role"];
  tickets?: Row[];
  dispatches?: Row[];
  graphRefresh?: object;
}) {
  const [selected, setSelected] = useState<number>();
  const [zoom, setZoom] = useState(1);
  const [mapStatus, setMapStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const [graph, setGraph] = useState<{ nodes: Row[]; edges: Row[] }>();
  const [graphError, setGraphError] = useState("");
  const [layers, setLayers] = useState({
    roads: false,
    areas: true,
    restrictions: true,
    tasks: role !== "STUDENT",
  });
  const id = useId();
  const maxX = campus.width;
  const maxY = campus.height;
  const nodes: Row[] = route?.nodes || graph?.nodes || [];
  const edges: Row[] = route?.edges || graph?.edges || [];
  const nodesById = new Map(nodes.map((node) => [Number(node.id), node]));
  const selectedZone = zones.find((zone) => zone.id === selected);
  const taskZones = new Map<number, number>();
  const bikesById = new Map(bikes.map((bike) => [Number(bike.id), bike]));
  const addTask = (zoneId: unknown) => {
    const id = Number(zoneId);
    if (id) taskZones.set(id, (taskZones.get(id) || 0) + 1);
  };
  for (const ticket of tickets) {
    if (ticket.status === "COMPLETED") continue;
    addTask(bikesById.get(Number(ticket.bike_id))?.current_zone_id);
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
    if (zone.status === "CLOSED" || Number(zone.restricted)) return "closed";
    if (Number(zone.occupied) + Number(zone.reserved) >= Number(zone.capacity))
      return "full";
    if (Number(zone.borrowable) <= 2) return "low";
    return "available";
  };
  const points = (route?.path || [])
    .map((id: number) => nodesById.get(Number(id)))
    .filter(Boolean)
    .map((n: Row) => `${n.x},${n.y}`)
    .join(" ");
  const select = (z: Row) => {
    setSelected(z.id);
    onSelect?.(z);
  };
  useEffect(() => setSelected(undefined), [zones.length]);
  useEffect(() => {
    if (!layers.roads || route) return;
    let active = true;
    const controller = new AbortController();
    setGraph(undefined);
    setGraphError("");
    api<{ nodes: Row[]; edges: Row[] }>("/road-graph", undefined, {
      signal: controller.signal,
    })
      .then((value) => {
        if (active) setGraph(value);
      })
      .catch((error) => {
        if (active) setGraphError((error as Error).message);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [layers.roads, route, graphRefresh]);
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
            ? "仅右上角步行区禁行  请沿标记边界绕行"
            : "查看停车点与唯一禁行区  建筑颜色表示功能分区"}
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
          ["areas", "功能分区"],
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
      </div>
      {layers.roads && !route && !graph && (
        <p className="muted" role="status">
          {graphError
            ? `路网加载失败：${graphError}；可关闭图层后重试`
            : "正在加载路网…"}
        </p>
      )}
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
          <title>北京航空航天大学学院路校区 建筑与停车点</title>
          <desc>北航学院路校区建筑、道路、停车点和禁行区域示意图</desc>
          <defs>
            <pattern
              id={`${id}-restricted`}
              width="12"
              height="12"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="12" height="12" fill="#ef795f" opacity=".08" />
              <rect width="3" height="12" fill="#ef795f" opacity=".3" />
            </pattern>
          </defs>
          <rect width={maxX} height={maxY} fill="#f2f7f7" />
          <image
            href={campusMap}
            {...campus.plan}
            aria-label="北航官网学院路校区平面图"
            onLoad={() => setMapStatus("ready")}
            onError={() => setMapStatus("error")}
          />
          {layers.areas &&
            campus.areas.map((area) => (
              <g
                key={area.id}
                className={`map-functional-area map-area-${area.kind.toLowerCase()}`}
                role="img"
                aria-label={area.name}
              >
                <title>{area.name}</title>
                <polygon
                  points={area.points.map((point) => point.join(",")).join(" ")}
                />
                <text x={area.label[0]} y={area.label[1]} textAnchor="middle">
                  {area.kind === "CULTURE"
                    ? "文体区"
                    : area.kind === "SCIENCE"
                      ? "科技园"
                      : area.name}
                </text>
              </g>
            ))}
          {layers.roads && (
            <g className="map-roads-on-plan" fill="none" strokeLinecap="round">
              {edges.map((edge) => {
                const a = nodesById.get(Number(edge.from_node_id));
                const b = nodesById.get(Number(edge.to_node_id));
                const status = edge.status || "OPEN";
                return a && b ? (
                  <path
                    key={edge.id}
                    data-road-status={status}
                    d={"M" + a.x + " " + a.y + " L" + b.x + " " + b.y}
                    stroke={
                      status === "OPEN"
                        ? "#087f91"
                        : status === "CLOSED"
                          ? "#b52238"
                          : "#b04c05"
                    }
                    strokeWidth={status === "OPEN" ? "4" : "5"}
                    strokeOpacity={status === "OPEN" ? ".65" : "1"}
                    strokeDasharray={
                      status === "OPEN"
                        ? undefined
                        : status === "CLOSED"
                          ? "4 5"
                          : "9 7"
                    }
                  />
                ) : null;
              })}
            </g>
          )}
          {layers.restrictions &&
            campus.restricted_areas.map((area) => {
              return (
                <g
                  key={area.id}
                  className="map-restricted-area"
                  role="img"
                  aria-label={area.name}
                >
                  <title>
                    {area.name}：{area.reason}
                  </title>
                  <polygon
                    points={area.points
                      .map((point) => point.join(","))
                      .join(" ")}
                    fill={`url(#${id}-restricted)`}
                  />
                  <text x={area.label[0]} y={area.label[1]} textAnchor="middle">
                    {area.label_text}
                  </text>
                  {area.boundary_markers.map((marker) => (
                    <g key={marker.name} className="map-boundary-marker">
                      <title>{marker.name}</title>
                      <line
                        x1={marker.x}
                        y1={marker.y}
                        x2={marker.label[0]}
                        y2={marker.label[1]}
                      />
                      <circle cx={marker.x} cy={marker.y} r="4" />
                      <text
                        x={marker.label[0]}
                        y={marker.label[1]}
                        textAnchor="middle"
                      >
                        {marker.name}
                      </text>
                    </g>
                  ))}
                </g>
              );
            })}
          <g className="map-official-labels">
            {campus.landmarks.map((place) => (
              <g
                key={place.name}
                className={
                  ["主楼", "三号教学楼", "图书馆", "新主楼"].includes(
                    place.name,
                  )
                    ? "landmark-primary"
                    : "landmark-secondary"
                }
                transform={"translate(" + place.x + " " + place.y + ")"}
              >
                <rect
                  x={-Math.max(68, place.name.length * 14 + 20) / 2}
                  y="-17"
                  width={Math.max(68, place.name.length * 14 + 20)}
                  height="28"
                  rx="7"
                />
                <text textAnchor="middle" y="5">
                  {place.name}
                </text>
              </g>
            ))}
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
                stroke={
                  route?.mode === "safe"
                    ? "#278e77"
                    : route?.mode === "comfortable"
                      ? "#8d64be"
                      : "#db7538"
                }
                strokeWidth="8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}
          {[...zones]
            .sort(
              (a, b) => Number(a.id === selected) - Number(b.id === selected),
            )
            .map((z) => {
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
                  aria-label={`${z.name}，可借 ${z.borrowable} 辆，剩余车位 ${remaining} 个${Number(z.restricted) ? "，禁行区内" : ""}${taskCount ? `，关联任务 ${taskCount} 项` : ""}`}
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
                    {z.name} {z.location} 可借 {z.borrowable} 辆 剩余车位{" "}
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
                  {selected === z.id && (
                    <circle
                      className="station-fence"
                      cx={z.x}
                      cy={z.y}
                      r={z.radius}
                    />
                  )}
                  <circle className="station-marker" cx={z.x} cy={z.y} r="17" />
                  <text
                    x={z.x}
                    y={Number(z.y) + 5}
                    textAnchor="middle"
                    fontSize="14"
                    fontWeight="700"
                    fill="#fff"
                  >
                    {z.borrowable}
                  </text>
                  <rect
                    className="station-label"
                    x={Number(z.x) - Math.max(42, z.name.length * 7 + 8)}
                    y={Number(z.y) + 20}
                    width={Math.max(84, z.name.length * 14 + 16)}
                    height="24"
                    rx="6"
                  />
                  <text
                    x={z.x}
                    y={Number(z.y) + 37}
                    textAnchor="middle"
                    fontSize="14"
                    fill="#254778"
                  >
                    {z.name}
                  </text>
                </g>
              );
            })}
        </svg>
        {mapStatus === "error" && (
          <div className="map-image-status" role="status">
            <span>
              校区图未能加载，请使用右侧停车点列表，或
              <a href={campus.planSource} target="_blank" rel="noreferrer">
                查看北航官网原图
              </a>
            </span>
          </div>
        )}
      </div>
      <div className="map-legend">
        {layers.roads && (
          <span>路网　青色开放　红色短虚线关闭　橙色长虚线禁行</span>
        )}
        <span>
          <i className="legend-teaching-area" />
          教学科研区
        </span>
        <span>
          <i className="legend-student-area" />
          学生公寓（含大运村）
        </span>
        <span>
          <i className="legend-family-area" />
          家属区
        </span>
        <span>
          <i className="legend-culture-area" />
          文体活动区
        </span>
        <span>
          <i className="legend-science-area" />
          科技园
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
          右上角唯一禁行区
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
                <dd>{selectedZone.borrowable} 辆</dd>
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
              {Number(selectedZone.restricted)
                ? "该停车点位于禁行区内，暂停借车，请联系管理员处理"
                : role === "STUDENT"
                  ? "借车前核对车源，归还前核对剩余车位"
                  : role === "ADMIN"
                    ? "可结合容量、故障与调度状态安排运营处理"
                    : "到站前核对工单与调度任务，完成后及时回填"}
            </p>
          </div>
        ) : (
          <span className="map-overview-count">
            <span>全校 {zones.length} 个停车点</span>
            <span>
              {zones.reduce((sum, zone) => sum + Number(zone.borrowable), 0)}{" "}
              辆可借
            </span>
          </span>
        )}
      </div>
    </section>
  );
}
