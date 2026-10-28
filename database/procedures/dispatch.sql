-- MySQL stored procedures; transactions are owned by the caller.

DROP PROCEDURE IF EXISTS sp_assert_dispatch_staff;
DELIMITER $$
CREATE PROCEDURE sp_assert_dispatch_staff(IN p_staff BIGINT UNSIGNED, OUT p_user BIGINT UNSIGNED)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_staff_status,v_user_status,v_job VARCHAR(20);
 SET p_user=NULL;
 SELECT s.user_id,s.status,u.status,s.job INTO p_user,v_staff_status,v_user_status,v_job
 FROM staff s JOIN users u ON u.id=s.user_id WHERE s.id=p_staff FOR UPDATE;
 IF p_user IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_NOT_FOUND'; END IF;
 IF v_staff_status<>'ACTIVE' OR v_user_status<>'ACTIVE' OR v_job NOT IN ('DISPATCH','BOTH') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_UNAVAILABLE';
 END IF;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_create_dispatch;
DELIMITER $$
CREATE PROCEDURE sp_create_dispatch(IN p_actor BIGINT UNSIGNED, IN p_source BIGINT UNSIGNED, IN p_target BIGINT UNSIGNED,
 IN p_bikes JSON, IN p_staff BIGINT UNSIGNED, IN p_detail JSON, IN p_campus JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_source_status,v_target_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_occupied,v_reserved,v_capacity,v_found,v_available,v_distinct INT;
 DECLARE v_staff_user,v_task BIGINT UNSIGNED;
 DECLARE v_inventory JSON;
 DECLARE v_x,v_y DECIMAL(10,2);
 DECLARE v_areas GEOMETRY DEFAULT NULL;
 IF p_source=p_target OR p_bikes IS NULL OR JSON_TYPE(p_bikes)<>'ARRAY' OR JSON_LENGTH(p_bikes) NOT BETWEEN 1 AND 100 THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_DISPATCH_INPUT';
 END IF;
 IF EXISTS(SELECT 1 FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(bike_id JSON PATH '$')) requested
  WHERE CASE WHEN JSON_TYPE(bike_id) IN ('INTEGER','UNSIGNED INTEGER')
    THEN CAST(JSON_UNQUOTE(bike_id) AS DECIMAL(20,0))<1 ELSE TRUE END) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_DISPATCH_INPUT';
 END IF;
 SELECT status INTO v_source_status FROM parking_zones WHERE id=p_source FOR UPDATE;
 SELECT status,capacity,x,y INTO v_target_status,v_capacity,v_x,v_y FROM parking_zones WHERE id=p_target FOR UPDATE;
 IF v_source_status IS NULL OR v_target_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_NOT_FOUND'; END IF;
 IF v_source_status<>'ACTIVE' OR v_target_status<>'ACTIVE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_ZONE_CLOSED'; END IF;
 CALL sp_campus_restrictions(p_campus,v_areas);
 IF v_areas IS NOT NULL AND ST_Intersects(POINT(v_x,v_y),v_areas) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_RESTRICTED';
 END IF;
 CALL sp_zone_load(p_target,v_occupied,v_reserved);
 IF v_occupied+v_reserved+JSON_LENGTH(p_bikes)>v_capacity THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_ZONE_FULL'; END IF;
 IF p_staff IS NOT NULL THEN CALL sp_assert_dispatch_staff(p_staff,v_staff_user); END IF;
 SELECT COUNT(b.id),COUNT(DISTINCT b.id),COALESCE(SUM(b.status='AVAILABLE' AND b.current_zone_id=p_source),0)
 INTO v_found,v_distinct,v_available
 FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$')) requested LEFT JOIN bikes b ON b.id=requested.id;
 IF v_found<>JSON_LENGTH(p_bikes) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_NOT_FOUND'; END IF;
 IF v_distinct<>v_found THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_DISPATCH_INPUT'; END IF;
 IF v_available<>v_found THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_UNAVAILABLE'; END IF;
 INSERT INTO dispatch_tasks(staff_id,source_zone_id,target_zone_id) VALUES(p_staff,p_source,p_target);
 SET v_task=LAST_INSERT_ID();
 INSERT INTO dispatch_bikes(task_id,bike_id) SELECT v_task,id FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$')) requested;
 UPDATE bikes b JOIN JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$')) requested ON b.id=requested.id SET b.status='DISPATCHING';
 CALL sp_dispatch_inventory(p_source,p_target,v_inventory);
 UPDATE dispatch_tasks SET inventory_created=v_inventory WHERE id=v_task;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(p_actor,'DISPATCH_CREATE','dispatch_tasks',v_task,p_detail);
 SELECT v_task AS id;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_dispatch_action;
