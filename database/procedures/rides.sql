-- MySQL stored procedures; transactions are owned by the caller.

-- The application supplies an already authorized actor and owns the transaction.
DROP PROCEDURE IF EXISTS sp_start_ride;
DELIMITER $$
CREATE PROCEDURE sp_start_ride(IN actor_id BIGINT UNSIGNED, IN requested_bike_id BIGINT UNSIGNED)
SQL SECURITY INVOKER
BEGIN
 DECLARE bike_status VARCHAR(20) DEFAULT NULL;
 DECLARE bike_zone BIGINT UNSIGNED DEFAULT NULL;
 DECLARE zone_status VARCHAR(20) DEFAULT NULL;
 DECLARE new_order_id BIGINT UNSIGNED;
 IF EXISTS(SELECT 1 FROM ride_orders WHERE active_user=actor_id) THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ACTIVE_RIDE';
 END IF;
 IF EXISTS(SELECT 1 FROM ride_orders WHERE user_id=actor_id AND status='UNPAID') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='UNPAID_ORDER';
 END IF;
 SELECT status,current_zone_id INTO bike_status,bike_zone FROM bikes WHERE id=requested_bike_id FOR UPDATE;
 IF bike_status IS NULL THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_NOT_FOUND';
 END IF;
 IF bike_status<>'AVAILABLE' THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='BIKE_UNAVAILABLE';
 END IF;
 SELECT status INTO zone_status FROM parking_zones WHERE id=bike_zone FOR UPDATE;
 IF zone_status IS NULL THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_NOT_FOUND';
 END IF;
 IF zone_status<>'ACTIVE' THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_CLOSED';
 END IF;
 INSERT INTO ride_orders(user_id,bike_id,start_zone_id) VALUES(actor_id,requested_bike_id,bike_zone);
 SET new_order_id=LAST_INSERT_ID();
 UPDATE bikes SET status='RIDING',current_zone_id=NULL WHERE id=requested_bike_id;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(actor_id,'RIDE_START','ride_orders',new_order_id,JSON_OBJECT('bike_id',requested_bike_id));
 SELECT new_order_id AS id;
END$$
DELIMITER ;

-- Read the current carbon rule once with the same defaults for all callers.
DROP PROCEDURE IF EXISTS sp_get_carbon_rule;
DELIMITER $$
CREATE PROCEDURE sp_get_carbon_rule(OUT p_factor DECIMAL(20,8), OUT p_rate DECIMAL(20,8), OUT p_version VARCHAR(30))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_rule,v_value JSON DEFAULT NULL;
 DECLARE v_raw LONGTEXT;
 DECLARE v_mantissa,v_digits,v_significant LONGTEXT;
 DECLARE v_exponent,v_fraction_digits BIGINT DEFAULT 0;
 DECLARE v_precise DECIMAL(65,30);
 DECLARE v_index TINYINT DEFAULT 0;
 DECLARE EXIT HANDLER FOR SQLSTATE '22003', SQLSTATE '22007'
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_CARBON_RULE';
 SET p_factor=0.21,p_rate=10,p_version='carbon-v1';
 SELECT value INTO v_rule FROM system_settings WHERE name='carbon';
 IF v_rule IS NOT NULL AND JSON_TYPE(v_rule) NOT IN ('NULL','OBJECT') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_CARBON_RULE';
 END IF;
 WHILE v_index<2 DO
  SET v_value=JSON_EXTRACT(v_rule,IF(v_index=0,'$.kg_per_km','$.points_per_km'));
  IF v_value IS NOT NULL AND JSON_TYPE(v_value)<>'NULL' THEN
   SET v_raw=JSON_UNQUOTE(v_value);
   IF JSON_TYPE(v_value) NOT IN ('INTEGER','UNSIGNED INTEGER','DOUBLE','DECIMAL','STRING')
     OR REGEXP_LIKE(v_raw,'[^0-9eE+.-]','c')
     OR NOT REGEXP_LIKE(v_raw,'^[+]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$','c') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_CARBON_RULE';
   END IF;
   SET v_mantissa=SUBSTRING_INDEX(LOWER(v_raw),'e',1);
   SET v_exponent=IF(LOCATE('e',LOWER(v_raw))=0,0,CAST(SUBSTRING_INDEX(LOWER(v_raw),'e',-1) AS SIGNED));
   SET v_fraction_digits=IF(LOCATE('.',v_mantissa)=0,0,CHAR_LENGTH(v_mantissa)-LOCATE('.',v_mantissa));
   SET v_digits=REPLACE(REPLACE(v_mantissa,'+',''),'.','');
   SET v_significant=TRIM(TRAILING '0' FROM v_digits);
   IF v_significant<>'' AND v_fraction_digits-v_exponent-(CHAR_LENGTH(v_digits)-CHAR_LENGTH(v_significant))>8 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_CARBON_RULE';
   END IF;
   SET v_precise=CAST(v_raw AS DECIMAL(65,30));
   IF v_precise>999999999999.99999999 OR v_precise<>ROUND(v_precise,8)
     OR (v_precise=0 AND REGEXP_LIKE(SUBSTRING_INDEX(LOWER(v_raw),'e',1),'[1-9]','c')) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_CARBON_RULE';
   END IF;
   IF v_index=0 THEN SET p_factor=v_precise; ELSE SET p_rate=v_precise; END IF;
  END IF;
  SET v_index=v_index+1;
 END WHILE;
 SET v_value=JSON_EXTRACT(v_rule,'$.rule_version');
 IF v_value IS NOT NULL AND JSON_TYPE(v_value)<>'NULL' THEN
  SET v_raw=JSON_UNQUOTE(v_value);
  IF JSON_TYPE(v_value)<>'STRING' OR CHAR_LENGTH(v_raw)>30 OR (v_raw<>'' AND (TRIM(v_raw)='' OR REGEXP_LIKE(v_raw,'[[:cntrl:]]','c'))) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_CARBON_RULE';
  END IF;
  IF v_raw<>'' THEN SET p_version=v_raw; END IF;
 END IF;
