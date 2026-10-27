-- MySQL stored procedures; transactions are owned by the caller.

DROP PROCEDURE IF EXISTS sp_capture_zone_snapshots;
DELIMITER $$
CREATE PROCEDURE sp_capture_zone_snapshots()
SQL SECURITY INVOKER
BEGIN
 INSERT INTO zone_snapshots(zone_id,available,occupied,capacity) SELECT id,available,occupied,capacity FROM v_zone_inventory;
END$$
DELIMITER ;

-- Upgrade only the known original demo graph. The caller owns the transaction
-- and serializes ledger changes; a customized graph is never overwritten.
DROP PROCEDURE IF EXISTS sp_upgrade_campus_map;
DELIMITER $$
CREATE PROCEDURE sp_upgrade_campus_map(IN campus JSON)
SQL SECURITY INVOKER
upgrade_map: BEGIN
 DECLARE current_version VARCHAR(100);
 SET current_version=(SELECT JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) FROM system_settings WHERE name='campus_map');
 IF EXISTS(SELECT 1 FROM system_settings WHERE name='campus_map') THEN
  IF NOT (BINARY current_version <=> BINARY JSON_UNQUOTE(JSON_EXTRACT(campus,'$.version'))) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Unknown campus map version; explicit migration required.';
  END IF;
  SELECT 0 AS migrated;
  LEAVE upgrade_map;
 END IF;
 IF EXISTS(SELECT 1 FROM ride_orders WHERE status='RUNNING') OR EXISTS(SELECT 1 FROM dispatch_tasks WHERE status IN ('PENDING','IN_PROGRESS')) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Campus map update requires no active rides or dispatches.';
 END IF;
 IF (SELECT COUNT(*) FROM parking_zones)<>6 OR (SELECT COUNT(*) FROM road_nodes)<>8 OR (SELECT COUNT(*) FROM road_edges)<>13
 OR (SELECT COUNT(*) FROM parking_zones z JOIN JSON_TABLE(
  '[[1,"东门驿站",160,440],[2,"图书馆",450,180],[3,"教学楼",760,210],[4,"学生公寓",210,750],[5,"中心食堂",530,550],[6,"运动场",850,700]]', '$[*]'
  COLUMNS(id INT PATH '$[0]',name VARCHAR(60) PATH '$[1]',x INT PATH '$[2]',y INT PATH '$[3]')) e
  ON z.id=e.id AND BINARY z.name=BINARY e.name AND z.x=e.x AND z.y=e.y)<>6
 OR (SELECT COUNT(*) FROM road_nodes n JOIN JSON_TABLE(
  '[[1,"东门驿站",160,440,1],[2,"图书馆",450,180,2],[3,"教学楼",760,210,3],[4,"学生公寓",210,750,4],[5,"中心食堂",530,550,5],[6,"运动场",850,700,6],[7,"银杏路口",420,400,null],[8,"湖畔绿道",730,460,null]]', '$[*]'
  COLUMNS(id INT PATH '$[0]',name VARCHAR(60) PATH '$[1]',x INT PATH '$[2]',y INT PATH '$[3]',zone_id INT PATH '$[4]')) e
  ON n.id=e.id AND BINARY n.name=BINARY e.name AND n.x=e.x AND n.y=e.y AND n.zone_id <=> e.zone_id)<>8
 OR (SELECT COUNT(*) FROM road_edges r JOIN JSON_TABLE(
  '[[1,2],[1,4],[1,7],[2,3],[2,7],[3,8],[4,5],[4,7],[5,6],[5,7],[5,8],[6,8],[7,8]]', '$[*]'
  COLUMNS(from_id INT PATH '$[0]',to_id INT PATH '$[1]')) e ON r.from_node_id=e.from_id AND r.to_node_id=e.to_id)<>13 THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Refusing to overwrite a customized map; explicit mapping required.';
 END IF;
 UPDATE parking_zones z JOIN JSON_TABLE(campus,'$.zones[*]' COLUMNS(
  id INT PATH '$.id',name VARCHAR(60) PATH '$.name',location VARCHAR(160) PATH '$.location',x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y')) s ON z.id=s.id
 SET z.name=s.name,z.location=s.location,z.x=s.x,z.y=s.y,z.radius=35;
 DELETE FROM road_edges;
 INSERT INTO road_nodes(id,name,x,y,zone_id)
 SELECT id,name,x,y,zone_id FROM JSON_TABLE(campus,'$.nodes[*]' COLUMNS(
  id INT PATH '$.id',name VARCHAR(60) PATH '$.name',x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y',zone_id INT PATH '$.zone_id' NULL ON EMPTY)) n
 ON DUPLICATE KEY UPDATE name=VALUES(name),x=VALUES(x),y=VALUES(y),zone_id=VALUES(zone_id);
 INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source)
 SELECT from_id,to_id,distance_m,safety_cost,comfort_cost,'BOTH','OPEN',
  (CAST(MOD(id,5) AS SIGNED)-2)*1.5,CASE WHEN MOD(id,5)=0 THEN 'ROUGH' WHEN MOD(id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END,
  LEAST(5,2+MOD(id,4)),5-MOD(id,3),CASE WHEN MOD(id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END,
  MOD(id,4),'SIMULATED_COURSE_DATA'
 FROM JSON_TABLE(campus,'$.edges[*]' COLUMNS(id INT PATH '$.id',from_id INT PATH '$.from_node_id',to_id INT PATH '$.to_node_id',
  distance_m INT PATH '$.distance_m',safety_cost DECIMAL(6,2) PATH '$.safety_cost',comfort_cost DECIMAL(6,2) PATH '$.comfort_cost')) e;
 INSERT INTO system_settings(name,value) VALUES('campus_map',JSON_OBJECT('version',JSON_UNQUOTE(JSON_EXTRACT(campus,'$.version')),'source',JSON_UNQUOTE(JSON_EXTRACT(campus,'$.source'))));
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
