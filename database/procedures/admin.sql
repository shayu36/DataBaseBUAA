-- MySQL stored procedures; transactions are owned by the caller.

DROP PROCEDURE IF EXISTS sp_update_leaderboard_profile;
DELIMITER $$
CREATE PROCEDURE sp_update_leaderboard_profile(IN p_actor BIGINT UNSIGNED, IN p_alias VARCHAR(40), IN p_visible BOOLEAN)
SQL SECURITY INVOKER
BEGIN
 UPDATE users SET leaderboard_alias=p_alias,leaderboard_visible=p_visible WHERE id=p_actor;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,'LEADERBOARD_PROFILE_UPDATE','users',p_actor,JSON_OBJECT('alias',p_alias,'visible',IF(p_visible,CAST('true' AS JSON),CAST('false' AS JSON))));
 SELECT p_alias AS leaderboard_alias,p_visible AS leaderboard_visible;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_save_zone;
DELIMITER $$
CREATE PROCEDURE sp_save_zone(IN p_actor BIGINT UNSIGNED, IN p_data JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_id,v_node,v_nearest BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_name VARCHAR(60);
 DECLARE v_location VARCHAR(160);
 DECLARE v_x,v_y,v_old_x,v_old_y DECIMAL(10,2);
 DECLARE v_radius,v_old_radius DECIMAL(8,2);
 DECLARE v_capacity,v_occupied,v_reserved INT;
 DECLARE v_status,v_old_status VARCHAR(20);
 DECLARE v_changed,v_geometry BOOLEAN DEFAULT FALSE;
 DECLARE v_distance INT;
 SELECT id,name,location,x,y,radius,capacity,status INTO v_id,v_name,v_location,v_x,v_y,v_radius,v_capacity,v_status
 FROM JSON_TABLE(p_data,'$' COLUMNS(id BIGINT UNSIGNED PATH '$.id' NULL ON EMPTY,name VARCHAR(60) PATH '$.name',location VARCHAR(160) PATH '$.location',
 x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y',radius DECIMAL(8,2) PATH '$.radius',capacity INT PATH '$.capacity',status VARCHAR(20) PATH '$.status')) input_data;
 IF v_id IS NOT NULL THEN
  SELECT status,x,y,radius INTO v_old_status,v_old_x,v_old_y,v_old_radius FROM parking_zones WHERE id=v_id FOR UPDATE;
  IF v_old_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_NOT_FOUND'; END IF;
  CALL sp_zone_load(v_id,v_occupied,v_reserved);
  IF v_capacity<v_occupied+v_reserved THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_CAPACITY_TOO_SMALL'; END IF;
  SET v_changed=(v_old_x<>v_x OR v_old_y<>v_y),v_geometry=(v_changed OR v_old_radius<>v_radius);
  IF (v_geometry OR v_status='CLOSED') AND (v_occupied<>0 OR v_reserved<>0 OR EXISTS(
    SELECT 1 FROM dispatch_tasks WHERE (source_zone_id=v_id OR target_zone_id=v_id) AND status IN ('PENDING','IN_PROGRESS'))) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_IN_USE';
  END IF;
  IF v_geometry AND EXISTS(SELECT 1 FROM ride_orders WHERE start_zone_id=v_id AND status='RUNNING') THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_ACTIVE_RIDE';
  END IF;
  UPDATE parking_zones SET name=v_name,location=v_location,x=v_x,y=v_y,radius=v_radius,capacity=v_capacity,status=v_status WHERE id=v_id;
  UPDATE road_nodes SET name=v_name,x=v_x,y=v_y WHERE zone_id=v_id;
  IF v_changed THEN
   UPDATE road_edges e JOIN road_nodes a ON a.id=e.from_node_id JOIN road_nodes b ON b.id=e.to_node_id
   SET e.distance_m=GREATEST(1,ROUND(SQRT(POW(a.x-b.x,2)+POW(a.y-b.y,2)))) WHERE a.zone_id=v_id OR b.zone_id=v_id;
  END IF;
 ELSE
  SELECT id,GREATEST(1,ROUND(SQRT(POW(x-v_x,2)+POW(y-v_y,2)))) INTO v_nearest,v_distance
  FROM road_nodes ORDER BY POW(x-v_x,2)+POW(y-v_y,2),id LIMIT 1 FOR UPDATE;
  INSERT INTO parking_zones(name,location,x,y,radius,capacity,status) VALUES(v_name,v_location,v_x,v_y,v_radius,v_capacity,v_status);
  SET v_id=LAST_INSERT_ID();
  INSERT INTO road_nodes(name,x,y,zone_id) VALUES(v_name,v_x,v_y,v_id);
  SET v_node=LAST_INSERT_ID();
  IF v_nearest IS NOT NULL THEN
   INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost) VALUES(LEAST(v_nearest,v_node),GREATEST(v_nearest,v_node),v_distance,1,1);
  END IF;
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,IF(JSON_CONTAINS_PATH(p_data,'one','$.id'),'ZONE_UPDATE','ZONE_CREATE'),'parking_zones',v_id,p_data);
 SELECT v_id AS id;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_save_bike;
DELIMITER $$
CREATE PROCEDURE sp_save_bike(IN p_actor BIGINT UNSIGNED, IN p_data JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_id,v_zone,v_current,v_old_zone BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_code VARCHAR(30);
 DECLARE v_status,v_old_status,v_target_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_deployed,v_old_deployed DATE;
 DECLARE v_capacity,v_occupied,v_reserved,v_already INT;
 SELECT id,code,zone_id,deployed_at,status INTO v_id,v_code,v_zone,v_deployed,v_status
 FROM JSON_TABLE(p_data,'$' COLUMNS(id BIGINT UNSIGNED PATH '$.id' NULL ON EMPTY,code VARCHAR(30) PATH '$.code',zone_id BIGINT UNSIGNED PATH '$.zone_id',
 deployed_at DATE PATH '$.deployed_at' NULL ON EMPTY,status VARCHAR(20) PATH '$.status' NULL ON EMPTY)) input_data;
 IF v_id IS NOT NULL THEN
  SELECT status,current_zone_id,deployed_at INTO v_old_status,v_old_zone,v_old_deployed FROM bikes WHERE id=v_id FOR UPDATE;
  IF v_old_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_NOT_FOUND'; END IF;
  IF v_old_status NOT IN ('AVAILABLE','RETIRED') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_ACTIVE'; END IF;
 END IF;
 SET v_status=COALESCE(v_status,v_old_status,'AVAILABLE'),v_deployed=COALESCE(v_deployed,v_old_deployed,DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR));
 SELECT status,capacity INTO v_target_status,v_capacity FROM parking_zones WHERE id=v_zone FOR UPDATE;
 IF v_target_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_NOT_FOUND'; END IF;
 IF v_status='AVAILABLE' THEN
  IF v_target_status<>'ACTIVE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_TARGET_CLOSED'; END IF;
  CALL sp_zone_load(v_zone,v_occupied,v_reserved);
  SET v_already=IF(v_old_zone=v_zone,1,0);
  IF v_occupied+v_reserved-v_already>=v_capacity THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_TARGET_FULL'; END IF;
  SET v_current=v_zone;
 END IF;
 IF v_id IS NULL THEN
  INSERT INTO bikes(code,deployed_at,status,current_zone_id) VALUES(v_code,v_deployed,v_status,v_current);
  SET v_id=LAST_INSERT_ID();
 ELSE
  UPDATE bikes SET code=v_code,deployed_at=v_deployed,status=v_status,current_zone_id=v_current WHERE id=v_id;
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,IF(JSON_CONTAINS_PATH(p_data,'one','$.id'),'BIKE_UPDATE','BIKE_CREATE'),'bikes',v_id,
 JSON_OBJECT('code',v_code,'status',v_status,'zone_id',v_current,'deployed_at',DATE_FORMAT(v_deployed,'%Y-%m-%d')));
 SELECT v_id AS id;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_save_staff;
