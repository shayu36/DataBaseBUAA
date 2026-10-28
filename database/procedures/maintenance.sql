-- MySQL stored procedures; transactions are owned by the caller.

DROP PROCEDURE IF EXISTS sp_report_fault;
DELIMITER $$
CREATE PROCEDURE sp_report_fault(IN p_actor BIGINT UNSIGNED, IN p_bike BIGINT UNSIGNED, IN p_fault VARCHAR(20), IN p_description VARCHAR(500))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_rider BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_ticket BIGINT UNSIGNED;
 SELECT status INTO v_status FROM bikes WHERE id=p_bike FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_NOT_FOUND'; END IF;
 IF v_status NOT IN ('AVAILABLE','RIDING') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FAULT_BIKE_UNAVAILABLE'; END IF;
 IF v_status='RIDING' THEN
  SELECT user_id INTO v_rider FROM ride_orders WHERE active_bike=p_bike;
  IF v_rider IS NULL OR v_rider<>p_actor THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='FAULT_FORBIDDEN'; END IF;
 END IF;
 INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(p_bike,p_actor,p_fault,p_description);
 SET v_ticket=LAST_INSERT_ID();
 IF v_status='AVAILABLE' THEN UPDATE bikes SET status='MAINTENANCE' WHERE id=p_bike; END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(p_actor,'FAULT_REPORT','maintenance_tickets',v_ticket,JSON_OBJECT());
 SELECT v_ticket AS id;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_maintenance_action;
DELIMITER $$
CREATE PROCEDURE sp_maintenance_action(IN p_actor BIGINT UNSIGNED, IN p_ticket BIGINT UNSIGNED,
 IN p_action VARCHAR(20), IN p_staff BIGINT UNSIGNED, IN p_result VARCHAR(500))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_bike BIGINT UNSIGNED;
 DECLARE v_assigned BIGINT UNSIGNED;
 DECLARE v_staff_user BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_staff_status,v_staff_job,v_user_status,v_role,v_bike_status VARCHAR(20);
 DECLARE v_zone BIGINT UNSIGNED;
 SELECT status,bike_id,staff_id INTO v_status,v_bike,v_assigned FROM maintenance_tickets WHERE id=p_ticket FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TICKET_NOT_FOUND'; END IF;
 SELECT role INTO v_role FROM users WHERE id=p_actor;
 IF p_action='assign' THEN
  IF v_role<>'ADMIN' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAINTENANCE_FORBIDDEN'; END IF;
  IF v_status='COMPLETED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TICKET_COMPLETED'; END IF;
  SET v_assigned=p_staff;
 ELSEIF v_role<>'ADMIN' AND (v_role<>'OPERATOR' OR v_assigned IS NULL) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MAINTENANCE_FORBIDDEN';
 END IF;
 IF p_action='assign' OR v_role<>'ADMIN' THEN
  SELECT s.user_id,s.status,s.job,u.status INTO v_staff_user,v_staff_status,v_staff_job,v_user_status
  FROM staff s JOIN users u ON u.id=s.user_id WHERE s.id=v_assigned FOR UPDATE;
  IF v_staff_user IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_NOT_FOUND'; END IF;
  IF v_staff_status<>'ACTIVE' OR v_user_status<>'ACTIVE' OR v_staff_job NOT IN ('MAINTENANCE','BOTH') THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_UNAVAILABLE';
  END IF;
  IF p_action<>'assign' AND v_staff_user<>p_actor THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TASK_NOT_ASSIGNED'; END IF;
 END IF;
 IF p_action='assign' THEN
  UPDATE maintenance_tickets SET staff_id=v_assigned,status='ASSIGNED' WHERE id=p_ticket;
 ELSEIF p_action='complete' THEN
  IF v_status<>'ASSIGNED' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='TICKET_NOT_ASSIGNED'; END IF;
  SELECT status,current_zone_id INTO v_bike_status,v_zone FROM bikes WHERE id=v_bike FOR UPDATE;
  IF v_bike_status<>'MAINTENANCE' OR v_zone IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_NOT_RETURNED'; END IF;
  UPDATE maintenance_tickets SET status='COMPLETED',result=p_result,completed_at=UTC_TIMESTAMP(3) WHERE id=p_ticket;
  UPDATE bikes SET status='AVAILABLE',last_service_at=UTC_TIMESTAMP(3) WHERE id=v_bike;
 ELSE SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_MAINTENANCE_ACTION';
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,CONCAT('MAINTENANCE_',UPPER(p_action)),'maintenance_tickets',p_ticket,JSON_OBJECT());
 SELECT TRUE AS ok;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_act_on_risk;