END$$
DELIMITER ;

-- Private helper: callers already hold the order lock and own the transaction.
DROP PROCEDURE IF EXISTS sp_award_carbon;
DELIMITER $$
CREATE PROCEDURE sp_award_carbon(IN p_order_id BIGINT UNSIGNED, IN p_actor_id BIGINT UNSIGNED,
 OUT p_awarded BOOLEAN, OUT p_points INT, OUT p_carbon DECIMAL(12,4), OUT p_reason VARCHAR(20))
SQL SECURITY INVOKER
award: BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_qualification VARCHAR(20);
 DECLARE v_distance INT;
 DECLARE v_factor DECIMAL(20,8) DEFAULT 0.21;
 DECLARE v_rate DECIMAL(20,8) DEFAULT 10;
 DECLARE v_version VARCHAR(30) DEFAULT 'carbon-v1';
 DECLARE v_calculated_points DECIMAL(30,0);
 DECLARE v_calculated_carbon DECIMAL(30,4);
 SELECT status,qualification_status,distance_m INTO v_status,v_qualification,v_distance FROM ride_orders WHERE id=p_order_id FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ORDER_NOT_FOUND'; END IF;
 SET p_awarded=FALSE,p_points=NULL,p_carbon=NULL,p_reason=v_qualification;
 IF v_status<>'PAID' OR v_qualification<>'VALID' THEN LEAVE award; END IF;
 CALL sp_get_carbon_rule(v_factor,v_rate,v_version);
 SET v_calculated_points=FLOOR(v_distance*v_rate/1000),v_calculated_carbon=ROUND(v_distance*v_factor/1000,4);
 IF v_calculated_points>2147483647 OR v_calculated_carbon>99999999.9999 THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='CARBON_AWARD_OUT_OF_RANGE';
 END IF;
 SET p_points=v_calculated_points,p_carbon=v_calculated_carbon,p_reason=NULL;
 IF EXISTS(SELECT 1 FROM carbon_transactions WHERE award_order_id=p_order_id) THEN LEAVE award; END IF;
 INSERT INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,points_per_km,rule_version,reason,actor_id)
 VALUES(p_order_id,'AWARD',CONCAT('auto:award-',p_order_id),v_distance,p_points,p_carbon,v_factor,v_rate,v_version,'有效已支付行程积分发放',p_actor_id);
 SET p_awarded=TRUE;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_pay_ride;
