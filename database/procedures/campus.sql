-- MySQL stored procedures; transactions are owned by the caller.

DROP PROCEDURE IF EXISTS sp_capture_zone_snapshots;
DELIMITER $$
CREATE PROCEDURE sp_capture_zone_snapshots()
SQL SECURITY INVOKER
BEGIN
 INSERT INTO zone_snapshots(zone_id,available,occupied,capacity) SELECT id,available,occupied,capacity FROM v_zone_inventory;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_campus_restrictions;
DELIMITER $$
CREATE PROCEDURE sp_campus_restrictions(IN p_campus JSON, OUT p_areas GEOMETRY)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_geometries JSON;
 SET p_areas=NULL;
 IF NOT (JSON_TYPE(JSON_EXTRACT(p_campus,'$.version')) <=> 'STRING') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invalid campus version data.';
 END IF;
 IF EXISTS(SELECT 1 FROM system_settings WHERE name='campus_map'
  AND BINARY JSON_UNQUOTE(JSON_EXTRACT(value,'$.version'))=BINARY JSON_UNQUOTE(JSON_EXTRACT(p_campus,'$.version'))) THEN
  IF NOT (JSON_TYPE(JSON_EXTRACT(p_campus,'$.restricted_areas')) <=> 'ARRAY') THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invalid campus restriction data.';
  END IF;
  SELECT JSON_ARRAYAGG(JSON_OBJECT('type','Polygon','coordinates',
   JSON_ARRAY(JSON_ARRAY_APPEND(area.points,'$',JSON_EXTRACT(area.points,'$[0]'))))) INTO v_geometries
  FROM JSON_TABLE(p_campus,'$.restricted_areas[*]' COLUMNS(points JSON PATH '$.points',rule VARCHAR(20) PATH '$.rule')) area
  WHERE area.rule='NO_RIDE';
  IF v_geometries IS NOT NULL THEN
   SET p_areas=ST_GeomFromGeoJSON(JSON_OBJECT('type','GeometryCollection','geometries',v_geometries),1,0);
   IF p_areas IS NULL OR NOT ST_IsValid(p_areas) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Invalid campus restriction geometry.';
   END IF;
  END IF;
 END IF;
END$$
DELIMITER ;