DELIMITER $$
CREATE PROCEDURE sp_act_on_risk(IN p_actor BIGINT UNSIGNED, IN p_risk BIGINT UNSIGNED, IN p_action VARCHAR(20), IN p_note VARCHAR(500))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_role,v_status,v_bike_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_bike,v_ticket BIGINT UNSIGNED DEFAULT NULL;
 SELECT role INTO v_role FROM users WHERE id=p_actor;
 IF v_role<>'ADMIN' AND (v_role<>'OPERATOR' OR NOT EXISTS(
  SELECT 1 FROM staff s JOIN users u ON u.id=s.user_id WHERE s.user_id=p_actor AND s.status='ACTIVE' AND u.status='ACTIVE' AND s.job IN('MAINTENANCE','BOTH')
 )) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RISK_HANDLER_FORBIDDEN'; END IF;
 SELECT status,bike_id,maintenance_ticket_id INTO v_status,v_bike,v_ticket FROM risk_alerts WHERE id=p_risk FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RISK_NOT_FOUND'; END IF;
 IF v_status IN ('RESOLVED','DISMISSED') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RISK_CLOSED'; END IF;
 IF p_action='ACKNOWLEDGE' THEN
  SET v_status='ACKNOWLEDGED';
  UPDATE risk_alerts SET status=v_status,handler_id=p_actor,resolution_note=p_note,acknowledged_at=UTC_TIMESTAMP(3) WHERE id=p_risk;
 ELSEIF p_action='CREATE_TICKET' THEN
  IF v_ticket IS NULL THEN
   SELECT id INTO v_ticket FROM maintenance_tickets WHERE active_bike=v_bike;
   IF v_ticket IS NULL THEN
    SELECT status INTO v_bike_status FROM bikes WHERE id=v_bike FOR UPDATE;
    IF v_bike_status NOT IN ('AVAILABLE','RIDING') THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RISK_BIKE_UNAVAILABLE'; END IF;
    INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(v_bike,p_actor,'OTHER',LEFT(CONCAT('风险检查：',p_note),500));
    SET v_ticket=LAST_INSERT_ID();
    IF v_bike_status='AVAILABLE' THEN UPDATE bikes SET status='MAINTENANCE' WHERE id=v_bike; END IF;
   END IF;
  END IF;
  SET v_status='ACKNOWLEDGED';
  UPDATE risk_alerts SET status=v_status,handler_id=p_actor,maintenance_ticket_id=v_ticket,resolution_note=p_note,acknowledged_at=COALESCE(acknowledged_at,UTC_TIMESTAMP(3)) WHERE id=p_risk;
 ELSEIF p_action IN ('RESOLVE','DISMISS') THEN
  SET v_status=IF(p_action='RESOLVE','RESOLVED','DISMISSED');
  UPDATE risk_alerts SET status=v_status,handler_id=p_actor,resolution_note=p_note,resolved_at=UTC_TIMESTAMP(3) WHERE id=p_risk;
 ELSE SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_RISK_ACTION';
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,CONCAT('RISK_',p_action),'risk_alerts',p_risk,JSON_OBJECT('note',p_note,'ticket_id',v_ticket));
 SELECT p_risk AS id,v_status AS status,v_ticket AS maintenance_ticket_id;
END$$
DELIMITER ;