DELIMITER $$
CREATE PROCEDURE sp_pay_ride(IN p_actor_id BIGINT UNSIGNED, IN p_order_id BIGINT UNSIGNED, IN p_key TEXT)
SQL SECURITY INVOKER
payment: BEGIN
 DECLARE v_user_id BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_existing_order BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_payment_id BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_amount INT;
 DECLARE v_status VARCHAR(20);
 DECLARE v_key VARCHAR(100);
 DECLARE v_awarded BOOLEAN;
 DECLARE v_points INT;
 DECLARE v_carbon DECIMAL(12,4);
 DECLARE v_reason VARCHAR(20);
 IF p_key IS NULL OR CHAR_LENGTH(p_key) NOT BETWEEN 8 AND 80 OR REGEXP_LIKE(p_key,'[^a-zA-Z0-9_-]','c') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_PAYMENT_KEY';
 END IF;
 SELECT user_id,status,amount_cents INTO v_user_id,v_status,v_amount FROM ride_orders WHERE id=p_order_id FOR UPDATE;
 IF v_user_id IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ORDER_NOT_FOUND'; END IF;
 IF v_user_id<>p_actor_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PAYMENT_FORBIDDEN'; END IF;
 SET v_key=CONCAT(p_actor_id,':',p_key);
 SELECT order_id INTO v_existing_order FROM payments WHERE idempotency_key=v_key;
 IF v_existing_order IS NOT NULL AND v_existing_order<>p_order_id THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='IDEMPOTENCY_CONFLICT';
 END IF;
 SELECT id INTO v_payment_id FROM payments WHERE order_id=p_order_id;
 IF v_payment_id IS NOT NULL THEN
  SELECT p.*,TRUE AS duplicate FROM payments p WHERE p.id=v_payment_id;
  LEAVE payment;
 END IF;
 IF v_status<>'UNPAID' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='PAYMENT_INVALID_STATE'; END IF;
 INSERT INTO payments(order_id,idempotency_key,amount_cents) VALUES(p_order_id,v_key,v_amount);
 SET v_payment_id=LAST_INSERT_ID();
 UPDATE ride_orders SET status='PAID' WHERE id=p_order_id;
 CALL sp_award_carbon(p_order_id,p_actor_id,v_awarded,v_points,v_carbon,v_reason);
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor_id,'SIMULATED_PAYMENT','ride_orders',p_order_id,JSON_OBJECT('amount_cents',v_amount));
 SELECT v_payment_id AS id,p_order_id AS order_id,v_amount AS amount_cents,FALSE AS duplicate,
        v_awarded AS awarded,v_points AS points,v_carbon AS carbon_kg,v_reason AS reason;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_review_order_qualification;
DELIMITER $$
CREATE PROCEDURE sp_review_order_qualification(IN p_actor_id BIGINT UNSIGNED, IN p_order_id BIGINT UNSIGNED,
 IN p_decision VARCHAR(20), IN p_reason VARCHAR(300))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_awarded BOOLEAN;
 DECLARE v_points INT;
 DECLARE v_carbon DECIMAL(12,4);
 DECLARE v_reason VARCHAR(20);
 SELECT qualification_status INTO v_status FROM ride_orders WHERE id=p_order_id FOR UPDATE;
 IF v_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ORDER_NOT_FOUND'; END IF;
 IF v_status<>'UNDER_REVIEW' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ORDER_NOT_REVIEWABLE'; END IF;
 UPDATE ride_orders SET qualification_status=p_decision,qualification_reason=p_reason,reviewed_by=p_actor_id,reviewed_at=UTC_TIMESTAMP(3) WHERE id=p_order_id;
 IF p_decision='VALID' THEN
  CALL sp_award_carbon(p_order_id,p_actor_id,v_awarded,v_points,v_carbon,v_reason);
 ELSE
  INSERT INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,actor_id)
  SELECT p_order_id,'ADJUSTMENT',CONCAT('auto:exclude-',p_order_id),0,-points_change,-carbon_kg_change,factor_kg_per_km,rule_version,LEFT(CONCAT('订单排除冲销：',p_reason),300),p_actor_id
  FROM carbon_transactions WHERE order_id=p_order_id AND entry_type='AWARD';
 END IF;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor_id,'ORDER_QUALIFICATION','ride_orders',p_order_id,JSON_OBJECT('decision',p_decision,'reason',p_reason));
 SELECT p_order_id AS id,p_decision AS qualification_status;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_adjust_carbon;
DELIMITER $$
CREATE PROCEDURE sp_adjust_carbon(IN p_actor_id BIGINT UNSIGNED, IN p_order_id BIGINT UNSIGNED,
 IN p_points INT, IN p_carbon_input TEXT, IN p_reason VARCHAR(300), IN p_key TEXT, IN p_detail JSON)