DELIMITER $$
CREATE PROCEDURE sp_dispatch_action(IN p_actor BIGINT UNSIGNED, IN p_task BIGINT UNSIGNED, IN p_action VARCHAR(20), IN p_staff BIGINT UNSIGNED)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_role,v_target_status VARCHAR(20);
 DECLARE v_assigned,v_source,v_target,v_staff_user BIGINT UNSIGNED;
 DECLARE v_inventory JSON;
 DECLARE v_occupied,v_reserved,v_capacity INT;
 SELECT status,staff_id,source_zone_id,target_zone_id INTO v_status,v_assigned,v_source,v_target FROM dispatch_tasks WHERE id=p_task FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TASK_NOT_FOUND'; END IF;
 SELECT role INTO v_role FROM users WHERE id=p_actor;
 IF p_action IN ('assign','cancel') AND v_role<>'ADMIN' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_FORBIDDEN'; END IF;
 IF p_action='assign' THEN
  IF v_status<>'PENDING' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_NOT_PENDING_ASSIGN'; END IF;
  CALL sp_assert_dispatch_staff(p_staff,v_staff_user);
  UPDATE dispatch_tasks SET staff_id=p_staff WHERE id=p_task;
 ELSE
  IF v_role<>'ADMIN' THEN
   IF v_role<>'OPERATOR' OR v_assigned IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_FORBIDDEN'; END IF;
   CALL sp_assert_dispatch_staff(v_assigned,v_staff_user);
   IF v_staff_user<>p_actor THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TASK_NOT_ASSIGNED'; END IF;
  END IF;
  IF p_action='start' THEN
   IF v_status<>'PENDING' OR v_assigned IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_NOT_READY'; END IF;
   IF v_role='ADMIN' THEN CALL sp_assert_dispatch_staff(v_assigned,v_staff_user); END IF;
   UPDATE dispatch_tasks SET status='IN_PROGRESS',started_at=UTC_TIMESTAMP(3) WHERE id=p_task;
   UPDATE bikes b JOIN dispatch_bikes d ON d.bike_id=b.id SET b.current_zone_id=NULL WHERE d.task_id=p_task;
   CALL sp_dispatch_inventory(v_source,v_target,v_inventory);
   UPDATE dispatch_tasks SET inventory_started=v_inventory WHERE id=p_task;
  ELSEIF p_action='complete' THEN
   IF v_status<>'IN_PROGRESS' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_NOT_STARTED'; END IF;
   SELECT status,capacity INTO v_target_status,v_capacity FROM parking_zones WHERE id=v_target FOR UPDATE;
   IF v_target_status<>'ACTIVE' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_TARGET_CLOSED'; END IF;
   CALL sp_zone_load(v_target,v_occupied,v_reserved);
   IF v_occupied+v_reserved>v_capacity THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_ZONE_FULL'; END IF;
   UPDATE bikes b JOIN dispatch_bikes d ON d.bike_id=b.id SET b.status='AVAILABLE',b.current_zone_id=v_target WHERE d.task_id=p_task;
   UPDATE dispatch_tasks SET status='COMPLETED',completed_at=UTC_TIMESTAMP(3) WHERE id=p_task;
   CALL sp_dispatch_inventory(v_source,v_target,v_inventory);
   UPDATE dispatch_tasks SET inventory_completed=v_inventory WHERE id=p_task;
  ELSEIF p_action='cancel' THEN
   IF v_status<>'PENDING' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='DISPATCH_CANNOT_CANCEL'; END IF;
   UPDATE bikes b JOIN dispatch_bikes d ON d.bike_id=b.id SET b.status='AVAILABLE' WHERE d.task_id=p_task;
   UPDATE dispatch_tasks SET status='CANCELLED',completed_at=UTC_TIMESTAMP(3) WHERE id=p_task;
   CALL sp_dispatch_inventory(v_source,v_target,v_inventory);
   UPDATE dispatch_tasks SET inventory_completed=v_inventory WHERE id=p_task;
  ELSE SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_DISPATCH_INPUT';
  END IF;
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,CONCAT('DISPATCH_',UPPER(p_action)),'dispatch_tasks',p_task,JSON_OBJECT());
 SELECT TRUE AS ok;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_save_dispatch_suggestions;