DELIMITER $$
CREATE PROCEDURE sp_save_staff(IN p_actor BIGINT UNSIGNED, IN p_data JSON, IN p_hash VARCHAR(100))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_id,v_uid BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_name VARCHAR(40);
 DECLARE v_phone VARCHAR(20);
 DECLARE v_email VARCHAR(160);
 DECLARE v_job,v_status,v_role VARCHAR(20);
 DECLARE v_dispatch,v_maintenance BOOLEAN;
 SELECT id,name,phone,email,job,status INTO v_id,v_name,v_phone,v_email,v_job,v_status
 FROM JSON_TABLE(p_data,'$' COLUMNS(id BIGINT UNSIGNED PATH '$.id' NULL ON EMPTY,name VARCHAR(40) PATH '$.name',phone VARCHAR(20) PATH '$.phone',
 email VARCHAR(160) PATH '$.email',job VARCHAR(20) PATH '$.job',status VARCHAR(20) PATH '$.status')) input_data;
 IF v_id IS NOT NULL THEN
  SELECT user_id INTO v_uid FROM staff WHERE id=v_id FOR UPDATE;
  IF v_uid IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_NOT_FOUND'; END IF;
  SELECT role INTO v_role FROM users WHERE id=v_uid FOR UPDATE;
  IF v_role<>'OPERATOR' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_ROLE_INVALID'; END IF;
  SET v_dispatch=EXISTS(SELECT 1 FROM dispatch_tasks WHERE staff_id=v_id AND status IN ('PENDING','IN_PROGRESS')),
      v_maintenance=EXISTS(SELECT 1 FROM maintenance_tickets WHERE staff_id=v_id AND status<>'COMPLETED');
  IF v_status='OFF_DUTY' AND (v_dispatch OR v_maintenance) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_BUSY'; END IF;
  IF v_dispatch AND v_job NOT IN ('BOTH','DISPATCH') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_DISPATCH_WORK'; END IF;
  IF v_maintenance AND v_job NOT IN ('BOTH','MAINTENANCE') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_MAINTENANCE_WORK'; END IF;
  UPDATE users SET name=v_name,phone=v_phone,email=v_email,role='OPERATOR',password_hash=COALESCE(p_hash,password_hash) WHERE id=v_uid;
  UPDATE staff SET name=v_name,phone=v_phone,job=v_job,status=v_status WHERE id=v_id;
 ELSE
  IF EXISTS(SELECT 1 FROM users WHERE email=v_email OR phone=v_phone) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_USER_COLLISION'; END IF;
  INSERT INTO users(name,email,phone,password_hash,role) VALUES(v_name,v_email,v_phone,p_hash,'OPERATOR');
  SET v_uid=LAST_INSERT_ID();
  INSERT INTO staff(user_id,name,phone,job,status) VALUES(v_uid,v_name,v_phone,v_job,v_status);
  SET v_id=LAST_INSERT_ID();
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,IF(JSON_CONTAINS_PATH(p_data,'one','$.id'),'STAFF_UPDATE','STAFF_CREATE'),'staff',v_id,
 JSON_OBJECT('user_id',v_uid,'name',v_name,'email',v_email,'phone',v_phone,'job',v_job,'status',v_status,
 'password_changed',IF(p_hash IS NOT NULL,CAST('true' AS JSON),CAST('false' AS JSON))));
 SELECT v_id AS id;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_set_user_status;
