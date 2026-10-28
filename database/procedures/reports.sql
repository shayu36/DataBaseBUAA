-- MySQL stored procedures; transactions are owned by the caller.

-- Entries belong to their own posting period, even when their ride is older.
DROP PROCEDURE IF EXISTS sp_leaderboard;
DELIMITER $$
CREATE PROCEDURE sp_leaderboard(IN p_period VARCHAR(10), IN p_metric VARCHAR(10), IN p_viewer BIGINT UNSIGNED)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_now DATETIME(3) DEFAULT UTC_TIMESTAMP(3);
 DECLARE v_start DATETIME(3);
 DECLARE v_local DATE;
 SET v_local=DATE(v_now+INTERVAL 8 HOUR);
 SET v_start=TIMESTAMP(DATE_SUB(v_local,INTERVAL IF(p_period='week',WEEKDAY(v_local),DAYOFMONTH(v_local)-1) DAY))-INTERVAL 8 HOUR;
 WITH rides AS (
  SELECT user_id,COUNT(*) rides,SUM(distance_m) distance_m FROM ride_orders
  WHERE status='PAID' AND qualification_status='VALID' AND ended_at>=v_start AND ended_at<=v_now GROUP BY user_id
 ), credits AS (
  SELECT r.user_id,SUM(c.points_change) points,SUM(c.carbon_kg_change) carbon_kg
  FROM carbon_transactions c JOIN ride_orders r ON r.id=c.order_id
  WHERE c.created_at>=v_start AND c.created_at<=v_now AND r.status='PAID' AND r.qualification_status='VALID' GROUP BY r.user_id
 ), participants AS (
  SELECT user_id FROM rides UNION SELECT user_id FROM credits
 ), totals AS (
  SELECT u.id AS user_id,COALESCE(NULLIF(u.leaderboard_alias,''),CONCAT(LEFT(COALESCE(NULLIF(u.name,''),'同学'),1),'**')) AS name,
   u.leaderboard_visible AS visible,COALESCE(r.rides,0) rides,COALESCE(r.distance_m,0) distance_m,
   COALESCE(c.points,0) points,COALESCE(c.carbon_kg,0) carbon_kg
  FROM participants p JOIN users u ON u.id=p.user_id LEFT JOIN rides r ON r.user_id=p.user_id LEFT JOIN credits c ON c.user_id=p.user_id
 ), ranked AS (
  SELECT RANK() OVER (ORDER BY CASE p_metric WHEN 'points' THEN points WHEN 'distance' THEN distance_m ELSE rides END DESC) AS `rank`,
   user_id,name,visible,rides,distance_m,points,carbon_kg FROM totals
 )
 SELECT * FROM (
  SELECT `rank`,user_id,name,visible,rides,distance_m,points,carbon_kg FROM ranked
  UNION ALL
  SELECT NULL,u.id,COALESCE(NULLIF(u.leaderboard_alias,''),CONCAT(LEFT(COALESCE(NULLIF(u.name,''),'同学'),1),'**')),
   u.leaderboard_visible,0,0,0,0 FROM users u
  WHERE u.id=p_viewer AND NOT EXISTS(SELECT 1 FROM ranked WHERE user_id=p_viewer)
 ) ranked_with_viewer
 WHERE (visible=1 AND `rank` IS NOT NULL) OR user_id=p_viewer
 ORDER BY (`rank` IS NULL),`rank`,user_id;
 SELECT v_start AS start_time,v_now AS end_time;
END$$
DELIMITER ;

-- Aggregate events and bounded snapshot intervals in MySQL; return sampled series separately.
DROP PROCEDURE IF EXISTS sp_hotspot_report;
DELIMITER $$
CREATE PROCEDURE sp_hotspot_report(IN p_start DATETIME(3), IN p_end DATETIME(3), IN p_day_type VARCHAR(10),
 IN p_hour_start INT, IN p_hour_end INT, IN p_zone BIGINT UNSIGNED, IN p_details BOOLEAN, IN p_as_of DATETIME(3))