DELIMITER $$
CREATE PROCEDURE sp_save_dispatch_suggestions(IN p_actor BIGINT UNSIGNED, IN p_filter JSON, IN p_start DATETIME(3), IN p_end DATETIME(3), IN p_suggestions JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE done BOOLEAN DEFAULT FALSE;
 DECLARE v_source,v_target BIGINT UNSIGNED;
 DECLARE v_quantity,v_source_available,v_occupied,v_capacity,v_reserved,v_borrow,v_return,v_desired INT;
 DECLARE v_reason VARCHAR(500);
 DECLARE v_ids JSON DEFAULT (JSON_ARRAY());
 DECLARE suggestions CURSOR FOR SELECT source,target,quantity,source_available,occupied,capacity,reserved,borrow_count,return_count,desired,reason
 FROM JSON_TABLE(p_suggestions,'$[*]' COLUMNS(position FOR ORDINALITY,source BIGINT UNSIGNED PATH '$.source_zone_id',target BIGINT UNSIGNED PATH '$.target_zone_id',
 quantity INT PATH '$.quantity',source_available INT PATH '$.source_available',occupied INT PATH '$.target_occupied',capacity INT PATH '$.target_capacity',
 reserved INT PATH '$.target_reserved',borrow_count INT PATH '$.borrow_count',return_count INT PATH '$.return_count',desired INT PATH '$.desired_inventory',reason VARCHAR(500) PATH '$.reason')) s ORDER BY position;
 DECLARE CONTINUE HANDLER FOR NOT FOUND SET done=TRUE;
 OPEN suggestions;
 suggestion_loop: LOOP
  FETCH suggestions INTO v_source,v_target,v_quantity,v_source_available,v_occupied,v_capacity,v_reserved,v_borrow,v_return,v_desired,v_reason;
  IF done THEN LEAVE suggestion_loop; END IF;
  INSERT INTO dispatch_suggestions(source_zone_id,target_zone_id,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,window_start,window_end,reason,algorithm_version,created_by)
  VALUES(v_source,v_target,v_quantity,v_source_available,v_occupied,v_capacity,v_reserved,v_borrow,v_return,v_desired,p_start,p_end,v_reason,'demand-balance-v2',p_actor);
  SET v_ids=JSON_ARRAY_APPEND(v_ids,'$',LAST_INSERT_ID());
 END LOOP;
 CLOSE suggestions;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,'SUGGESTIONS_GENERATE','dispatch_suggestions',NULL,JSON_OBJECT('filter',p_filter,'count',JSON_LENGTH(v_ids)));
 SELECT s.id,s.source_zone_id,s.target_zone_id,a.name AS source_name,b.name AS target_name,s.quantity,s.desired_inventory,
  s.source_available,s.target_occupied,s.target_capacity,s.target_reserved,s.borrow_count,s.return_count,s.reason,s.status
 FROM JSON_TABLE(v_ids,'$[*]' COLUMNS(position FOR ORDINALITY,id BIGINT UNSIGNED PATH '$')) ids
 JOIN dispatch_suggestions s ON s.id=ids.id JOIN parking_zones a ON a.id=s.source_zone_id JOIN parking_zones b ON b.id=s.target_zone_id
 ORDER BY ids.position;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_prepare_dispatch_suggestion;
