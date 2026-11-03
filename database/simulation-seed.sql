-- 导入仓库内的 123 个模拟账号和 200 辆模拟车；事务、命名锁由调用方持有。
CREATE PROCEDURE __SEED_PROCEDURE__(IN p_users JSON, IN p_bikes JSON, IN p_hash VARCHAR(100), IN p_campus JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_users,v_bikes INT DEFAULT 0;
 DECLARE v_plan JSON;
 DECLARE v_areas GEOMETRY DEFAULT NULL;
 DECLARE v_digest CHAR(64);
 DECLARE v_existing BOOLEAN DEFAULT FALSE;
 IF NOT EXISTS(SELECT 1 FROM system_settings WHERE name='seed_version') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_BASE_REQUIRED';
 END IF;
 IF p_users IS NULL OR JSON_TYPE(p_users)<>'ARRAY' OR JSON_LENGTH(p_users)<>123
  OR p_bikes IS NULL OR JSON_TYPE(p_bikes)<>'ARRAY' OR JSON_LENGTH(p_bikes)<>200
  OR (SELECT COUNT(DISTINCT id) FROM JSON_TABLE(p_users,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id' ERROR ON EMPTY ERROR ON ERROR)) j)<>123
  OR (SELECT COUNT(DISTINCT id) FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id' ERROR ON EMPTY ERROR ON ERROR)) j)<>200
  OR EXISTS(SELECT 1 FROM JSON_TABLE(p_users,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id')) j WHERE id NOT BETWEEN 1 AND 123)
  OR EXISTS(SELECT 1 FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id')) j WHERE id NOT BETWEEN 1 AND 200) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_DATA_INVALID';
 END IF;
 IF EXISTS(SELECT 1 FROM users u LEFT JOIN JSON_TABLE(p_users,'$[*]' COLUMNS(
  id BIGINT UNSIGNED PATH '$.id',email VARCHAR(160) PATH '$.email',phone VARCHAR(20) PATH '$.phone',role VARCHAR(20) PATH '$.role')) j ON j.id=u.id
  WHERE j.id IS NULL OR BINARY u.email<>BINARY j.email OR BINARY u.phone<>BINARY j.phone OR BINARY u.role<>BINARY j.role) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_USER_CONFLICT';
 END IF;
 IF EXISTS(SELECT 1 FROM bikes b LEFT JOIN JSON_TABLE(p_bikes,'$[*]' COLUMNS(
  id BIGINT UNSIGNED PATH '$.id',code VARCHAR(30) PATH '$.code')) j ON j.id=b.id
  WHERE j.id IS NULL OR BINARY b.code<>BINARY j.code) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_BIKE_CONFLICT';
 END IF;
 SET v_digest=SHA2(CONCAT(CAST(p_users AS CHAR),'\n',CAST(p_bikes AS CHAR)),256),
  v_existing=EXISTS(SELECT 1 FROM system_settings WHERE name='simulation_123_200');
 IF v_existing AND NOT EXISTS(SELECT 1 FROM system_settings WHERE name='simulation_123_200'
  AND BINARY JSON_UNQUOTE(JSON_EXTRACT(value,'$.data_sha256'))=BINARY v_digest) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_PROFILE_CONFLICT';
 END IF;
 CALL sp_campus_restrictions(p_campus,v_areas);
 IF EXISTS(SELECT 1 FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',zone_id BIGINT UNSIGNED PATH '$.zone_id')) j
  LEFT JOIN bikes b ON b.id=j.id LEFT JOIN parking_zones z ON z.id=j.zone_id
  WHERE b.id IS NULL AND (z.id IS NULL OR z.status<>'ACTIVE'
   OR (v_areas IS NOT NULL AND ST_Intersects(POINT(z.x,z.y),v_areas)))) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_ZONE_UNAVAILABLE';
 END IF;
 SELECT COALESCE(JSON_ARRAYAGG(JSON_OBJECT('id',z.id,'previous',z.capacity,
  'capacity',z.occupied+z.reserved+n.total+(n.total+4) DIV 5)),JSON_ARRAY()) INTO v_plan
 FROM v_zone_inventory z JOIN (
  SELECT j.zone_id,COUNT(*) total FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',zone_id BIGINT UNSIGNED PATH '$.zone_id')) j
  LEFT JOIN bikes b ON b.id=j.id WHERE b.id IS NULL GROUP BY j.zone_id
 ) n ON n.zone_id=z.id WHERE z.capacity<z.occupied+z.reserved+n.total+(n.total+4) DIV 5;
 IF EXISTS(SELECT 1 FROM JSON_TABLE(v_plan,'$[*]' COLUMNS(capacity INT PATH '$.capacity')) j WHERE capacity>1000) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_CAPACITY_EXCEEDED';
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 SELECT 1,'SIMULATION_ZONE_EXPAND','parking_zones',j.id,JSON_OBJECT('previous_capacity',j.previous,'capacity',j.capacity)
 FROM JSON_TABLE(v_plan,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',previous INT PATH '$.previous',capacity INT PATH '$.capacity')) j;
 UPDATE parking_zones z JOIN JSON_TABLE(v_plan,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',capacity INT PATH '$.capacity')) j ON j.id=z.id
 SET z.capacity=j.capacity;
 INSERT INTO users(id,name,email,phone,password_hash,role,leaderboard_alias)
 SELECT j.id,j.name,j.email,j.phone,p_hash,j.role,CONCAT('模拟骑行者',LPAD(j.id,3,'0'))
 FROM JSON_TABLE(p_users,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',name VARCHAR(40) PATH '$.name',
  email VARCHAR(160) PATH '$.email',phone VARCHAR(20) PATH '$.phone',role VARCHAR(20) PATH '$.role')) j
 LEFT JOIN users u ON u.id=j.id WHERE u.id IS NULL;
 SET v_users=ROW_COUNT();
 INSERT INTO bikes(id,code,deployed_at,current_zone_id,last_service_at)
 SELECT j.id,j.code,j.deployed_at,j.zone_id,UTC_TIMESTAMP(3)-INTERVAL MOD(j.id,90) DAY
 FROM JSON_TABLE(p_bikes,'$[*]' COLUMNS(id BIGINT UNSIGNED PATH '$.id',code VARCHAR(30) PATH '$.code',
  deployed_at DATE PATH '$.deployed_at',zone_id BIGINT UNSIGNED PATH '$.zone_id')) j
 LEFT JOIN bikes b ON b.id=j.id WHERE b.id IS NULL;
 SET v_bikes=ROW_COUNT();
 IF (SELECT COUNT(*) FROM users)<>123 OR (SELECT COUNT(*) FROM bikes)<>200 THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='SIMULATION_COUNT_MISMATCH';
 END IF;
 IF NOT v_existing OR v_users>0 OR v_bikes>0 THEN
  INSERT INTO system_settings(name,value) VALUES('simulation_123_200',JSON_OBJECT(
   'version',1,'users',123,'bikes',200,'data_sha256',v_digest,'imported_at',UTC_TIMESTAMP(3)))
  ON DUPLICATE KEY UPDATE value=VALUES(value);
  INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(1,'SIMULATION_IMPORT','system_settings',NULL,
   JSON_OBJECT('users_created',v_users,'bikes_created',v_bikes,'users',123,'bikes',200,'data_sha256',v_digest));
 END IF;
 SELECT v_users AS users_created,v_bikes AS bikes_created,123 AS users,200 AS bikes;
END