SQL SECURITY INVOKER
report: BEGIN
 DECLARE v_possible_us DECIMAL(40,0) DEFAULT 0;
 DECLARE v_events,v_intervals JSON;
 DECLARE v_snapshot_count BIGINT DEFAULT 0;
 DECLARE v_total_ratio DECIMAL(30,2) DEFAULT 0;
 SELECT * FROM v_zone_inventory WHERE p_zone IS NULL OR id=p_zone ORDER BY id;
 IF NOT p_details THEN
  WITH events AS (
   SELECT start_zone_id AS zone_id,started_at AS event_at,1 AS borrowed,0 AS returned FROM ride_orders
    WHERE started_at>=p_start AND started_at<p_end AND (p_zone IS NULL OR start_zone_id=p_zone)
   UNION ALL
   SELECT end_zone_id,ended_at,0,1 FROM ride_orders
    WHERE ended_at>=p_start AND ended_at<p_end AND (p_zone IS NULL OR end_zone_id=p_zone)
  ), totals AS (
   SELECT zone_id,SUM(borrowed) AS borrow_count,SUM(returned) AS return_count FROM events
   WHERE HOUR(event_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(event_at+INTERVAL 8 HOUR)<p_hour_end
    AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(event_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(event_at+INTERVAL 8 HOUR)>=5))
   GROUP BY zone_id
  )
  SELECT z.id AS zone_id,COALESCE(t.borrow_count,0) AS borrow_count,COALESCE(t.return_count,0) AS return_count
  FROM parking_zones z LEFT JOIN totals t ON t.zone_id=z.id
  WHERE p_zone IS NULL OR z.id=p_zone ORDER BY z.id;
  LEAVE report;
 END IF;
 WITH events AS (
  SELECT start_zone_id AS zone_id,started_at AS event_at,1 AS borrowed,0 AS returned FROM ride_orders WHERE started_at>=p_start AND started_at<p_end
  UNION ALL
  SELECT end_zone_id,ended_at,0,1 FROM ride_orders WHERE ended_at>=p_start AND ended_at<p_end
 ), grouped AS (
  SELECT e.zone_id,HOUR(e.event_at+INTERVAL 8 HOUR) AS hour,
   DAYOFWEEK(e.event_at+INTERVAL 8 HOUR)-1 AS weekday,
   SUM(e.borrowed) AS borrow_count,SUM(e.returned) AS return_count
  FROM events e JOIN parking_zones z ON z.id=e.zone_id
  WHERE (p_zone IS NULL OR e.zone_id=p_zone) AND HOUR(e.event_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(e.event_at+INTERVAL 8 HOUR)<p_hour_end
   AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(e.event_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(e.event_at+INTERVAL 8 HOUR)>=5))
  GROUP BY e.zone_id,hour,weekday
 ), zone_totals AS (
  SELECT zone_id,SUM(borrow_count) AS borrow_count,SUM(return_count) AS return_count FROM grouped GROUP BY zone_id
 ), zone_hours AS (
  SELECT zone_id,hour,SUM(borrow_count) AS borrow_count FROM grouped GROUP BY zone_id,hour
 ), zone_peaks AS (
  SELECT zone_id,hour,ROW_NUMBER() OVER (PARTITION BY zone_id ORDER BY borrow_count DESC,hour) AS position
  FROM zone_hours WHERE borrow_count>0
 )
 SELECT COALESCE(JSON_OBJECTAGG(CONCAT(kind,identifier),JSON_OBJECT('kind',kind,'identifier',identifier,'borrow_count',borrow_count,'return_count',return_count,'peak_hour',peak_hour)),JSON_OBJECT()) INTO v_events
 FROM (
  SELECT 'ZONE' AS kind,t.zone_id AS identifier,t.borrow_count,t.return_count,p.hour AS peak_hour
  FROM zone_totals t LEFT JOIN zone_peaks p ON p.zone_id=t.zone_id AND p.position=1
  UNION ALL SELECT 'HOUR',hour,SUM(borrow_count),SUM(return_count),NULL FROM grouped GROUP BY hour
  UNION ALL SELECT 'WEEKDAY',weekday,SUM(borrow_count),SUM(return_count),NULL FROM grouped GROUP BY weekday
 ) event_rows;
 WITH RECURSIVE days AS (
  SELECT DATE(p_start+INTERVAL 8 HOUR) AS local_day
  UNION ALL SELECT local_day+INTERVAL 1 DAY FROM days WHERE local_day<DATE(p_end+INTERVAL 8 HOUR)
 )
 SELECT COALESCE(SUM(GREATEST(0,TIMESTAMPDIFF(MICROSECOND,
  GREATEST(p_start,TIMESTAMP(local_day)+INTERVAL p_hour_start HOUR-INTERVAL 8 HOUR),
  LEAST(p_end,TIMESTAMP(local_day)+INTERVAL p_hour_end HOUR-INTERVAL 8 HOUR)))),0) INTO v_possible_us
 FROM days WHERE p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(local_day)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(local_day)>=5);
 WITH intervals AS (
  SELECT s.id,s.zone_id,s.captured_at,s.available,s.occupied,s.capacity,
   LEAD(captured_at) OVER (PARTITION BY zone_id ORDER BY captured_at,id) AS next_at
  FROM zone_snapshots s WHERE s.captured_at BETWEEN p_start-INTERVAL 5 MINUTE AND LEAST(p_end+INTERVAL 5 MINUTE,p_as_of)
   AND (p_zone IS NULL OR zone_id=p_zone)
 ), sample_counts AS (
  SELECT zone_id,SUM(captured_at>=p_start AND captured_at<p_end
   AND HOUR(captured_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(captured_at+INTERVAL 8 HOUR)<p_hour_end
   AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)>=5))) AS sample_count
  FROM intervals GROUP BY zone_id
 ), interval_days AS (
  SELECT zone_id,available,occupied,capacity,captured_at,next_at,DATE(captured_at+INTERVAL 8 HOUR) AS local_day
  FROM intervals WHERE next_at>captured_at AND next_at<=captured_at+INTERVAL 5 MINUTE
  UNION ALL
  SELECT zone_id,available,occupied,capacity,captured_at,next_at,DATE(next_at+INTERVAL 8 HOUR) AS local_day
  FROM intervals WHERE next_at>captured_at AND next_at<=captured_at+INTERVAL 5 MINUTE
   AND DATE(captured_at+INTERVAL 8 HOUR)<>DATE(next_at+INTERVAL 8 HOUR)
 ), eligible AS (
  SELECT zone_id,available,occupied,capacity,
  GREATEST(0,TIMESTAMPDIFF(MICROSECOND,
   GREATEST(captured_at,p_start,TIMESTAMP(local_day)+INTERVAL p_hour_start HOUR-INTERVAL 8 HOUR),
   LEAST(next_at,p_end,TIMESTAMP(local_day)+INTERVAL p_hour_end HOUR-INTERVAL 8 HOUR))) AS duration_us
  FROM interval_days WHERE p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(local_day)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(local_day)>=5)
 ), coverage AS (
  SELECT zone_id,SUM(duration_us) AS coverage_us,
   SUM(IF(available<=capacity*0.2,duration_us,0)) AS shortage_us,
   SUM(IF(occupied>=capacity,duration_us,0)) AS full_us FROM eligible GROUP BY zone_id
 )
 SELECT COALESCE(JSON_OBJECTAGG(counts.zone_id,JSON_OBJECT(
   'zone_id',counts.zone_id,'coverage_minutes',ROUND(CAST(COALESCE(coverage.coverage_us,0) AS DECIMAL(40,16))/60000000,2),
   'shortage_minutes',ROUND(CAST(COALESCE(coverage.shortage_us,0) AS DECIMAL(40,16))/60000000,2),
   'full_minutes',ROUND(CAST(COALESCE(coverage.full_us,0) AS DECIMAL(40,16))/60000000,2),
   'coverage_ratio',COALESCE(ROUND(CAST(coverage.coverage_us AS DECIMAL(40,16))/NULLIF(v_possible_us,0),2),0))),JSON_OBJECT()),
  COALESCE(SUM(counts.sample_count),0),
  COALESCE(ROUND(CAST(SUM(COALESCE(coverage.coverage_us,0)) AS DECIMAL(40,16))/
   NULLIF(v_possible_us*(SELECT COUNT(*) FROM parking_zones WHERE p_zone IS NULL OR id=p_zone),0),2),0)
 INTO v_intervals,v_snapshot_count,v_total_ratio
 FROM sample_counts counts LEFT JOIN coverage ON coverage.zone_id=counts.zone_id;
 WITH event_zones AS (
  SELECT DISTINCT identifier,borrow_count,return_count,peak_hour FROM JSON_TABLE(v_events,'$.*' COLUMNS(
   kind VARCHAR(10) PATH '$.kind',identifier BIGINT UNSIGNED PATH '$.identifier',borrow_count BIGINT PATH '$.borrow_count',
   return_count BIGINT PATH '$.return_count',peak_hour INT PATH '$.peak_hour')) events WHERE kind='ZONE'
 ), interval_zones AS (
  SELECT DISTINCT zone_id,coverage_minutes,shortage_minutes,full_minutes,coverage_ratio FROM JSON_TABLE(v_intervals,'$.*' COLUMNS(
   zone_id BIGINT UNSIGNED PATH '$.zone_id',coverage_minutes DECIMAL(30,2) PATH '$.coverage_minutes',
   shortage_minutes DECIMAL(30,2) PATH '$.shortage_minutes',full_minutes DECIMAL(30,2) PATH '$.full_minutes',
   coverage_ratio DECIMAL(30,2) PATH '$.coverage_ratio')) samples
 )
 SELECT z.id AS zone_id,z.name,z.available,z.occupied,z.capacity,z.reserved,
  COALESCE(e.borrow_count,0) AS borrow_count,COALESCE(e.return_count,0) AS return_count,
  COALESCE(e.return_count,0)-COALESCE(e.borrow_count,0) AS net_flow,e.peak_hour,
  COALESCE(i.shortage_minutes,0) AS shortage_minutes,COALESCE(i.full_minutes,0) AS full_minutes,
  COALESCE(i.coverage_minutes,0) AS coverage_minutes,COALESCE(i.coverage_ratio,0) AS coverage_ratio
 FROM v_zone_inventory z LEFT JOIN event_zones e ON e.identifier=z.id LEFT JOIN interval_zones i ON i.zone_id=z.id
 WHERE p_zone IS NULL OR z.id=p_zone ORDER BY z.id;
 WITH RECURSIVE hours AS (SELECT 0 AS n UNION ALL SELECT n+1 FROM hours WHERE n<23)
 SELECT n AS hour,COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(v_events,CONCAT('$."HOUR',n,'".borrow_count'))) AS SIGNED),0) AS borrow_count,
  COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(v_events,CONCAT('$."HOUR',n,'".return_count'))) AS SIGNED),0) AS return_count FROM hours ORDER BY n;
 WITH RECURSIVE weekdays AS (SELECT 0 AS n UNION ALL SELECT n+1 FROM weekdays WHERE n<6)
 SELECT n AS weekday,COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(v_events,CONCAT('$."WEEKDAY',n,'".borrow_count'))) AS SIGNED),0) AS borrow_count,
  COALESCE(CAST(JSON_UNQUOTE(JSON_EXTRACT(v_events,CONCAT('$."WEEKDAY',n,'".return_count'))) AS SIGNED),0) AS return_count FROM weekdays ORDER BY n;
 SELECT v_snapshot_count AS snapshot_count,v_total_ratio AS coverage_ratio;
 WITH filtered AS (
  SELECT id,zone_id,captured_at,available,COUNT(*) OVER (PARTITION BY zone_id) AS zone_count,
   LAG(captured_at) OVER (PARTITION BY zone_id ORDER BY captured_at,id) AS previous_at FROM zone_snapshots
  WHERE captured_at>=p_start AND captured_at<p_end AND (p_zone IS NULL OR zone_id=p_zone)
  AND HOUR(captured_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(captured_at+INTERVAL 8 HOUR)<p_hour_end
  AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)>=5))
 ), segmented AS (
  SELECT *,SUM(IF(previous_at IS NULL OR captured_at>previous_at+INTERVAL 5 MINUTE,1,0))
   OVER (PARTITION BY zone_id ORDER BY captured_at,id ROWS UNBOUNDED PRECEDING) AS segment_id
  FROM filtered
 ), buckets AS (
  SELECT *,IF(zone_count<=1200,id,LEAST(299,FLOOR(300*TIMESTAMPDIFF(MICROSECOND,p_start,captured_at)/
   GREATEST(1,TIMESTAMPDIFF(MICROSECOND,p_start,p_end))))) AS bucket,
   CONCAT(DATE_FORMAT(captured_at,'%Y%m%d%H%i%s%f'),LPAD(id,20,'0')) AS time_key
  FROM segmented
 ), bucket_extremes AS (
  SELECT zone_id,bucket,
   CAST(RIGHT(MIN(time_key),20) AS UNSIGNED) AS first_id,
   CAST(RIGHT(MAX(time_key),20) AS UNSIGNED) AS last_id,
   CAST(RIGHT(MIN(CONCAT(LPAD(available,10,'0'),time_key)),20) AS UNSIGNED) AS min_id,
   CAST(RIGHT(MAX(CONCAT(LPAD(available,10,'0'),time_key)),20) AS UNSIGNED) AS max_id
  FROM buckets GROUP BY zone_id,bucket
 ), selected AS (
  SELECT first_id AS id FROM bucket_extremes UNION SELECT last_id FROM bucket_extremes
  UNION SELECT min_id FROM bucket_extremes UNION SELECT max_id FROM bucket_extremes
 )
 SELECT s.zone_id,s.captured_at,s.available,s.occupied,s.capacity,segment.segment_id FROM selected chosen
 JOIN segmented segment ON segment.id=chosen.id JOIN zone_snapshots s ON s.id=chosen.id
 ORDER BY s.zone_id,s.captured_at,s.id;

