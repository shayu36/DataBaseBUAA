-- name: acquire_lock
SELECT GET_LOCK(CONCAT('campus-bike:', DATABASE()),10) AS acquired;
-- name: release_lock
SELECT RELEASE_LOCK(CONCAT('campus-bike:', DATABASE())) AS released;
-- name: acquire_schema_lock
SELECT GET_LOCK(CONCAT('campus-bike:schema:', DATABASE()),10) AS acquired;
-- name: release_schema_lock
SELECT RELEASE_LOCK(CONCAT('campus-bike:schema:', DATABASE())) AS released;
-- name: current_database
SELECT DATABASE() AS name;
-- name: actor_for_update
SELECT role,status FROM users WHERE id=? FOR UPDATE;
-- name: session_user
SELECT id,name,email,phone,role,status,leaderboard_alias,leaderboard_visible FROM users WHERE id=?;
-- name: login_user
SELECT id,name,email,phone,role,status,leaderboard_alias,leaderboard_visible,password_hash FROM users WHERE email=?;
-- name: risk_alerts
SELECT r.*,b.code bike_code,u.name handler_name,t.status ticket_status
FROM risk_alerts r JOIN bikes b ON b.id=r.bike_id LEFT JOIN users u ON u.id=r.handler_id
LEFT JOIN maintenance_tickets t ON t.id=r.maintenance_ticket_id
WHERE (? IS NULL OR r.id<?) ORDER BY r.id DESC LIMIT 101;
-- name: dispatch_suggestions
SELECT s.*,a.name source_name,b.name target_name
FROM dispatch_suggestions s JOIN parking_zones a ON a.id=s.source_zone_id JOIN parking_zones b ON b.id=s.target_zone_id
WHERE (? IS NULL OR s.id<?) ORDER BY s.id DESC LIMIT 101;
-- name: return_attempts_all
SELECT a.*,r.user_id,b.code bike_code,z.name zone_name,u.name reviewer_name
FROM return_attempts a JOIN ride_orders r ON r.id=a.order_id JOIN bikes b ON b.id=r.bike_id
JOIN parking_zones z ON z.id=a.zone_id LEFT JOIN users u ON u.id=a.reviewer_id
WHERE (? IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101;
-- name: return_attempts_own
SELECT a.*,r.user_id,b.code bike_code,z.name zone_name,u.name reviewer_name
FROM return_attempts a JOIN ride_orders r ON r.id=a.order_id JOIN bikes b ON b.id=r.bike_id
JOIN parking_zones z ON z.id=a.zone_id LEFT JOIN users u ON u.id=a.reviewer_id
WHERE r.user_id=? AND (? IS NULL OR a.id<?) ORDER BY a.id DESC LIMIT 101;
-- name: carbon_entries_own
SELECT c.id,c.order_id,c.entry_type,c.award_order_id,c.idempotency_key,c.distance_m,c.points_change,c.carbon_kg_change,
 CAST(c.factor_kg_per_km AS CHAR) AS factor_kg_per_km,CAST(c.points_per_km AS CHAR) AS points_per_km,
 c.rule_version,c.reason,c.actor_id,c.created_at,c.points_change points,c.carbon_kg_change carbon_kg FROM carbon_transactions c
JOIN ride_orders r ON r.id=c.order_id WHERE r.user_id=? AND (? IS NULL OR c.id<?) ORDER BY c.id DESC LIMIT 101;
-- name: ride_history_own
SELECT * FROM v_ride_details WHERE user_id=? AND (?='ALL' OR status=?) AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 101;
-- name: payment_history_own
SELECT p.* FROM payments p JOIN ride_orders r ON r.id=p.order_id WHERE r.user_id=? AND (? IS NULL OR p.id<?) ORDER BY p.id DESC LIMIT 101;
-- name: ride_export_own
SELECT id,bike_code,start_zone_name,end_zone_name,status,distance_m,amount_cents FROM v_ride_details
WHERE user_id=? AND (?='ALL' OR status=?) ORDER BY id DESC;
-- name: dispatch_history
SELECT /*+ SET_VAR(group_concat_max_len=4294967295) */ t.*,u.name staff_name,a.name source_name,b.name target_name,
 (SELECT CAST(CASE WHEN COUNT(*)=0 THEN '[]'
  WHEN OCTET_LENGTH(GROUP_CONCAT(d.bike_id ORDER BY d.bike_id SEPARATOR ','))=SUM(CHAR_LENGTH(d.bike_id))+COUNT(*)-1
  THEN CONCAT('[',GROUP_CONCAT(d.bike_id ORDER BY d.bike_id SEPARATOR ','),']') ELSE 'TRUNCATED' END AS JSON)
  FROM dispatch_bikes d WHERE d.task_id=t.id) AS bike_ids
FROM (SELECT * FROM dispatch_tasks WHERE status IN ('COMPLETED','CANCELLED') AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 101) t
LEFT JOIN staff s ON s.id=t.staff_id LEFT JOIN users u ON u.id=s.user_id JOIN parking_zones a ON a.id=t.source_zone_id JOIN parking_zones b ON b.id=t.target_zone_id ORDER BY t.id DESC;
-- name: ticket_history_all
SELECT t.*,b.code bike_code,u.name staff_name FROM
(SELECT * FROM maintenance_tickets WHERE status='COMPLETED' AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 101) t
JOIN bikes b ON b.id=t.bike_id LEFT JOIN staff s ON s.id=t.staff_id LEFT JOIN users u ON u.id=s.user_id ORDER BY t.id DESC;
-- name: ticket_history_own
SELECT t.*,b.code bike_code,u.name staff_name FROM
(SELECT * FROM maintenance_tickets WHERE status='COMPLETED' AND reporter_id=? AND (? IS NULL OR id<?) ORDER BY id DESC LIMIT 101) t
JOIN bikes b ON b.id=t.bike_id LEFT JOIN staff s ON s.id=t.staff_id LEFT JOIN users u ON u.id=s.user_id ORDER BY t.id DESC;
-- name: admin_roads
SELECT e.*,a.name from_name,b.name to_name FROM road_edges e
JOIN road_nodes a ON a.id=e.from_node_id JOIN road_nodes b ON b.id=e.to_node_id ORDER BY e.id;
-- name: admin_review_orders
SELECT r.*,u.name user_name,b.code bike_code FROM ride_orders r
JOIN users u ON u.id=r.user_id JOIN bikes b ON b.id=r.bike_id
WHERE r.qualification_status='UNDER_REVIEW' AND (? IS NULL OR r.id<?) ORDER BY r.id DESC LIMIT 101;
-- name: admin_users
SELECT id,name,email,phone,role,status,created_at FROM users
WHERE (? IS NULL OR id<?) ORDER BY id DESC LIMIT 101;
-- name: metadata_columns
SELECT TABLE_NAME table_name,COLUMN_NAME name,COLUMN_TYPE type,COLUMN_KEY col_key,IS_NULLABLE nullable
FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() ORDER BY ORDINAL_POSITION;
-- name: metadata_views
SELECT TABLE_NAME name FROM information_schema.VIEWS WHERE TABLE_SCHEMA=DATABASE();
-- name: metadata_triggers
SELECT TRIGGER_NAME name FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE();
-- name: metadata_routines
SELECT ROUTINE_NAME name FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE();
-- name: metadata_tables_count
SELECT COUNT(*) tables FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()
AND TABLE_TYPE='BASE TABLE' AND TABLE_NAME<>'carbon_ledger_legacy';
-- name: check_totals
SELECT DATABASE() db,(SELECT COUNT(*) FROM users) users,(SELECT COUNT(*) FROM bikes) bikes,
(SELECT COUNT(*) FROM ride_orders) rides,(SELECT COUNT(*) FROM payments) payments;
-- name: health
SELECT 1;
-- name: schema_version_compatible
SELECT EXISTS(SELECT 1 FROM system_settings WHERE name='pdf_expansion'
 AND JSON_TYPE(JSON_EXTRACT(value,'$.version')) IN ('INTEGER','STRING')
 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(value,'$.version'))=BINARY '17')
 AND EXISTS(SELECT 1 FROM system_settings WHERE name='procedure_revision'
 AND BINARY JSON_UNQUOTE(JSON_EXTRACT(value,'$.sha256'))=BINARY ?) AS compatible;
-- name: clear_procedure_revision
DELETE FROM system_settings WHERE name='procedure_revision';
-- name: set_procedure_revision
INSERT INTO system_settings(name,value) VALUES('procedure_revision',JSON_OBJECT('sha256',?))
ON DUPLICATE KEY UPDATE value=VALUES(value);
-- name: repeatable_read
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
-- name: consistent_snapshot
START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY;
-- name: drop_temporary_procedure
DROP PROCEDURE IF EXISTS ??;
-- name: call_temporary_procedure
CALL ??(?);
-- name: create_application_database
CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- name: create_restore_database
CREATE DATABASE ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
-- name: create_application_user
CREATE USER IF NOT EXISTS 'qingxing_app'@'localhost' IDENTIFIED BY ?;
-- name: grant_application_user
GRANT SELECT, INSERT, UPDATE, DELETE, EXECUTE ON campus_bike.* TO 'qingxing_app'@'localhost';
-- name: server_version
SELECT VERSION() AS version;
-- name: call_seed_procedure
CALL ??(?,?,?);
