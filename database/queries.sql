-- Campus bike teaching queries, MySQL 8.0. Read-only: run after selecting the intended campus database.
-- Q01: identify target database before interpreting results.
SELECT DATABASE() AS selected_database;
-- Q02: inventory and reserved capacity.
SELECT id,name,capacity,available,occupied,reserved,capacity-occupied-reserved free_slots FROM v_zone_inventory ORDER BY id;
-- Q03: currently borrowable bicycles (JOIN).
SELECT b.id,b.code,z.name zone_name FROM bikes b JOIN parking_zones z ON z.id=b.current_zone_id WHERE b.status='AVAILABLE' AND z.status='ACTIVE';
-- Q04: individual history; change variable without altering the query.
SET @student_id = 2;
SELECT id,bike_code,start_zone_name,end_zone_name,status,amount_cents,distance_m FROM v_ride_details WHERE user_id=@student_id ORDER BY started_at DESC;
-- Q05: borrowing demand in last seven days, including quiet zones.
SELECT z.id,z.name,COUNT(r.id) borrow_count FROM parking_zones z LEFT JOIN ride_orders r ON r.start_zone_id=z.id AND r.started_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY GROUP BY z.id,z.name ORDER BY borrow_count DESC;
-- Q06: return demand by zone (completed rides only).
SELECT z.id,z.name,COUNT(r.id) return_count FROM parking_zones z LEFT JOIN ride_orders r ON r.end_zone_id=z.id AND r.ended_at>=UTC_TIMESTAMP()-INTERVAL 7 DAY GROUP BY z.id,z.name;
-- Q07: local hour demand (fixed UTC+8, no named timezone tables needed).
SELECT HOUR(started_at+INTERVAL 8 HOUR) local_hour,COUNT(*) borrow_count FROM ride_orders WHERE started_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY GROUP BY local_hour ORDER BY local_hour;
-- Q08: recurring faults, GROUP BY and HAVING.
SELECT bike_id,fault_type,COUNT(*) occurrences FROM maintenance_tickets WHERE created_at>=UTC_TIMESTAMP()-INTERVAL 30 DAY GROUP BY bike_id,fault_type HAVING COUNT(*)>=2;
-- Q09: available bikes with no active maintenance ticket (NOT EXISTS).
SELECT b.id,b.code FROM bikes b WHERE b.status='AVAILABLE' AND NOT EXISTS(SELECT 1 FROM maintenance_tickets t WHERE t.bike_id=b.id AND t.status<>'COMPLETED');
-- Q10: dispatch workload without JOIN multiplication.
SELECT s.id,s.name,(SELECT COUNT(*) FROM dispatch_tasks t WHERE t.staff_id=s.id AND t.status IN('PENDING','IN_PROGRESS')) dispatch_pending,(SELECT COUNT(*) FROM maintenance_tickets m WHERE m.staff_id=s.id AND m.status<>'COMPLETED') maintenance_pending FROM staff s;
-- Q11: exact task members and both zone roles.
SELECT t.id,t.status,src.name source_name,dst.name target_name,b.code FROM dispatch_tasks t JOIN parking_zones src ON src.id=t.source_zone_id JOIN parking_zones dst ON dst.id=t.target_zone_id JOIN dispatch_bikes db ON db.task_id=t.id JOIN bikes b ON b.id=db.bike_id ORDER BY t.id,b.id;
-- Q12: ranked paid-rider aggregate (window function); all-time teaching query, not UI week/month.
WITH totals AS(SELECT r.user_id,COUNT(*) rides,SUM(r.distance_m) distance_m,COALESCE(SUM(c.points),0) points FROM ride_orders r LEFT JOIN carbon_ledger c ON c.order_id=r.id WHERE r.status='PAID' GROUP BY r.user_id) SELECT DENSE_RANK() OVER(ORDER BY points DESC) points_rank,CONCAT(LEFT(u.name,1),'**') masked_name,t.* FROM totals t JOIN users u ON u.id=t.user_id ORDER BY points_rank,t.user_id;
-- Q13: latest snapshot per zone (ROW_NUMBER).
WITH ranked AS(SELECT s.*,ROW_NUMBER() OVER(PARTITION BY zone_id ORDER BY captured_at DESC,id DESC) rn FROM zone_snapshots s) SELECT zone_id,available,occupied,capacity,captured_at,source FROM ranked WHERE rn=1;
-- Q14: rejection reasons.
SELECT reason,COUNT(*) attempts FROM return_attempts GROUP BY reason;
-- Q15: capacity invariant, expected no rows.
SELECT id,name,capacity,occupied,reserved FROM v_zone_inventory WHERE occupied+reserved>capacity OR available>occupied;
-- Q16: running-order vehicle invariant, expected no rows.
SELECT r.id,r.bike_id,b.status,b.current_zone_id FROM ride_orders r JOIN bikes b ON b.id=r.bike_id WHERE r.status='RUNNING' AND (b.status<>'RIDING' OR b.current_zone_id IS NOT NULL);
-- Q17: duplicate activity invariant, expected no rows.
SELECT 'USER' kind,user_id entity_id,COUNT(*) active_count FROM ride_orders WHERE status='RUNNING' GROUP BY user_id HAVING COUNT(*)>1 UNION ALL SELECT 'BIKE',bike_id,COUNT(*) FROM ride_orders WHERE status='RUNNING' GROUP BY bike_id HAVING COUNT(*)>1;
-- Q18: payment/carbon invariant, expected no rows; completed yet unpaid legitimately have no payment.
SELECT r.id,r.status,p.id payment_id,c.id carbon_id FROM ride_orders r LEFT JOIN payments p ON p.order_id=r.id LEFT JOIN carbon_ledger c ON c.order_id=r.id WHERE (r.status='PAID' AND (p.id IS NULL OR c.id IS NULL)) OR (r.status<>'PAID' AND (p.id IS NOT NULL OR c.id IS NOT NULL)) OR (p.id IS NOT NULL AND p.amount_cents<>r.amount_cents) OR (c.id IS NOT NULL AND (c.distance_m<>r.distance_m OR c.points<>FLOOR(r.distance_m/1000*10) OR c.carbon_kg<>ROUND(r.distance_m/1000*c.factor_kg_per_km,4)));
-- Q19: database object inventory.
SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_TYPE,TABLE_NAME;
SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE();
SELECT ROUTINE_NAME,ROUTINE_TYPE,SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE();
-- Q20: inspect indexed borrowing lookup plan; evaluate on actual data sizes.
EXPLAIN SELECT id,code FROM bikes WHERE current_zone_id=1 AND status='AVAILABLE';