END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_dashboard;
DELIMITER $$
CREATE PROCEDURE sp_dashboard(IN p_user BIGINT UNSIGNED, IN p_role VARCHAR(20))
SQL SECURITY INVOKER
BEGIN
 DECLARE v_now DATETIME(3) DEFAULT UTC_TIMESTAMP(3);
 DECLARE v_factor DECIMAL(20,8);
 DECLARE v_rate DECIMAL(20,8);
 DECLARE v_version VARCHAR(30);
 SELECT * FROM v_zone_inventory ORDER BY id;
 SELECT b.*,z.name zone_name FROM bikes b LEFT JOIN parking_zones z ON z.id=b.current_zone_id ORDER BY b.id;
 SELECT * FROM v_ride_details WHERE user_id=p_user ORDER BY id DESC LIMIT 101;
 SELECT p.* FROM payments p JOIN ride_orders r ON r.id=p.order_id WHERE r.user_id=p_user ORDER BY p.id DESC LIMIT 101;
 IF p_role='STUDENT' THEN
  SELECT s.*,u.name,u.phone,u.email FROM staff s JOIN users u ON u.id=s.user_id WHERE FALSE;
  SELECT t.*,u.name staff_name,a.name source_name,b.name target_name,JSON_ARRAY() AS bike_ids FROM dispatch_tasks t LEFT JOIN staff s ON s.id=t.staff_id LEFT JOIN users u ON u.id=s.user_id JOIN parking_zones a ON a.id=t.source_zone_id JOIN parking_zones b ON b.id=t.target_zone_id WHERE FALSE;
 ELSE
  SELECT s.*,u.name,u.phone,u.email FROM staff s JOIN users u ON u.id=s.user_id ORDER BY s.id;
  WITH selected AS (
   SELECT id FROM dispatch_tasks WHERE status IN ('PENDING','IN_PROGRESS')
   UNION ALL SELECT id FROM (SELECT id FROM dispatch_tasks WHERE status IN ('COMPLETED','CANCELLED') ORDER BY id DESC LIMIT 101) recent
  )
  SELECT /*+ SET_VAR(group_concat_max_len=4294967295) */ t.*,u.name staff_name,a.name source_name,b.name target_name,
   (SELECT CAST(CASE WHEN COUNT(*)=0 THEN '[]'
    WHEN OCTET_LENGTH(GROUP_CONCAT(d.bike_id ORDER BY d.bike_id SEPARATOR ','))=SUM(CHAR_LENGTH(d.bike_id))+COUNT(*)-1
    THEN CONCAT('[',GROUP_CONCAT(d.bike_id ORDER BY d.bike_id SEPARATOR ','),']') ELSE 'TRUNCATED' END AS JSON)
    FROM dispatch_bikes d WHERE d.task_id=t.id) AS bike_ids
  FROM selected chosen JOIN dispatch_tasks t ON t.id=chosen.id LEFT JOIN staff s ON s.id=t.staff_id LEFT JOIN users u ON u.id=s.user_id
  JOIN parking_zones a ON a.id=t.source_zone_id JOIN parking_zones b ON b.id=t.target_zone_id
  ORDER BY (t.status IN ('COMPLETED','CANCELLED')),t.id DESC;
 END IF;
 WITH selected AS (
  SELECT id FROM maintenance_tickets WHERE status<>'COMPLETED' AND (p_role<>'STUDENT' OR reporter_id=p_user)
  UNION ALL SELECT id FROM (SELECT id FROM maintenance_tickets WHERE status='COMPLETED' AND (p_role<>'STUDENT' OR reporter_id=p_user) ORDER BY id DESC LIMIT 101) recent
 )
 SELECT t.*,b.code bike_code,u.name staff_name FROM selected chosen JOIN maintenance_tickets t ON t.id=chosen.id
 JOIN bikes b ON b.id=t.bike_id LEFT JOIN staff s ON s.id=t.staff_id LEFT JOIN users u ON u.id=s.user_id ORDER BY (t.status='COMPLETED'),t.id DESC;
 SELECT COALESCE(SUM(c.points_change),0) AS points,COALESCE(SUM(c.carbon_kg_change),0) AS carbon_kg,
  COALESCE(SUM(CASE WHEN c.entry_type='AWARD' AND r.status='PAID' AND r.qualification_status='VALID' THEN c.distance_m ELSE 0 END),0) AS distance_m,
  COUNT(CASE WHEN c.entry_type='AWARD' AND r.status='PAID' AND r.qualification_status='VALID' THEN c.id END) AS ride_count
 FROM ride_orders r JOIN carbon_transactions c ON c.order_id=r.id WHERE r.user_id=p_user;
 SELECT c.id,c.order_id,c.entry_type,c.award_order_id,c.idempotency_key,c.distance_m,c.points_change,c.carbon_kg_change,
  CAST(c.factor_kg_per_km AS CHAR) AS factor_kg_per_km,CAST(c.points_per_km AS CHAR) AS points_per_km,
  c.rule_version,c.reason,c.actor_id,c.created_at,c.points_change points,c.carbon_kg_change carbon_kg
 FROM carbon_transactions c JOIN ride_orders r ON r.id=c.order_id WHERE r.user_id=p_user ORDER BY c.id DESC LIMIT 101;
 SELECT a.* FROM return_attempts a JOIN ride_orders r ON r.id=a.order_id WHERE r.user_id=p_user ORDER BY a.id DESC LIMIT 101;
 SELECT (SELECT COUNT(*) FROM bikes WHERE status<>'RETIRED') total_bikes,(SELECT COUNT(*) FROM bikes WHERE status='AVAILABLE') available_bikes,
  (SELECT COUNT(*) FROM ride_orders WHERE status='RUNNING') active_rides,
  (SELECT COUNT(*) FROM ride_orders WHERE started_at>=TIMESTAMP(DATE(v_now+INTERVAL 8 HOUR))-INTERVAL 8 HOUR
   AND started_at<=v_now) today_rides,
  (SELECT COALESCE(SUM(carbon_kg_change),0) FROM carbon_transactions) carbon_kg,
  (SELECT COUNT(*) FROM maintenance_tickets WHERE status<>'COMPLETED') open_tickets;
 SELECT * FROM v_ride_details WHERE user_id=p_user AND status IN ('RUNNING','UNPAID') ORDER BY id DESC;
 CALL sp_get_carbon_rule(v_factor,v_rate,v_version);
 SELECT TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(v_factor AS CHAR))) AS kg_per_km,
  TRIM(TRAILING '.' FROM TRIM(TRAILING '0' FROM CAST(v_rate AS CHAR))) AS points_per_km,v_version AS rule_version;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_schema_counts;