-- Upgrade only the known original demo graph. The caller owns the transaction
-- and serializes ledger changes; a customized graph is never overwritten.
DROP PROCEDURE IF EXISTS sp_upgrade_campus_map;
DELIMITER $$
CREATE PROCEDURE sp_upgrade_campus_map(IN campus JSON, IN campus_v1 JSON, IN campus_v2 JSON)
SQL SECURITY INVOKER
upgrade_map: BEGIN
 DECLARE current_version VARCHAR(100);
 DECLARE prior_campus JSON;
 SET current_version=(SELECT JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) FROM system_settings WHERE name='campus_map');
 IF EXISTS(SELECT 1 FROM system_settings WHERE name='campus_map') THEN
  IF BINARY current_version <=> BINARY JSON_UNQUOTE(JSON_EXTRACT(campus,'$.version')) THEN
   SELECT 0 AS migrated;
   LEAVE upgrade_map;
  END IF;
  IF NOT (BINARY current_version <=> BINARY 'beihang-xueyuan-1' OR BINARY current_version <=> BINARY 'beihang-xueyuan-2') THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Unknown campus map version; explicit migration required.';
  END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM ride_orders WHERE status='RUNNING') OR EXISTS(SELECT 1 FROM dispatch_tasks WHERE status IN ('PENDING','IN_PROGRESS')) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Campus map update requires no active rides or dispatches.';
 END IF;
 IF EXISTS(SELECT 1 FROM audit_logs WHERE entity_type='road_edges') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refusing to overwrite a customized map; explicit mapping required.';
 END IF;
 IF current_version IS NULL AND ((SELECT COUNT(*) FROM parking_zones)<>6 OR (SELECT COUNT(*) FROM road_nodes)<>8 OR (SELECT COUNT(*) FROM road_edges)<>13
 OR (SELECT COUNT(*) FROM parking_zones z JOIN JSON_TABLE(
  '[[1,"东门驿站","校园东门 · 主入口",160,440],[2,"图书馆","图书馆南侧 · 知行广场",450,180],[3,"教学楼","第一教学楼 · 东侧",760,210],[4,"学生公寓","学生生活区 · 榕树路",210,750],[5,"中心食堂","中心食堂 · 北广场",530,550],[6,"运动场","体育中心 · 西门",850,700]]', '$[*]'
  COLUMNS(id INT PATH '$[0]',name VARCHAR(60) PATH '$[1]',location VARCHAR(160) PATH '$[2]',x INT PATH '$[3]',y INT PATH '$[4]')) e
  ON z.id=e.id AND BINARY z.name=BINARY e.name AND BINARY z.location=BINARY e.location AND z.x=e.x AND z.y=e.y AND z.radius=45)<>6
 OR (SELECT COUNT(*) FROM road_nodes n JOIN JSON_TABLE(
  '[[1,"东门驿站",160,440,1],[2,"图书馆",450,180,2],[3,"教学楼",760,210,3],[4,"学生公寓",210,750,4],[5,"中心食堂",530,550,5],[6,"运动场",850,700,6],[7,"银杏路口",420,400,null],[8,"湖畔绿道",730,460,null]]', '$[*]'
  COLUMNS(id INT PATH '$[0]',name VARCHAR(60) PATH '$[1]',x INT PATH '$[2]',y INT PATH '$[3]',zone_id INT PATH '$[4]')) e
  ON n.id=e.id AND BINARY n.name=BINARY e.name AND n.x=e.x AND n.y=e.y AND n.zone_id <=> e.zone_id)<>8
 OR (SELECT COUNT(*) FROM road_edges r JOIN JSON_TABLE(
  '[[1,1,2,390,4,3],[2,1,4,320,1,2],[3,1,7,265,1,1],[4,2,3,320,3,2],[5,2,7,225,1,1],[6,3,8,255,1,1],[7,4,5,385,2,1],[8,4,7,410,1,2],[9,5,6,365,3,2],[10,5,7,190,1,1],[11,5,8,235,1,1],[12,6,8,275,1,1],[13,7,8,320,1,1]]', '$[*]'
  COLUMNS(id INT PATH '$[0]',from_id INT PATH '$[1]',to_id INT PATH '$[2]',distance_m INT PATH '$[3]',safety INT PATH '$[4]',comfort INT PATH '$[5]')) e
  ON r.id=e.id AND r.from_node_id=e.from_id AND r.to_node_id=e.to_id AND r.distance_m=e.distance_m
   AND r.safety_cost=e.safety AND r.comfort_cost=e.comfort AND r.direction='BOTH' AND r.status='OPEN'
   AND r.attribute_source='SIMULATED_COURSE_DATA' AND (
    (r.slope_percent=0 AND r.surface='SMOOTH' AND r.shade_level=3 AND r.lighting_level=3 AND r.traffic_mix='MIXED' AND r.intersection_risk=1)
    OR (r.slope_percent=(CAST(MOD(r.id,5) AS SIGNED)-2)*1.5
     AND r.surface=CASE WHEN MOD(r.id,5)=0 THEN 'ROUGH' WHEN MOD(r.id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END
     AND r.shade_level=LEAST(5,2+MOD(r.id,4)) AND r.lighting_level=5-MOD(r.id,3)
     AND r.traffic_mix=CASE WHEN MOD(r.id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(r.id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END
     AND r.intersection_risk=MOD(r.id,4))))<>13)
 THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refusing to overwrite a customized map; explicit mapping required.';
 END IF;
 IF current_version IS NOT NULL THEN
  SET prior_campus=IF(BINARY current_version=BINARY 'beihang-xueyuan-1',campus_v1,campus_v2);
  IF (SELECT COUNT(*) FROM parking_zones)<>JSON_LENGTH(prior_campus,'$.zones')
  OR (SELECT COUNT(*) FROM road_nodes)<>JSON_LENGTH(prior_campus,'$.nodes')
  OR (SELECT COUNT(*) FROM road_edges)<>JSON_LENGTH(prior_campus,'$.edges')
  OR (SELECT COUNT(*) FROM parking_zones z JOIN JSON_TABLE(prior_campus,'$.zones[*]' COLUMNS(
   id INT PATH '$.id',name VARCHAR(60) PATH '$.name',location VARCHAR(160) PATH '$.location',
   x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y')) e
   ON z.id=e.id AND BINARY z.name=BINARY e.name AND BINARY z.location=BINARY e.location
   AND z.x=e.x AND z.y=e.y AND z.radius=35)<>JSON_LENGTH(prior_campus,'$.zones')
  OR (SELECT COUNT(*) FROM road_nodes n JOIN JSON_TABLE(prior_campus,'$.nodes[*]' COLUMNS(
   id INT PATH '$.id',name VARCHAR(60) PATH '$.name',x DECIMAL(10,2) PATH '$.x',
   y DECIMAL(10,2) PATH '$.y',zone_id INT PATH '$.zone_id' NULL ON EMPTY)) e
   ON n.id=e.id AND BINARY n.name=BINARY e.name AND n.x=e.x AND n.y=e.y AND n.zone_id <=> e.zone_id)<>JSON_LENGTH(prior_campus,'$.nodes')
  OR (SELECT COUNT(*) FROM road_edges r JOIN JSON_TABLE(prior_campus,'$.edges[*]' COLUMNS(
   id INT PATH '$.id',from_id INT PATH '$.from_node_id',to_id INT PATH '$.to_node_id',
   distance_m INT PATH '$.distance_m',safety DECIMAL(6,2) PATH '$.safety_cost',comfort DECIMAL(6,2) PATH '$.comfort_cost',
   direction VARCHAR(10) PATH '$.direction' NULL ON EMPTY,status VARCHAR(10) PATH '$.status' NULL ON EMPTY)) e
   ON r.from_node_id=e.from_id AND r.to_node_id=e.to_id AND r.distance_m=e.distance_m
    AND r.safety_cost=e.safety AND r.comfort_cost=e.comfort
    AND BINARY r.direction=BINARY COALESCE(e.direction,'BOTH') AND BINARY r.status=BINARY COALESCE(e.status,'OPEN')
    AND r.attribute_source='SIMULATED_COURSE_DATA'
    AND r.slope_percent=(CAST(MOD(e.id,5) AS SIGNED)-2)*1.5
    AND r.surface=CASE WHEN MOD(e.id,5)=0 THEN 'ROUGH' WHEN MOD(e.id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END
    AND r.shade_level=LEAST(5,2+MOD(e.id,4)) AND r.lighting_level=5-MOD(e.id,3)
    AND r.traffic_mix=CASE WHEN MOD(e.id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(e.id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END
    AND r.intersection_risk=MOD(e.id,4))<>JSON_LENGTH(prior_campus,'$.edges') THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refusing to overwrite a customized map; explicit mapping required.';
  END IF;
 END IF;
 UPDATE parking_zones z JOIN JSON_TABLE(campus,'$.zones[*]' COLUMNS(
  id INT PATH '$.id',name VARCHAR(60) PATH '$.name',location VARCHAR(160) PATH '$.location',x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y')) s ON z.id=s.id
 SET z.name=s.name,z.location=s.location,z.x=s.x,z.y=s.y,z.radius=35;
 DELETE FROM road_edges;
 DELETE FROM road_nodes;
 INSERT INTO road_nodes(id,name,x,y,zone_id)
 SELECT id,name,x,y,zone_id FROM JSON_TABLE(campus,'$.nodes[*]' COLUMNS(
  id INT PATH '$.id',name VARCHAR(60) PATH '$.name',x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y',zone_id INT PATH '$.zone_id' NULL ON EMPTY)) n;
 INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source)
 SELECT from_id,to_id,distance_m,safety_cost,comfort_cost,COALESCE(direction,'BOTH'),COALESCE(status,'OPEN'),
  (CAST(MOD(id,5) AS SIGNED)-2)*1.5,CASE WHEN MOD(id,5)=0 THEN 'ROUGH' WHEN MOD(id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END,
  LEAST(5,2+MOD(id,4)),5-MOD(id,3),CASE WHEN MOD(id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END,
  MOD(id,4),'SIMULATED_COURSE_DATA'
 FROM JSON_TABLE(campus,'$.edges[*]' COLUMNS(id INT PATH '$.id',from_id INT PATH '$.from_node_id',to_id INT PATH '$.to_node_id',
  distance_m INT PATH '$.distance_m',safety_cost DECIMAL(6,2) PATH '$.safety_cost',comfort_cost DECIMAL(6,2) PATH '$.comfort_cost',
  direction VARCHAR(10) PATH '$.direction' NULL ON EMPTY,status VARCHAR(10) PATH '$.status' NULL ON EMPTY)) e;
 INSERT INTO system_settings(name,value) VALUES('campus_map',JSON_OBJECT('version',JSON_UNQUOTE(JSON_EXTRACT(campus,'$.version')),'source',JSON_UNQUOTE(JSON_EXTRACT(campus,'$.source'))))
 ON DUPLICATE KEY UPDATE value=VALUES(value);
 SELECT 1 AS migrated;
END$$
DELIMITER ;

-- Single-zone inventory avoids materializing the all-zone inventory view.
DROP PROCEDURE IF EXISTS sp_zone_load;
DELIMITER $$
CREATE PROCEDURE sp_zone_load(IN p_zone BIGINT UNSIGNED, OUT p_occupied INT, OUT p_reserved INT)
SQL SECURITY INVOKER
BEGIN
 SELECT (SELECT COUNT(*) FROM bikes WHERE current_zone_id=p_zone),
        (SELECT COUNT(*) FROM dispatch_tasks t JOIN dispatch_bikes d ON d.task_id=t.id
         WHERE t.target_zone_id=p_zone AND t.status IN ('PENDING','IN_PROGRESS'))
 INTO p_occupied,p_reserved;
END$$
DELIMITER ;