DELIMITER $$
CREATE PROCEDURE sp_set_user_status(IN p_actor BIGINT UNSIGNED, IN p_user BIGINT UNSIGNED, IN p_status VARCHAR(20))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_id,v_staff BIGINT UNSIGNED DEFAULT NULL;
 SELECT id INTO v_id FROM users WHERE id=p_user FOR UPDATE;
 IF v_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_NOT_FOUND'; END IF;
 IF p_status='SUSPENDED' THEN
  IF p_user=p_actor THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_SELF_SUSPEND'; END IF;
  IF EXISTS(SELECT 1 FROM ride_orders WHERE user_id=p_user AND status IN ('RUNNING','UNPAID')) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_ACTIVE_ORDERS'; END IF;
  SELECT id INTO v_staff FROM staff WHERE user_id=p_user;
  IF v_staff IS NOT NULL AND (EXISTS(SELECT 1 FROM dispatch_tasks WHERE staff_id=v_staff AND status IN ('PENDING','IN_PROGRESS'))
   OR EXISTS(SELECT 1 FROM maintenance_tickets WHERE staff_id=v_staff AND status<>'COMPLETED')) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='USER_ACTIVE_WORK';
  END IF;
 END IF;
 UPDATE users SET status=p_status WHERE id=p_user;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(p_actor,'USER_STATUS','users',p_user,JSON_OBJECT('status',p_status));
 SELECT TRUE AS ok;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_register_user;