SQL SECURITY INVOKER
adjustment: BEGIN
 DECLARE v_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_existing_id,v_user_id,v_existing_order BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_existing_type VARCHAR(20);
 DECLARE v_existing_points INT;
 DECLARE v_existing_carbon DECIMAL(12,4);
 DECLARE v_existing_reason VARCHAR(300);
 DECLARE v_balance_points BIGINT;
 DECLARE v_balance_carbon DECIMAL(20,4);
 DECLARE v_id BIGINT UNSIGNED;
 DECLARE v_factor DECIMAL(20,8);
 DECLARE v_rate DECIMAL(20,8);
 DECLARE v_version VARCHAR(30);
 DECLARE p_carbon DECIMAL(12,4);
 DECLARE v_precise DECIMAL(65,30);
 DECLARE v_mantissa,v_digits,v_significant LONGTEXT;
 DECLARE v_exponent,v_fraction_digits BIGINT DEFAULT 0;
 IF p_key IS NULL OR CHAR_LENGTH(p_key) NOT BETWEEN 8 AND 80 OR REGEXP_LIKE(p_key,'[^a-zA-Z0-9_-]','c') THEN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_ADJUSTMENT';
 END IF;
 BEGIN
  DECLARE EXIT HANDLER FOR SQLSTATE '22003', SQLSTATE '22007'
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_ADJUSTMENT_AMOUNT';
  IF p_carbon_input IS NULL OR CHAR_LENGTH(p_carbon_input)>1024
   OR REGEXP_LIKE(p_carbon_input,'[^0-9eE+.-]','c')
   OR NOT REGEXP_LIKE(p_carbon_input,'^[+-]?([0-9]+([.][0-9]*)?|[.][0-9]+)([eE][+-]?[0-9]+)?$','c') THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_ADJUSTMENT_AMOUNT';
  END IF;
  SET v_mantissa=SUBSTRING_INDEX(LOWER(p_carbon_input),'e',1);
  SET v_exponent=IF(LOCATE('e',LOWER(p_carbon_input))=0,0,CAST(SUBSTRING_INDEX(LOWER(p_carbon_input),'e',-1) AS SIGNED));
  SET v_fraction_digits=IF(LOCATE('.',v_mantissa)=0,0,CHAR_LENGTH(v_mantissa)-LOCATE('.',v_mantissa));
  SET v_digits=REPLACE(REPLACE(REPLACE(v_mantissa,'+',''),'-',''),'.','');
  SET v_significant=TRIM(TRAILING '0' FROM v_digits);
  IF v_significant<>'' AND v_fraction_digits-v_exponent-(CHAR_LENGTH(v_digits)-CHAR_LENGTH(v_significant))>4 THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_ADJUSTMENT_AMOUNT';
  END IF;
  SET v_precise=CAST(p_carbon_input AS DECIMAL(65,30));
  IF ABS(v_precise)>99999999.9999 OR v_precise<>ROUND(v_precise,4) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_ADJUSTMENT_AMOUNT';
  END IF;
  SET p_carbon=v_precise;
 END;
 SELECT status,user_id INTO v_status,v_user_id FROM ride_orders WHERE id=p_order_id FOR UPDATE;
 IF v_status IS NULL OR v_status<>'PAID' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_ADJUSTMENT'; END IF;
 SELECT id,order_id,entry_type,points_change,carbon_kg_change,reason
 INTO v_existing_id,v_existing_order,v_existing_type,v_existing_points,v_existing_carbon,v_existing_reason
 FROM carbon_transactions WHERE idempotency_key=p_key;
 IF v_existing_id IS NOT NULL THEN
  IF v_existing_order<>p_order_id OR v_existing_type<>'ADJUSTMENT' OR v_existing_points<>p_points
   OR v_existing_carbon<>p_carbon OR BINARY v_existing_reason<>BINARY p_reason THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ADJUSTMENT_IDEMPOTENCY_CONFLICT';
  END IF;
  SELECT c.id,c.order_id,c.entry_type,c.award_order_id,c.idempotency_key,c.distance_m,c.points_change,c.carbon_kg_change,
   CAST(c.factor_kg_per_km AS CHAR) AS factor_kg_per_km,CAST(c.points_per_km AS CHAR) AS points_per_km,
   c.rule_version,c.reason,c.actor_id,c.created_at,TRUE AS duplicate FROM carbon_transactions c WHERE c.id=v_existing_id;
  LEAVE adjustment;
 END IF;
 IF p_points=0 AND p_carbon=0 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ADJUSTMENT_ZERO'; END IF;
 IF p_points<0 OR p_carbon<0 THEN
  SELECT COALESCE(SUM(c.points_change),0),COALESCE(SUM(c.carbon_kg_change),0) INTO v_balance_points,v_balance_carbon
  FROM ride_orders r JOIN carbon_transactions c ON c.order_id=r.id WHERE r.user_id=v_user_id;
  IF (p_points<0 AND v_balance_points+p_points<0) OR (p_carbon<0 AND v_balance_carbon+p_carbon<0) THEN
   SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INSUFFICIENT_CARBON_BALANCE';
  END IF;
 END IF;
 CALL sp_get_carbon_rule(v_factor,v_rate,v_version);
 INSERT INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,actor_id)
 VALUES(p_order_id,'ADJUSTMENT',p_key,0,p_points,p_carbon,v_factor,v_version,p_reason,p_actor_id);
 SET v_id=LAST_INSERT_ID();
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail) VALUES(p_actor_id,'CARBON_ADJUST','carbon_transactions',v_id,p_detail);
 SELECT v_id AS id,FALSE AS duplicate;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_review_return_attempt;