DELIMITER $$
CREATE PROCEDURE sp_prepare_dispatch_suggestion(IN p_actor BIGINT UNSIGNED, IN p_id BIGINT UNSIGNED)
SQL SECURITY INVOKER
prepare_suggestion: BEGIN
 DECLARE v_status,v_source_status,v_target_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_source,v_target BIGINT UNSIGNED;
 DECLARE v_quantity,v_capacity,v_occupied,v_reserved,v_free,v_found INT;
 DECLARE v_bikes JSON;
 DECLARE v_note VARCHAR(500);
 SELECT status,source_zone_id,target_zone_id,quantity INTO v_status,v_source,v_target,v_quantity FROM dispatch_suggestions WHERE id=p_id FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_NOT_FOUND'; END IF;
 IF v_status<>'OPEN' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_NOT_OPEN'; END IF;
 IF v_quantity>100 THEN
  SET v_note='旧建议超过单次调度上限，请重新生成建议';
  UPDATE dispatch_suggestions SET status='STALE',resolution_note=v_note,resolved_at=UTC_TIMESTAMP(3) WHERE id=p_id;
  INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
  VALUES(p_actor,'SUGGESTION_STALE','dispatch_suggestions',p_id,JSON_OBJECT('note',v_note));
  SELECT v_note AS stale;
  LEAVE prepare_suggestion;
 END IF;
 SELECT status INTO v_source_status FROM parking_zones WHERE id=v_source FOR UPDATE;
 SELECT status,capacity INTO v_target_status,v_capacity FROM parking_zones WHERE id=v_target FOR UPDATE;
 CALL sp_zone_load(v_target,v_occupied,v_reserved);
 SELECT COALESCE(JSON_ARRAYAGG(id),JSON_ARRAY()) INTO v_bikes FROM (
  SELECT id FROM bikes WHERE current_zone_id=v_source AND status='AVAILABLE' ORDER BY id LIMIT v_quantity FOR UPDATE
 ) available_bikes;
 SET v_free=v_capacity-v_occupied-v_reserved,v_found=JSON_LENGTH(v_bikes);
 IF v_source_status<>'ACTIVE' OR v_target_status<>'ACTIVE' OR v_found<v_quantity OR v_free<v_quantity THEN
  SET v_note=CONCAT('当前源站可调 ',v_found,' 辆，目标空位 ',GREATEST(0,v_free),' 个');
  UPDATE dispatch_suggestions SET status='STALE',resolution_note=v_note,resolved_at=UTC_TIMESTAMP(3) WHERE id=p_id;
  INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
  VALUES(p_actor,'SUGGESTION_STALE','dispatch_suggestions',p_id,JSON_OBJECT('note',v_note));
  SELECT v_note AS stale;
  LEAVE prepare_suggestion;
 END IF;
 SELECT v_source AS source_zone_id,v_target AS target_zone_id,v_bikes AS bike_ids;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_finish_dispatch_suggestion;