DELIMITER $$
CREATE PROCEDURE sp_register_user(IN p_name VARCHAR(40), IN p_email VARCHAR(160), IN p_phone VARCHAR(20), IN p_hash VARCHAR(100))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_id BIGINT UNSIGNED;
 INSERT INTO users(name,email,phone,password_hash) VALUES(p_name,p_email,p_phone,p_hash);
 SET v_id=LAST_INSERT_ID();
 UPDATE users SET leaderboard_alias=CONCAT('骑行者',LPAD(v_id,4,'0')) WHERE id=v_id;
 SELECT id,name,email,phone,role,status,leaderboard_alias,leaderboard_visible FROM users WHERE id=v_id;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_save_road;
DELIMITER $$
CREATE PROCEDURE sp_save_road(IN p_actor BIGINT UNSIGNED, IN p_data JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_id BIGINT UNSIGNED;
 DECLARE v_before JSON DEFAULT NULL;
 SELECT id INTO v_id FROM JSON_TABLE(p_data,'$' COLUMNS(id BIGINT UNSIGNED PATH '$.id')) input_data;
 SELECT JSON_OBJECT('id',id,'from_node_id',from_node_id,'to_node_id',to_node_id,'distance_m',distance_m,
 'safety_cost',safety_cost,'comfort_cost',comfort_cost,'direction',direction,'status',status,'slope_percent',slope_percent,
 'surface',surface,'shade_level',shade_level,'lighting_level',lighting_level,'traffic_mix',traffic_mix,'intersection_risk',intersection_risk,
 'attribute_source',attribute_source) INTO v_before FROM road_edges WHERE id=v_id FOR UPDATE;
 IF v_before IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ROAD_NOT_FOUND'; END IF;
 UPDATE road_edges e JOIN JSON_TABLE(p_data,'$' COLUMNS(direction VARCHAR(10) PATH '$.direction',status VARCHAR(10) PATH '$.status',
 slope DECIMAL(5,2) PATH '$.slope_percent',surface VARCHAR(10) PATH '$.surface',shade INT PATH '$.shade_level',lighting INT PATH '$.lighting_level',
 traffic VARCHAR(20) PATH '$.traffic_mix',risk INT PATH '$.intersection_risk')) d
 SET e.direction=d.direction,e.status=d.status,e.slope_percent=d.slope,e.surface=d.surface,e.shade_level=d.shade,e.lighting_level=d.lighting,
 e.traffic_mix=d.traffic,e.intersection_risk=d.risk WHERE e.id=v_id;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,'ROAD_UPDATE','road_edges',v_id,JSON_OBJECT('before',v_before,'after',p_data));
 SELECT v_id AS id;
END$$
DELIMITER ;