DELIMITER $$
CREATE PROCEDURE sp_review_return_attempt(IN p_actor_id BIGINT UNSIGNED, IN p_attempt_id BIGINT UNSIGNED,
 IN p_action VARCHAR(10), IN p_note VARCHAR(300))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_state VARCHAR(20) DEFAULT NULL;
 DECLARE v_result VARCHAR(20);
 SELECT review_status INTO v_state FROM return_attempts WHERE id=p_attempt_id FOR UPDATE;
 IF v_state IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ATTEMPT_NOT_FOUND'; END IF;
 IF v_state<>'PENDING' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ATTEMPT_ALREADY_REVIEWED'; END IF;
 SET v_result=IF(p_action='RESOLVE','RESOLVED','DISMISSED');
 UPDATE return_attempts SET review_status=v_result,reviewer_id=p_actor_id,review_note=p_note,reviewed_at=UTC_TIMESTAMP(3) WHERE id=p_attempt_id;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor_id,CONCAT('RETURN_ATTEMPT_',v_result),'return_attempts',p_attempt_id,JSON_OBJECT('action',p_action,'note',p_note));
 SELECT p_attempt_id AS id,v_result AS review_status;
END$$
DELIMITER ;

-- Prepare and finalize a return in the same application-owned transaction.
-- Route search between these calls is a pure graph calculation in the backend.
DROP PROCEDURE IF EXISTS sp_prepare_ride_return;
DELIMITER $$
CREATE PROCEDURE sp_prepare_ride_return(IN p_actor_id BIGINT UNSIGNED, IN p_order_id BIGINT UNSIGNED,
 IN p_zone_id BIGINT UNSIGNED, IN p_x DOUBLE, IN p_y DOUBLE, IN p_captured DATETIME(3), IN p_source VARCHAR(20))