-- Persist and deduplicate risk candidates in MySQL.
DROP PROCEDURE IF EXISTS sp_refresh_risk_alerts;
DELIMITER $$
CREATE PROCEDURE sp_refresh_risk_alerts(IN p_actor BIGINT UNSIGNED, IN p_evaluated INT, IN p_version VARCHAR(30), IN p_now DATETIME(3), IN p_risks JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_new JSON;
 SELECT /*+ SET_VAR(group_concat_max_len=4294967295) */ COALESCE(JSON_ARRAYAGG(JSON_OBJECT('bike_id',j.bike_id,'score',j.score,'level',j.level,'reasons',j.reasons,
  'tickets',(SELECT JSON_OBJECT('ids',CAST(CONCAT('[',COALESCE(GROUP_CONCAT(t.id ORDER BY t.id SEPARATOR ','),''),']') AS JSON),'count',COUNT(*))
   FROM maintenance_tickets t WHERE t.bike_id=j.bike_id AND t.created_at<=p_now),
  'fingerprint',j.fingerprint)),JSON_ARRAY()) INTO v_new
 FROM (SELECT input.bike_id,input.score,input.level,input.reasons,
  SHA2(CONCAT('{"bike_id":',input.bike_id,',"version":',JSON_QUOTE(p_version),',"reasons":[',
   (SELECT GROUP_CONCAT(JSON_QUOTE(message) ORDER BY position SEPARATOR ',')
    FROM JSON_TABLE(input.messages,'$[*]' COLUMNS(position FOR ORDINALITY,message VARCHAR(500) PATH '$')) items),']}'),256) AS fingerprint
  FROM JSON_TABLE(p_risks,'$[*]' COLUMNS(
   bike_id BIGINT UNSIGNED PATH '$.bike_id',score INT PATH '$.score',level VARCHAR(10) PATH '$.level',
   reasons JSON PATH '$.reason_details',messages JSON PATH '$.reasons')) input WHERE input.score>=30) j
 LEFT JOIN risk_alerts r ON r.open_fingerprint=j.fingerprint COLLATE utf8mb4_0900_ai_ci WHERE r.id IS NULL;
 IF EXISTS (SELECT 1 FROM JSON_TABLE(v_new,'$[*]' COLUMNS(tickets JSON PATH '$.tickets')) j
  WHERE COALESCE(JSON_TYPE(JSON_EXTRACT(j.tickets,'$.ids')),'')<>'ARRAY'
   OR JSON_LENGTH(JSON_EXTRACT(j.tickets,'$.ids'))<>JSON_EXTRACT(j.tickets,'$.count')) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RISK_TICKETS_TRUNCATED';
 END IF;
 INSERT INTO risk_alerts(bike_id,score,level,reasons,ticket_ids,fingerprint,rule_version,recommendation)
 SELECT bike_id,score,level,reasons,ticket_ids,fingerprint,p_version,'请检查相关部件并结合工单历史确认车辆状态'
 FROM JSON_TABLE(v_new,'$[*]' COLUMNS(
  bike_id BIGINT UNSIGNED PATH '$.bike_id',score INT PATH '$.score',level VARCHAR(10) PATH '$.level',
  reasons JSON PATH '$.reasons',ticket_ids JSON PATH '$.tickets.ids',fingerprint CHAR(64) PATH '$.fingerprint')) j;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor,'RISK_REFRESH','risk_alerts',NULL,JSON_OBJECT('rule_version',p_version,'evaluated',p_evaluated,'created',JSON_LENGTH(v_new)));
 SELECT r.id FROM JSON_TABLE(v_new,'$[*]' COLUMNS(position FOR ORDINALITY,fingerprint CHAR(64) PATH '$.fingerprint')) j
 JOIN risk_alerts r ON r.open_fingerprint=j.fingerprint COLLATE utf8mb4_0900_ai_ci ORDER BY j.position;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_risk_inputs;
