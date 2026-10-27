-- MySQL stored procedures; transactions are owned by the caller.

-- Entries belong to their own posting period, even when their ride is older.
DROP PROCEDURE IF EXISTS sp_leaderboard;
DELIMITER $$
CREATE PROCEDURE sp_leaderboard(IN p_period VARCHAR(10), IN p_metric VARCHAR(10))
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
 )
 SELECT RANK() OVER (ORDER BY CASE p_metric WHEN 'points' THEN points WHEN 'distance' THEN distance_m ELSE rides END DESC) AS `rank`,
 user_id,name,visible,rides,distance_m,points,carbon_kg FROM totals
 ORDER BY CASE p_metric WHEN 'points' THEN points WHEN 'distance' THEN distance_m ELSE rides END DESC,user_id;
 SELECT v_start AS start_time,v_now AS end_time;
END$$
DELIMITER ;

-- Aggregate events and bounded snapshot intervals in MySQL; return sampled series separately.
DROP PROCEDURE IF EXISTS sp_hotspot_report;
DELIMITER $$
CREATE PROCEDURE sp_hotspot_report(IN p_start DATETIME(3), IN p_end DATETIME(3), IN p_day_type VARCHAR(10),
 IN p_hour_start INT, IN p_hour_end INT, IN p_zone BIGINT UNSIGNED)
SQL SECURITY INVOKER
BEGIN
 SELECT * FROM v_zone_inventory WHERE p_zone IS NULL OR id=p_zone ORDER BY id;
 WITH events AS (
  SELECT start_zone_id AS zone_id,started_at AS event_at,1 AS borrowed,0 AS returned FROM ride_orders WHERE started_at BETWEEN p_start AND p_end
  UNION ALL
  SELECT end_zone_id,ended_at,0,1 FROM ride_orders WHERE ended_at BETWEEN p_start AND p_end
 )
 SELECT e.zone_id,HOUR(e.event_at+INTERVAL 8 HOUR) AS hour,DAYOFWEEK(e.event_at+INTERVAL 8 HOUR)-1 AS weekday,
 SUM(e.borrowed) AS borrow_count,SUM(e.returned) AS return_count
 FROM events e JOIN parking_zones z ON z.id=e.zone_id
 WHERE (p_zone IS NULL OR e.zone_id=p_zone) AND HOUR(e.event_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(e.event_at+INTERVAL 8 HOUR)<p_hour_end
 AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(e.event_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(e.event_at+INTERVAL 8 HOUR)>=5))
 GROUP BY e.zone_id,hour,weekday;
 WITH intervals AS (
  SELECT s.*,LEAD(captured_at) OVER (PARTITION BY zone_id ORDER BY captured_at,id) AS next_at
  FROM zone_snapshots s WHERE s.captured_at BETWEEN p_start-INTERVAL 5 MINUTE AND p_end AND (p_zone IS NULL OR zone_id=p_zone)
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
   LEAST(next_at,p_end,TIMESTAMP(local_day)+INTERVAL p_hour_end HOUR-INTERVAL 8 HOUR)))/60000000 AS minutes
  FROM interval_days WHERE p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(local_day)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(local_day)>=5)
 )
 SELECT zone_id,ROUND(SUM(minutes),2) AS coverage_minutes,
  ROUND(SUM(IF(available<=capacity*0.2,minutes,0)),2) AS shortage_minutes,
  ROUND(SUM(IF(occupied>=capacity,minutes,0)),2) AS full_minutes FROM eligible GROUP BY zone_id;
 WITH filtered AS (
  SELECT id,zone_id,captured_at,available,occupied,capacity FROM zone_snapshots
  WHERE captured_at BETWEEN p_start AND p_end AND (p_zone IS NULL OR zone_id=p_zone)
  AND HOUR(captured_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(captured_at+INTERVAL 8 HOUR)<p_hour_end
  AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)>=5))
 ), numbered AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY zone_id ORDER BY captured_at,id) AS sample_no,COUNT(*) OVER (PARTITION BY zone_id) AS zone_count FROM filtered
 ), buckets AS (
  SELECT *,FLOOR((sample_no-1)/IF(zone_count<=1200,1,CEIL(zone_count/300))) AS bucket FROM numbered
 ), ranked AS (
  SELECT *,ROW_NUMBER() OVER (PARTITION BY zone_id,bucket ORDER BY sample_no) AS first_no,
   ROW_NUMBER() OVER (PARTITION BY zone_id,bucket ORDER BY sample_no DESC) AS last_no,
   ROW_NUMBER() OVER (PARTITION BY zone_id,bucket ORDER BY available,sample_no) AS min_no,
   ROW_NUMBER() OVER (PARTITION BY zone_id,bucket ORDER BY available DESC,sample_no) AS max_no FROM buckets
 )
 SELECT zone_id,captured_at,available,occupied,capacity FROM ranked
 WHERE first_no=1 OR last_no=1 OR min_no=1 OR max_no=1 ORDER BY zone_id,sample_no;
 WITH RECURSIVE days AS (
  SELECT DATE(p_start+INTERVAL 8 HOUR) AS local_day
  UNION ALL SELECT local_day+INTERVAL 1 DAY FROM days WHERE local_day<DATE(p_end+INTERVAL 8 HOUR)
 )
 SELECT COALESCE(SUM(GREATEST(0,TIMESTAMPDIFF(MICROSECOND,
  GREATEST(p_start,TIMESTAMP(local_day)+INTERVAL p_hour_start HOUR-INTERVAL 8 HOUR),
  LEAST(p_end,TIMESTAMP(local_day)+INTERVAL p_hour_end HOUR-INTERVAL 8 HOUR)))),0)/60000000 AS possible_minutes,
  (SELECT COUNT(*) FROM zone_snapshots WHERE captured_at BETWEEN p_start AND p_end AND (p_zone IS NULL OR zone_id=p_zone)
   AND HOUR(captured_at+INTERVAL 8 HOUR)>=p_hour_start AND HOUR(captured_at+INTERVAL 8 HOUR)<p_hour_end
   AND (p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(captured_at+INTERVAL 8 HOUR)>=5))) AS snapshot_count
 FROM days WHERE p_day_type='ALL' OR (p_day_type='WEEKDAY' AND WEEKDAY(local_day)<5) OR (p_day_type='WEEKEND' AND WEEKDAY(local_day)>=5);