DELIMITER $$
CREATE PROCEDURE sp_schema_counts()
SQL SECURITY INVOKER
BEGIN
 SELECT 'users' AS table_name,COUNT(*) AS row_count FROM users
 UNION ALL SELECT 'bikes',COUNT(*) FROM bikes
 UNION ALL SELECT 'parking_zones',COUNT(*) FROM parking_zones
 UNION ALL SELECT 'ride_orders',COUNT(*) FROM ride_orders
 UNION ALL SELECT 'payments',COUNT(*) FROM payments
 UNION ALL SELECT 'staff',COUNT(*) FROM staff
 UNION ALL SELECT 'dispatch_tasks',COUNT(*) FROM dispatch_tasks
 UNION ALL SELECT 'maintenance_tickets',COUNT(*) FROM maintenance_tickets
 UNION ALL SELECT 'dispatch_bikes',COUNT(*) FROM dispatch_bikes
 UNION ALL SELECT 'zone_snapshots',COUNT(*) FROM zone_snapshots
 UNION ALL SELECT 'return_attempts',COUNT(*) FROM return_attempts
 UNION ALL SELECT 'road_nodes',COUNT(*) FROM road_nodes
 UNION ALL SELECT 'road_edges',COUNT(*) FROM road_edges
 UNION ALL SELECT 'carbon_transactions',COUNT(*) FROM carbon_transactions
 UNION ALL SELECT 'dispatch_suggestions',COUNT(*) FROM dispatch_suggestions
 UNION ALL SELECT 'risk_alerts',COUNT(*) FROM risk_alerts
 UNION ALL SELECT 'audit_logs',COUNT(*) FROM audit_logs
 UNION ALL SELECT 'system_settings',COUNT(*) FROM system_settings;
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_route_graph;
DELIMITER $$
CREATE PROCEDURE sp_route_graph(IN p_campus JSON)
SQL SECURITY INVOKER
BEGIN
 DECLARE v_areas GEOMETRY DEFAULT NULL;
 CALL sp_campus_restrictions(p_campus,v_areas);
 SELECT * FROM road_nodes ORDER BY id;
 SELECT e.id,e.from_node_id,e.to_node_id,e.distance_m,e.safety_cost,e.comfort_cost,e.direction,
  CASE WHEN v_areas IS NOT NULL AND e.status='OPEN' AND ST_Intersects(
   IF(a.x=b.x AND a.y=b.y,POINT(a.x,a.y),LINESTRING(POINT(a.x,a.y),POINT(b.x,b.y))),v_areas)
  THEN 'NO_RIDE' ELSE e.status END AS status,
  e.slope_percent,e.surface,e.shade_level,e.lighting_level,e.traffic_mix,e.intersection_risk,e.attribute_source,
  e.status AS stored_status
 FROM road_edges e JOIN road_nodes a ON a.id=e.from_node_id JOIN road_nodes b ON b.id=e.to_node_id ORDER BY e.id;
END$$
DELIMITER ;
