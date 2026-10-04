import { useEffect, useId, useState } from "react";
import {
  Bike,
  MapPin,
  Minus,
  Plus,
  RotateCcw,
  ExternalLink,
} from "lucide-react";
import campus from "../database/campus-map.json";
import type { Row } from "./types";

const landmarks = [
  {
    name: "主楼",
    sub: "主北 · 主南",
    x: 755,
    y: 273,
    w: 120,
    h: 133,
    kind: "academic",
  },
  {
    name: "图书馆",
    sub: "学习 · 阅读",
    x: 582,
    y: 320,
    w: 106,
    h: 75,
    kind: "academic",
  },
  {
    name: "新主楼",
    sub: "教学科研区",
    x: 738,
    y: 725,
    w: 135,
    h: 96,
    kind: "academic",
  },
  {
    name: "合一楼",
    sub: "校园食堂",
    x: 342,
    y: 508,
    w: 143,
    h: 68,
    kind: "dining",
  },
  {
    name: "北区学生公寓",
    sub: "学生生活区",
    x: 313,
    y: 122,
    w: 214,
    h: 72,
    kind: "living",
  },
  {
    name: "知行楼",
    sub: "南楼 · 北楼",
    x: 444,
    y: 465,
    w: 84,
    h: 35,
    kind: "living",
  },
  {
    name: "学生公寓",
    sub: "学生生活区",
    x: 313,
    y: 465,
    w: 114,
    h: 35,
    kind: "living",
  },
  { name: "行政办公楼", x: 580, y: 487, w: 110, h: 60, kind: "academic" },
  { name: "如心楼", x: 580, y: 579, w: 110, h: 55, kind: "academic" },
  {
    name: "航空航天博物馆",
    lines: ["航空航天", "博物馆"],
    x: 750,
    y: 486,
    w: 126,
    h: 101,
    kind: "culture",
  },
  { name: "逸夫科学馆", x: 750, y: 608, w: 126, h: 43, kind: "culture" },
  {
    name: "北航体育馆",
    lines: ["北航体育馆"],
    x: 582,
    y: 728,
    w: 107,
    h: 69,
    kind: "sport",
  },
  { name: "晨兴音乐厅", x: 312, y: 877, w: 170, h: 49, kind: "culture" },
  {
    name: "大运村",
    sub: "学生公寓",
    x: 121,
    y: 872,
    w: 135,
    h: 63,
    kind: "living",
  },
  { name: "为民楼", x: 585, y: 888, w: 104, h: 53, kind: "academic" },
  {
    name: "教学科研区",
    sub: "三号楼 · 四号楼",
    x: 590,
    y: 127,
    w: 282,
    h: 65,
    kind: "academic",
  },
];

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
  const [zoom, setZoom] = useState(1);
  const [picked, setPicked] = useState<{ x: number; y: number }>();
  const id = useId();
  const maxX = Math.max(
    campus.width,
    ...zones.map((z) => Number(z.x) + Number(z.radius) + 65),
  );
  const maxY = Math.max(
    campus.height,
    ...zones.map((z) => Number(z.y) + Number(z.radius) + 65),
  );
  const nodes: Row[] = route?.nodes || campus.nodes;
  const edges: Row[] = route?.edges || campus.edges;
  const points = (route?.path || [])
    .map((id: number) => nodes.find((n) => n.id === id))
    .filter(Boolean)
    .map((n: Row) => `${n.x},${n.y}`)
    .join(" ");
  const select = (z: Row) => {
    setSelected(z.id);
    setPicked(undefined);
    onSelect?.(z);
  };
  useEffect(() => setSelected(undefined), [zones.length]);
  return (
    <section className="map-shell" aria-label="学院路校区出行地图">
      <div className="map-title">
        <div>
          <span className="map-kicker">
            <MapPin size={14} /> BEIHANG UNIVERSITY
          </span>
          <h2>{campus.name}</h2>
        </div>
        <span className="map-live">校园出行地图</span>
      </div>
      <div className="map-tools">
        <span>
          {onPoint
            ? "点击停车点或地图，设置归还位置"
            : "点击停车点查看可借车辆"}
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
          onClick={(e) => {
            if (!onPoint) return;
            const p = e.currentTarget.createSVGPoint();
            p.x = e.clientX;
            p.y = e.clientY;
            const matrix = e.currentTarget.getScreenCTM();
            if (matrix) {
              const c = p.matrixTransform(matrix.inverse());
              const point = { x: Math.round(c.x), y: Math.round(c.y) };
              setPicked(point);
              setSelected(undefined);
              onPoint(point.x, point.y);
            }
          }}
        >
          <title>北京航空航天大学学院路校区 · 建筑与停车点</title>
          <desc>
            北侧为北四环中路，东侧为学院路，南侧为知春路。主楼在东侧，图书馆和绿园位于其西侧，新主楼与体育场位于南部。按官方平面图绘制的教学示意图。
          </desc>
          <defs>
            <pattern
              id={`${id}-dots`}
              width="24"
              height="24"
              patternUnits="userSpaceOnUse"
            >
              <circle cx="2" cy="2" r="1" fill="#dddcd4" />
            </pattern>
          </defs>
          <rect width={maxX} height={maxY} fill="#f5f2ea" />
          <rect width={maxX} height={maxY} fill={`url(#${id}-dots)`} />
          <path
            d="M90 83 H936 V961 H310 L90 805 Z"
            fill="#fdfbf5"
            stroke="#bac7cb"
            strokeWidth="3"
            strokeDasharray="8 7"
          />
          <path
            d="M70 58 H950 M958 76 V965 M300 985 H946 M64 470 V791"
            stroke="#dce3e7"
            strokeWidth="23"
            fill="none"
            strokeLinecap="round"
          />
          <g className="map-road-name">
            <text x="512" y="64" textAnchor="middle">
              北四环中路
            </text>
            <text
              x="974"
              y="523"
              textAnchor="middle"
              transform="rotate(90 974 523)"
            >
              学院路
            </text>
            <text x="635" y="992" textAnchor="middle">
              知春路
            </text>
            <text
              x="57"
              y="625"
              textAnchor="middle"
              transform="rotate(-90 57 625)"
            >
              大运路
            </text>
          </g>
          <g className="map-neighborhood">
            {[124, 292, 486, 694].map((y, i) => (
              <g key={y}>
                <rect
                  x="107"
                  y={y}
                  width="146"
                  height={i === 3 ? 139 : 126}
                  rx="10"
                />
                {[0, 1, 2].map((j) => (
                  <rect
                    key={j}
                    className="map-home"
                    x="119"
                    y={y + 15 + j * 31}
                    width="119"
                    height="19"
                    rx="3"
                  />
                ))}
              </g>
            ))}
            <text x="178" y="454" textAnchor="middle">
              家属生活区
            </text>
          </g>
          <g className="map-garden">
            <rect x="306" y="278" width="227" height="127" rx="16" />
            <path
              d="M324 297 Q380 357 335 389 M314 356 Q439 303 521 382 M430 283 Q405 369 479 397"
              fill="none"
              stroke="#fffdf2"
              strokeWidth="7"
            />
            <ellipse
              cx="495"
              cy="352"
              rx="26"
              ry="40"
              fill="#a7d5e5"
              stroke="#e9f6f4"
              strokeWidth="4"
            />
            <text x="397" y="350" textAnchor="middle">
              绿园
            </text>
          </g>
          <g className="map-south-garden">
            <rect x="742" y="878" width="145" height="67" rx="19" />
            <path
              d="M756 917 Q806 870 872 932"
              fill="none"
              stroke="#f9fbef"
              strokeWidth="7"
            />
            <text x="812" y="918" textAnchor="middle">
              校园绿地
            </text>
          </g>
          <g className="map-track">
            <rect x="310" y="726" width="220" height="116" rx="55" />
            <rect x="323" y="739" width="194" height="90" rx="42" />
            <rect x="337" y="752" width="166" height="64" rx="30" />
            <path
              d="M420 753 V815 M365 762 H475 V807 H365 Z"
              fill="none"
              stroke="#fafff4"
              strokeWidth="2"
            />
            <text x="420" y="791" textAnchor="middle">
              体育场
            </text>
          </g>
          <g
            className="map-roads"
            fill="none"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {edges.map((e) => {
              const a = nodes.find((n) => n.id === e.from_node_id),
                b = nodes.find((n) => n.id === e.to_node_id);
              return a && b ? (
                <path
                  key={e.id}
                  d={`M${a.x} ${a.y} L${b.x} ${b.y}`}
                  stroke="#e4dfd3"
                  strokeWidth="26"
                />
              ) : null;
            })}
            {edges.map((e) => {
              const a = nodes.find((n) => n.id === e.from_node_id),
                b = nodes.find((n) => n.id === e.to_node_id);
              return a && b ? (
                <path
                  key={e.id}
                  d={`M${a.x} ${a.y} L${b.x} ${b.y}`}
                  stroke="#fffefa"
                  strokeWidth="20"
                />
              ) : null;
            })}
          </g>
          <g className="map-street-name">
            <text x="682" y="219" textAnchor="middle">
              校园北路
            </text>
            <text x="417" y="442" textAnchor="middle">
              校园中路
            </text>
            <text x="807" y="692" textAnchor="middle">
              校园南路
            </text>
            <text
              x="548"
              y="560"
              textAnchor="middle"
              transform="rotate(-90 548 560)"
            >
              校园东路
            </text>
            <text
              x="269"
              y="539"
              textAnchor="middle"
              transform="rotate(-90 269 539)"
            >
              校园西路
            </text>
          </g>
          {landmarks.map((b) => (
            <g key={b.name} className={`map-building building-${b.kind}`}>
              <title>{b.name}</title>
              <rect
                x={b.x + 3}
                y={b.y + 4}
                width={b.w}
                height={b.h}
                rx="7"
                className="building-shadow"
              />
              <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="7" />
              <path
                d={`M${b.x + 11} ${b.y + 10} H${b.x + b.w - 11}`}
                stroke="currentColor"
                strokeWidth="3"
                opacity=".25"
              />
              <text
                x={b.x + b.w / 2}
                y={b.y + b.h / 2 + (b.lines ? -8 : b.sub && b.h > 45 ? -1 : 7)}
                textAnchor="middle"
                fontSize={b.w < 125 ? 18 : 21}
              >
                {b.lines
                  ? b.lines.map((line, i) => (
                      <tspan key={line} x={b.x + b.w / 2} dy={i === 0 ? 0 : 24}>
                        {line}
                      </tspan>
                    ))
                  : b.name}
              </text>
              {b.sub && b.h > 45 && (
                <text
                  className="building-sub"
                  x={b.x + b.w / 2}
                  y={b.y + b.h / 2 + 23}
                  textAnchor="middle"
                >
                  {b.sub}
                </text>
              )}
            </g>
          ))}
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
          {zones.map((z) => (
            <g
              key={z.id}
              className={`map-station${selected === z.id ? " is-selected" : ""}`}
              tabIndex={0}
              role="button"
              aria-pressed={selected === z.id}
              aria-label={`${z.name}，可借 ${z.available} 辆`}
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
                {z.name} · {z.location} · 可借 {z.available} 辆
              </title>
              <circle
                className="station-fence"
                cx={z.x}
                cy={z.y}
                r={z.radius}
              />
              <circle
                className="station-marker"
                cx={z.x}
                cy={z.y}
                r="21"
                fill={z.status === "CLOSED" ? "#64748b" : "#285bcc"}
              />
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
          ))}
          {picked && (
            <g className="map-picked" pointerEvents="none">
              <circle
                cx={picked.x}
                cy={picked.y}
                r="11"
                fill="#ee7742"
                stroke="#fff"
                strokeWidth="4"
              />
              <path
                d={`M${picked.x - 19} ${picked.y} H${picked.x + 19} M${picked.x} ${picked.y - 19} V${picked.y + 19}`}
                stroke="#cc5523"
                strokeWidth="2"
              />
            </g>
          )}
        </svg>
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
          停车围栏
        </span>
      </div>
      <div className="map-selection" aria-live="polite">
        <Bike size={16} />
        {selected ? (
          <span>
            <strong>{zones.find((z) => z.id === selected)?.name}</strong> · 可借{" "}
            {zones.find((z) => z.id === selected)?.available} 辆
          </span>
        ) : picked ? (
          <span>
            已选归还位置：{picked.x}，{picked.y} 米
          </span>
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
        <span>{campus.note}</span>
      </p>
    </section>
  );
}