DELIMITER $$
CREATE PROCEDURE sp_finish_dispatch_suggestion(IN p_id BIGINT UNSIGNED, IN p_task BIGINT UNSIGNED)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_suggestion_status,v_task_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_source,v_target,v_task_source,v_task_target BIGINT UNSIGNED;
 DECLARE v_quantity INT;
 SELECT status,source_zone_id,target_zone_id,quantity INTO v_suggestion_status,v_source,v_target,v_quantity
 FROM dispatch_suggestions WHERE id=p_id FOR UPDATE;
 IF v_suggestion_status IS NULL OR v_suggestion_status<>'OPEN' THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_NOT_OPEN';
 END IF;
 SELECT status,source_zone_id,target_zone_id INTO v_task_status,v_task_source,v_task_target
 FROM dispatch_tasks WHERE id=p_task FOR UPDATE;
 IF v_task_status IS NULL OR v_task_status<>'PENDING' OR v_source<>v_task_source OR v_target<>v_task_target
  OR v_quantity<>(SELECT COUNT(*) FROM dispatch_bikes WHERE task_id=p_task) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_TASK_MISMATCH';
 END IF;
 IF EXISTS(SELECT 1 FROM dispatch_suggestions WHERE task_id=p_task) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_TASK_LINKED';
 END IF;
 UPDATE dispatch_suggestions SET status='CONFIRMED',task_id=p_task,resolved_at=UTC_TIMESTAMP(3) WHERE id=p_id AND status='OPEN';
 SELECT p_task AS id,p_id AS suggestion_id;
END$$
DELIMITER ;

-- Greedy allocations are intersections of cumulative supply and demand ranges.
-- Capacity is at most 1000, so ten 100-bike chunks cover every allocation.
DROP PROCEDURE IF EXISTS sp_dispatch_suggestions;
DELIMITER $$
CREATE PROCEDURE sp_dispatch_suggestions(IN p_zones JSON, IN p_demand JSON, IN p_campus JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_areas GEOMETRY DEFAULT NULL;
 CALL sp_campus_restrictions(p_campus,v_areas);
 WITH RECURSIVE chunks AS (
  SELECT 0 AS n UNION ALL SELECT n+1 FROM chunks WHERE n<9
 ), demand_by_zone AS (
  SELECT zone_id,SUM(borrow_count) AS borrow_count,SUM(return_count) AS return_count
  FROM JSON_TABLE(p_demand,'$[*]' COLUMNS(zone_id BIGINT UNSIGNED PATH '$.zone_id',borrow_count INT PATH '$.borrow_count' NULL ON EMPTY,return_count INT PATH '$.return_count' NULL ON EMPTY)) demand
  GROUP BY zone_id
 ), base AS (
  SELECT z.id,z.name,z.capacity,z.available,z.occupied,z.reserved,
   IF(v_areas IS NOT NULL AND z.x IS NOT NULL AND z.y IS NOT NULL,ST_Intersects(POINT(z.x,z.y),v_areas),FALSE) AS restricted,
   COALESCE(d.borrow_count,0) AS borrow_count,COALESCE(d.return_count,0) AS return_count,
   LEAST(CEIL(z.capacity*0.8),GREATEST(CEIL(z.capacity*0.4),CEIL(z.capacity*0.4+(COALESCE(d.borrow_count,0)-COALESCE(d.return_count,0))*0.2))) AS desired
  FROM JSON_TABLE(p_zones,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',name VARCHAR(60) PATH '$.name',capacity INT PATH '$.capacity',
   available INT PATH '$.available',occupied INT PATH '$.occupied',reserved INT PATH '$.reserved',status VARCHAR(20) PATH '$.status' NULL ON EMPTY,
   x DECIMAL(10,2) PATH '$.x' NULL ON EMPTY,y DECIMAL(10,2) PATH '$.y' NULL ON EMPTY)) z
  LEFT JOIN demand_by_zone d ON d.zone_id=z.id
  WHERE z.status IS NULL OR z.status='ACTIVE'
 ), states AS (
  SELECT *,IF(restricted,available,GREATEST(0,available-desired)) AS supply,GREATEST(0,desired-available) AS need,
   GREATEST(0,capacity-occupied-reserved) AS free FROM base
 ), sources AS (
  SELECT *,SUM(supply) OVER (ORDER BY restricted DESC,supply DESC,id ROWS UNBOUNDED PRECEDING) AS supply_end FROM states WHERE supply>0
 ), targets AS (
  SELECT *,SUM(LEAST(need,free)) OVER (ORDER BY need DESC,id ROWS UNBOUNDED PRECEDING) AS demand_end FROM states WHERE need>0 AND free>0 AND NOT restricted
 ), allocations AS (
  SELECT s.id AS source_zone_id,t.id AS target_zone_id,s.name AS source_name,t.name AS target_name,
   CAST(GREATEST(0,LEAST(s.supply_end,t.demand_end)-GREATEST(s.supply_end-s.supply,t.demand_end-LEAST(t.need,t.free))) AS SIGNED) AS quantity,
   t.desired AS desired_inventory,t.available AS target_available,t.need AS sort_need,s.supply AS sort_supply,
   s.available AS source_available,s.restricted AS source_restricted,t.occupied AS target_occupied,t.capacity AS target_capacity,t.reserved AS target_reserved,
   t.borrow_count,t.return_count
  FROM targets t JOIN sources s ON s.supply_end>t.demand_end-LEAST(t.need,t.free) AND t.demand_end>s.supply_end-s.supply
 )
 SELECT a.source_zone_id,a.target_zone_id,a.source_name,a.target_name,LEAST(100,a.quantity-chunks.n*100) AS quantity,a.desired_inventory,
  a.source_available,a.target_occupied,a.target_capacity,a.target_reserved,a.borrow_count,a.return_count,
  CONCAT(IF(a.source_restricted,'优先转出禁行站点车辆；',''),'目标库存 ',a.target_available,'，建议保有 ',a.desired_inventory,'；按容量、预留车位及历史净借车需求估算') AS reason
 FROM allocations a JOIN chunks ON chunks.n*100<a.quantity
 ORDER BY a.sort_need DESC,a.target_zone_id,a.source_restricted DESC,a.sort_supply DESC,a.source_zone_id,chunks.n;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_dispatch_inventory;