DELIMITER $$
CREATE PROCEDURE sp_risk_inputs(IN p_now DATETIME(3))
SQL SECURITY INVOKER
BEGIN
 WITH recent_groups AS (
  SELECT bike_id,fault_type,COUNT(*) AS fault_count,MIN(id) AS first_id FROM maintenance_tickets
  WHERE created_at>=p_now-INTERVAL 30 DAY AND created_at<=p_now GROUP BY bike_id,fault_type
 ), recent AS (
  SELECT bike_id,SUM(fault_count) AS total,SUM(fault_count>=2) AS repeated_types FROM recent_groups GROUP BY bike_id
 ), short_rides AS (
  SELECT bike_id,COUNT(*) AS short_count FROM ride_orders
  WHERE ended_at>=p_now-INTERVAL 30 DAY AND ended_at<=p_now AND distance_m>=500
   AND TIMESTAMPDIFF(MICROSECOND,started_at,ended_at)>0 AND TIMESTAMPDIFF(MICROSECOND,started_at,ended_at)<60000000 GROUP BY bike_id
 ), repaired AS (
  SELECT bike_id,MAX(completed_at) AS last_repair FROM maintenance_tickets
  WHERE status='COMPLETED' AND completed_at<=p_now GROUP BY bike_id
 ), bike_stats AS (
  SELECT b.id AS bike_id,b.code,COALESCE(recent.total,0) AS recent_count,COALESCE(recent.repeated_types,0) AS repeated_types,COALESCE(short_rides.short_count,0) AS short_count,
   CASE WHEN b.last_service_at IS NULL OR b.last_service_at>p_now THEN repaired.last_repair WHEN repaired.last_repair IS NULL OR b.last_service_at>=repaired.last_repair THEN b.last_service_at ELSE repaired.last_repair END AS last_repair
  FROM bikes b LEFT JOIN recent ON recent.bike_id=b.id LEFT JOIN short_rides ON short_rides.bike_id=b.id LEFT JOIN repaired ON repaired.bike_id=b.id WHERE b.status<>'RETIRED'
 ), service AS (
  SELECT *,IF(last_repair IS NULL,NULL,TIMESTAMPDIFF(DAY,last_repair,p_now)) AS service_days FROM bike_stats
 ), scored AS (
  SELECT *,LEAST(100,LEAST(40,recent_count*10)+repeated_types*20+
   CASE WHEN service_days IS NULL THEN 20 WHEN service_days>=90 THEN 30 WHEN service_days>=30 THEN 10 ELSE 0 END) AS score FROM service
 ), reasons AS (
  SELECT bike_id,1 AS priority,0 AS sequence,'RECENT_FAULTS' AS rule,
   CONCAT('近30天报修 ',recent_count,' 次（+',LEAST(40,recent_count*10),'）') AS message FROM scored WHERE recent_count>0
  UNION ALL
  SELECT bike_id,2,first_id,'REPEAT_FAULT',CONCAT(fault_type,' 同类型故障复发 ',fault_count,' 次（+20）')
  FROM recent_groups WHERE fault_count>=2
  UNION ALL
  SELECT bike_id,3,0,'SERVICE_GAP',CASE WHEN service_days IS NULL THEN '无有效维修记录（+20）'
   WHEN service_days>=90 THEN CONCAT('距最近维修 ',service_days,' 天（+30）') ELSE CONCAT('距最近维修 ',service_days,' 天（+10）') END
  FROM scored WHERE service_days IS NULL OR service_days>=30
  UNION ALL
  SELECT bike_id,4,0,'SHORT_RIDE',CONCAT('近30天异常短行程 ',short_count,' 次（辅助线索，不计分）') FROM scored WHERE short_count>0
  UNION ALL
  SELECT bike_id,5,0,'NONE','近期无触发规则的风险因素' FROM scored
  WHERE recent_count=0 AND service_days IS NOT NULL AND service_days<30 AND short_count=0
 ), explanations AS (
  SELECT bike_id,
   CAST(CONCAT('[',GROUP_CONCAT(JSON_QUOTE(message) ORDER BY priority,sequence SEPARATOR ','),']') AS JSON) AS reasons,
   CAST(CONCAT('[',GROUP_CONCAT(JSON_OBJECT('rule',rule,'message',message) ORDER BY priority,sequence SEPARATOR ','),']') AS JSON) AS reason_details
  FROM reasons GROUP BY bike_id
 )
 SELECT /*+ SET_VAR(group_concat_max_len=4294967295) */ s.bike_id,s.code,s.score,
  CASE WHEN s.score>=60 THEN 'HIGH' WHEN s.score>=30 THEN 'MEDIUM' ELSE 'LOW' END AS level,e.reasons,e.reason_details
 FROM scored s JOIN explanations e ON e.bike_id=s.bike_id ORDER BY s.score DESC,s.bike_id;
END$$
DELIMITER ;
