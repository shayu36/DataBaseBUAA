import { useId, useState } from "react";
import { LocateFixed, Minus, Plus, RotateCcw } from "lucide-react";
import campus from "../../../database/campus-map.json";
import campusMap from "../assets/buaa-xueyuan-campus-map.jpg";
import type { Row } from "../types";

/** Uses the same campus coordinates and restriction polygons as the desktop map */
export function PhoneMap({
  zones,
  selected,
  onSelect,
}: {
  zones: Row[];
  selected?: Row;
  onSelect: (zone: Row) => void;
}) {
  const [zoom, setZoom] = useState(2);
  const [focused, setFocused] = useState(true);
  const [failed, setFailed] = useState(false);
  const id = useId();
  const width = campus.width / zoom;
  const height = campus.height / zoom;
  const cx = focused && selected ? Number(selected.x) : campus.width / 2;
  const cy = focused && selected ? Number(selected.y) : campus.height / 2;
  const x = Math.max(0, Math.min(campus.width - width, cx - width / 2));
  const y = Math.max(0, Math.min(campus.height - height, cy - height / 2));
  return (
    <div className="phone-map">
      <svg
        viewBox={`${x} ${y} ${width} ${height}`}
        preserveAspectRatio={focused ? "xMidYMid slice" : "xMidYMid meet"}
        role="group"
        aria-label="手机校园停车点地图"
      >
        <title>北航学院路校区停车点与禁行区域</title>
        <defs>
          <pattern
            id={id}
            width="12"
            height="12"
            patternUnits="userSpaceOnUse"
            patternTransform="rotate(45)"
          >
            <rect width="12" height="12" fill="#ee9264" fillOpacity=".14" />
            <rect width="3" height="12" fill="#cf672f" fillOpacity=".35" />
          </pattern>
        </defs>
        <image
          href={campusMap}
          {...campus.plan}
          onError={() => setFailed(true)}
        />
        {campus.restricted_areas.map((area) => (
          <polygon
            key={area.id}
            points={area.points.map((p) => p.join(",")).join(" ")}
            fill={`url(#${id})`}
            stroke="#ce793f"
            strokeWidth="2"
          >
            <title>{area.name}</title>
          </polygon>
        ))}
        {[...zones]
          .sort(
            (a, b) =>
              Number(a.id === selected?.id) - Number(b.id === selected?.id),
          )
          .map((zone) => {
            const active = zone.id === selected?.id;
            const closed =
              zone.status !== "ACTIVE" || Boolean(Number(zone.restricted));
            return (
              <g
                key={zone.id}
                role="button"
                tabIndex={0}
                aria-label={`选择停车点 ${zone.name}`}
                aria-pressed={active}
                onClick={() => onSelect(zone)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(zone);
                  }
                }}
                className="phone-map-pin"
                transform={`translate(${zone.x} ${zone.y})`}
              >
                <title>
                  {zone.name} · 可借 {zone.borrowable} 辆
                </title>
                {active && (
                  <circle
                    r="42"
                    fill="#407cec"
                    fillOpacity=".15"
                    stroke="#407cec"
                    strokeWidth="2"
                  />
                )}
                <circle
                  r="21"
                  fill={closed ? "#8b94a3" : active ? "#235fce" : "#547fc6"}
                  stroke="white"
                  strokeWidth="4"
                />
                <text
                  textAnchor="middle"
                  y="7"
                  fill="white"
                  fontSize="21"
                  fontWeight="600"
                >
                  P
                </text>
                {active && (
                  <g
                    transform={`translate(${Math.max(x + 70, Math.min(x + width - 70, Number(zone.x))) - Number(zone.x)} 0)`}
                  >
                    <rect
                      x="-65"
                      y="30"
                      width="130"
                      height="30"
                      rx="8"
                      fill="white"
                    />
                    <text
                      textAnchor="middle"
                      y="51"
                      fill="#244574"
                      fontSize="18"
                    >
                      {zone.name}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
      </svg>
      <div className="phone-map-zoom">
        <button
          type="button"
          aria-label="放大地图"
          disabled={zoom >= 3}
          onClick={() => setZoom((z) => Math.min(3, z + 0.5))}
        >
          <Plus size={17} />
        </button>
        <button
          type="button"
          aria-label="缩小地图"
          disabled={zoom <= 1}
          onClick={() => setZoom((z) => Math.max(1, z - 0.5))}
        >
          <Minus size={17} />
        </button>
        <button
          type="button"
          aria-label="显示全校地图"
          onClick={() => {
            setZoom(1);
            setFocused(false);
          }}
        >
          <RotateCcw size={15} />
        </button>
      </div>
      <button
        type="button"
        className="phone-locate"
        disabled={!selected}
        onClick={() => {
          setFocused(true);
          setZoom(2);
        }}
      >
        <LocateFixed size={15} />
        定位到停车点
      </button>
      <span className="phone-map-key">
        <i />
        停车点 <i />
        禁行区
      </span>
      {failed && (
        <p className="phone-map-failure" role="status">
          底图加载失败，可在下方选择停车点
        </p>
      )}
    </div>
  );
}