DELIMITER $$
CREATE PROCEDURE sp_dispatch_inventory(IN p_source BIGINT UNSIGNED, IN p_target BIGINT UNSIGNED, OUT p_inventory JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_source_occupied,v_source_reserved,v_target_occupied,v_target_reserved INT;
 CALL sp_zone_load(p_source,v_source_occupied,v_source_reserved);
 CALL sp_zone_load(p_target,v_target_occupied,v_target_reserved);
 SELECT JSON_OBJECT(
  'source',JSON_OBJECT('zone_id',s.id,'name',s.name,'available',(SELECT COUNT(*) FROM bikes WHERE current_zone_id=s.id AND status='AVAILABLE'),
   'occupied',v_source_occupied,'reserved',v_source_reserved,'capacity',s.capacity),
  'target',JSON_OBJECT('zone_id',t.id,'name',t.name,'available',(SELECT COUNT(*) FROM bikes WHERE current_zone_id=t.id AND status='AVAILABLE'),
   'occupied',v_target_occupied,'reserved',v_target_reserved,'capacity',t.capacity)
 ) INTO p_inventory FROM parking_zones s JOIN parking_zones t ON t.id=p_target WHERE s.id=p_source;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_dismiss_dispatch_suggestion;
DELIMITER $$
CREATE PROCEDURE sp_dismiss_dispatch_suggestion(IN p_actor BIGINT UNSIGNED, IN p_id BIGINT UNSIGNED, IN p_note VARCHAR(500))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 SELECT status INTO v_status FROM dispatch_suggestions WHERE id=p_id FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_NOT_FOUND'; END IF;
 IF v_status<>'OPEN' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SUGGESTION_NOT_OPEN'; END IF;
 UPDATE dispatch_suggestions SET status='DISMISSED',resolution_note=p_note,resolved_at=UTC_TIMESTAMP(3) WHERE id=p_id;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,'SUGGESTION_DISMISS','dispatch_suggestions',p_id,JSON_OBJECT('note',p_note));
 SELECT p_id AS id,'DISMISSED' AS status,p_note AS resolution_note;
END$$
DELIMITER ;