SQL SECURITY INVOKER
prepare_return: BEGIN
 DECLARE v_user BIGINT UNSIGNED DEFAULT NULL;
 DECLARE v_bike BIGINT UNSIGNED;
 DECLARE v_start_zone BIGINT UNSIGNED;
 DECLARE v_started DATETIME(3);
 DECLARE v_status VARCHAR(20);
 DECLARE v_zone_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_x,v_y,v_radius,v_input_x,v_input_y DECIMAL(10,2);
 DECLARE v_occupied,v_reserved,v_capacity INT;
 DECLARE v_now DATETIME(3) DEFAULT UTC_TIMESTAMP(3);
 DECLARE v_captured DATETIME(3);
 DECLARE v_reason VARCHAR(20) DEFAULT NULL;
 SELECT user_id,bike_id,start_zone_id,started_at,status INTO v_user,v_bike,v_start_zone,v_started,v_status
 FROM ride_orders WHERE id=p_order_id FOR UPDATE;
 IF v_user IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ORDER_NOT_FOUND'; END IF;
 IF v_user<>p_actor_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RETURN_FORBIDDEN'; END IF;
 IF v_status<>'RUNNING' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RETURN_INVALID_STATE'; END IF;
 SELECT status,x,y,radius,capacity INTO v_zone_status,v_x,v_y,v_radius,v_capacity FROM parking_zones WHERE id=p_zone_id FOR UPDATE;
 IF v_zone_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ZONE_NOT_FOUND'; END IF;
 CALL sp_zone_load(p_zone_id,v_occupied,v_reserved);
 SELECT id INTO v_bike FROM bikes WHERE id=v_bike FOR UPDATE;
 SET v_captured=COALESCE(p_captured,v_now),v_input_x=p_x,v_input_y=p_y;
 IF p_x<0 OR p_x>2000 OR p_y<0 OR p_y>2000 THEN SET v_reason='INVALID_LOCATION';
 ELSEIF v_captured<v_started OR v_captured>v_now + INTERVAL 30 SECOND OR v_captured<v_now - INTERVAL 5 MINUTE THEN SET v_reason='LOCATION_STALE';
 ELSEIF v_zone_status<>'ACTIVE' THEN SET v_reason='ZONE_CLOSED';
 ELSEIF SQRT(POW(v_input_x-v_x,2)+POW(v_input_y-v_y,2))>v_radius+0.00000001 THEN SET v_reason='OUTSIDE_FENCE';
 ELSEIF v_occupied+v_reserved>=v_capacity THEN SET v_reason='ZONE_FULL';
 END IF;
 IF v_reason IS NOT NULL THEN
  INSERT INTO return_attempts(order_id,zone_id,x,y,reason,location_captured_at,location_source)
  VALUES(p_order_id,p_zone_id,p_x,p_y,v_reason,v_captured,p_source);
  SELECT v_reason AS rejected;
  LEAVE prepare_return;
 END IF;
 SELECT v_start_zone AS start_zone_id,v_now AS return_time,v_captured AS captured_at;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_finish_ride_return;
DELIMITER $$
CREATE PROCEDURE sp_finish_ride_return(IN p_actor_id BIGINT UNSIGNED, IN p_order_id BIGINT UNSIGNED,
 IN p_zone_id BIGINT UNSIGNED, IN p_x DOUBLE, IN p_y DOUBLE, IN p_captured DATETIME(3), IN p_source VARCHAR(20),
 IN p_mode VARCHAR(20), IN p_distance INT, IN p_now DATETIME(3))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_bike,v_user BIGINT UNSIGNED;
 DECLARE v_order_status VARCHAR(20) DEFAULT NULL;
 DECLARE v_started DATETIME(3);
 DECLARE v_elapsed BIGINT;
 DECLARE v_fee INT;
 DECLARE v_qualification VARCHAR(20) DEFAULT 'VALID';
 DECLARE v_reason VARCHAR(300) DEFAULT NULL;
 SELECT bike_id,user_id,status,started_at INTO v_bike,v_user,v_order_status,v_started FROM ride_orders WHERE id=p_order_id FOR UPDATE;
 IF v_order_status IS NULL THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='ORDER_NOT_FOUND'; END IF;
 IF v_user<>p_actor_id THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RETURN_FORBIDDEN'; END IF;
 IF v_order_status<>'RUNNING' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='RETURN_INVALID_STATE'; END IF;
 SET v_elapsed=TIMESTAMPDIFF(MICROSECOND,v_started,p_now);
 SET v_fee=GREATEST(1,CEIL(v_elapsed/1800000000))*100;
 IF p_distance>=500 AND v_elapsed>0 AND v_elapsed<60000000 THEN
  SET v_qualification='UNDER_REVIEW',v_reason='行程时长与路网估算距离组合异常，需人工复核';
 END IF;
 UPDATE ride_orders SET end_zone_id=p_zone_id,ended_at=p_now,amount_cents=v_fee,distance_m=p_distance,route_mode=p_mode,
 qualification_status=v_qualification,qualification_reason=v_reason,return_x=p_x,return_y=p_y,location_captured_at=p_captured,location_source=p_source,status='UNPAID'
 WHERE id=p_order_id;
 UPDATE bikes SET status=IF(EXISTS(SELECT 1 FROM maintenance_tickets WHERE bike_id=v_bike AND status<>'COMPLETED'),'MAINTENANCE','AVAILABLE'),
 current_zone_id=p_zone_id WHERE id=v_bike;
 INSERT INTO audit_logs(actor_id,action,entity_type,entity_id,detail)
 VALUES(p_actor_id,'RIDE_RETURN','ride_orders',p_order_id,JSON_OBJECT('zone_id',p_zone_id,'x',p_x,'y',p_y));
 SELECT p_order_id AS id,v_fee AS amount_cents,p_distance AS distance_m;
END$$
DELIMITER ;