END$$
DELIMITER ;

DROP PROCEDURE IF EXISTS sp_dashboard;
DELIMITER $$
CREATE PROCEDURE sp_dashboard(IN p_user BIGINT UNSIGNED, IN p_role VARCHAR(20))
SQL SECURITY INVOKER
BEGIN
 SELECT * FROM v_zone_inventory ORDER BY id;
 SELECT b.*,z.name zone_name FROM bikes b LEFT JOIN parking_zones z ON z.id=b.current_zone_id ORDER BY b.id;
 SELECT * FROM v_ride_details WHERE user_id=p_user ORDER BY id DESC;
 SELECT p.* FROM payments p JOIN ride_orders r ON r.id=p.order_id WHERE r.user_id=p_user ORDER BY p.id DESC;
 IF p_role='STUDENT' THEN
  SELECT s.*,u.email FROM staff s JOIN users u ON u.id=s.user_id WHERE FALSE;
  SELECT t.*,s.name staff_name,a.name source_name,b.name target_name FROM dispatch_tasks t LEFT JOIN staff s ON s.id=t.staff_id JOIN parking_zones a ON a.id=t.source_zone_id JOIN parking_zones b ON b.id=t.target_zone_id WHERE FALSE;
  SELECT * FROM dispatch_bikes WHERE FALSE;
  SELECT t.*,b.code bike_code,s.name staff_name FROM maintenance_tickets t JOIN bikes b ON b.id=t.bike_id LEFT JOIN staff s ON s.id=t.staff_id WHERE t.reporter_id=p_user ORDER BY t.id DESC;
 ELSE
  SELECT s.*,u.email FROM staff s JOIN users u ON u.id=s.user_id ORDER BY s.id;
  SELECT t.*,s.name staff_name,a.name source_name,b.name target_name FROM dispatch_tasks t LEFT JOIN staff s ON s.id=t.staff_id JOIN parking_zones a ON a.id=t.source_zone_id JOIN parking_zones b ON b.id=t.target_zone_id ORDER BY t.id DESC;
  SELECT * FROM dispatch_bikes;
  SELECT t.*,b.code bike_code,s.name staff_name FROM maintenance_tickets t JOIN bikes b ON b.id=t.bike_id LEFT JOIN staff s ON s.id=t.staff_id ORDER BY t.id DESC;
 END IF;
 SELECT points,carbon_kg,distance_m FROM v_user_carbon WHERE user_id=p_user;
 SELECT c.*,c.points_change points,c.carbon_kg_change carbon_kg FROM carbon_transactions c JOIN ride_orders r ON r.id=c.order_id WHERE r.user_id=p_user ORDER BY c.id DESC;
 SELECT a.* FROM return_attempts a JOIN ride_orders r ON r.id=a.order_id WHERE r.user_id=p_user ORDER BY a.id DESC LIMIT 100;
 SELECT (SELECT COUNT(*) FROM bikes WHERE status<>'RETIRED') total_bikes,(SELECT COUNT(*) FROM bikes WHERE status='AVAILABLE') available_bikes,
  (SELECT COUNT(*) FROM ride_orders WHERE status='RUNNING') active_rides,
  (SELECT COUNT(*) FROM ride_orders WHERE started_at>=TIMESTAMP(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR))-INTERVAL 8 HOUR
   AND started_at<TIMESTAMP(DATE(UTC_TIMESTAMP()+INTERVAL 8 HOUR))+INTERVAL 16 HOUR) today_rides,
  (SELECT COALESCE(SUM(carbon_kg_change),0) FROM carbon_transactions) carbon_kg,
  (SELECT COUNT(*) FROM maintenance_tickets WHERE status<>'COMPLETED') open_tickets;
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
CREATE PROCEDURE sp_route_graph()
SQL SECURITY INVOKER
BEGIN
 SELECT * FROM road_nodes ORDER BY id;
 SELECT * FROM road_edges ORDER BY id;
END$$
DELIMITER ;
