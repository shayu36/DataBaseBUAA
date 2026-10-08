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
-- Q12: privacy-aware paid-rider aggregate (window function); all-time teaching query, not UI week/month.
WITH ride_totals AS(SELECT user_id,COUNT(*) rides,SUM(distance_m) distance_m FROM ride_orders WHERE status='PAID' AND qualification_status='VALID' GROUP BY user_id), carbon_totals AS(SELECT r.user_id,SUM(c.points_change) points FROM carbon_transactions c JOIN ride_orders r ON r.id=c.order_id GROUP BY r.user_id), totals AS(SELECT u.id user_id,COALESCE(rt.rides,0) rides,COALESCE(rt.distance_m,0) distance_m,COALESCE(ct.points,0) points FROM users u LEFT JOIN ride_totals rt ON rt.user_id=u.id LEFT JOIN carbon_totals ct ON ct.user_id=u.id WHERE u.leaderboard_visible=1) SELECT RANK() OVER(ORDER BY points DESC) points_rank,u.leaderboard_alias,t.* FROM totals t JOIN users u ON u.id=t.user_id ORDER BY points_rank,t.user_id;
-- Q13: latest snapshot per zone (ROW_NUMBER).
WITH ranked AS(SELECT s.*,ROW_NUMBER() OVER(PARTITION BY zone_id ORDER BY captured_at DESC,id DESC) rn FROM zone_snapshots s) SELECT zone_id,available,occupied,capacity,captured_at,source FROM ranked WHERE rn=1;
-- Q14: rejection reasons and review state.
SELECT reason,review_status,COUNT(*) attempts FROM return_attempts GROUP BY reason,review_status;
-- Q15: capacity invariant, expected no rows.
SELECT id,name,capacity,occupied,reserved FROM v_zone_inventory WHERE occupied+reserved>capacity OR available>occupied;
-- Q16: running-order vehicle invariant, expected no rows.
SELECT r.id,r.bike_id,b.status,b.current_zone_id FROM ride_orders r JOIN bikes b ON b.id=r.bike_id WHERE r.status='RUNNING' AND (b.status<>'RIDING' OR b.current_zone_id IS NOT NULL);
-- Q17: duplicate activity invariant, expected no rows.
SELECT 'USER' kind,user_id entity_id,COUNT(*) active_count FROM ride_orders WHERE status='RUNNING' GROUP BY user_id HAVING COUNT(*)>1 UNION ALL SELECT 'BIKE',bike_id,COUNT(*) FROM ride_orders WHERE status='RUNNING' GROUP BY bike_id HAVING COUNT(*)>1;
-- Q18: payment/qualified-carbon invariant, expected no rows; reviewed or excluded paid rides may have no award.
SELECT r.id,r.status,r.qualification_status,p.id payment_id,c.id award_id FROM ride_orders r LEFT JOIN payments p ON p.order_id=r.id LEFT JOIN carbon_transactions c ON c.order_id=r.id AND c.entry_type='AWARD' WHERE (r.status='PAID')<>(p.id IS NOT NULL) OR (r.status='PAID' AND r.qualification_status='VALID')<>(c.id IS NOT NULL) OR (p.id IS NOT NULL AND p.amount_cents<>r.amount_cents) OR (c.id IS NOT NULL AND (c.distance_m<>r.distance_m OR c.points_change<>FLOOR(r.distance_m/1000*10) OR c.carbon_kg_change<>ROUND(r.distance_m/1000*c.factor_kg_per_km,4)));
-- Q19: database object inventory.
SELECT TABLE_NAME,TABLE_TYPE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_TYPE,TABLE_NAME;
SELECT TRIGGER_NAME,ACTION_TIMING,EVENT_MANIPULATION FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE();
SELECT ROUTINE_NAME,ROUTINE_TYPE,SECURITY_TYPE FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA=DATABASE();
-- Q20: inspect indexed borrowing lookup plan; evaluate on actual data sizes.
EXPLAIN SELECT id,code FROM bikes WHERE current_zone_id=1 AND status='AVAILABLE';

-- Q21: persisted dispatch suggestion lineage and generation basis.
SELECT s.id,src.name source_name,dst.name target_name,s.quantity,s.source_available,s.desired_inventory,s.borrow_count,s.return_count,s.algorithm_version,s.status,s.task_id FROM dispatch_suggestions s JOIN parking_zones src ON src.id=s.source_zone_id JOIN parking_zones dst ON dst.id=s.target_zone_id ORDER BY s.id DESC;
-- Q22: risk alert rule reasons, handler, and linked ticket.
SELECT r.id,b.code,r.score,r.level,r.reasons,r.rule_version,r.status,r.maintenance_ticket_id,u.name handler_name FROM risk_alerts r JOIN bikes b ON b.id=r.bike_id LEFT JOIN users u ON u.id=r.handler_id ORDER BY r.id DESC;
-- Q23: direction and simulated road attributes used by route recommendations.
SELECT e.id,a.name from_node,b.name to_node,e.direction,e.status,e.slope_percent,e.surface,e.shade_level,e.lighting_level,e.traffic_mix,e.intersection_risk,e.attribute_source FROM road_edges e JOIN road_nodes a ON a.id=e.from_node_id JOIN road_nodes b ON b.id=e.to_node_id ORDER BY e.id;
-- Q24: return evidence and administrative review history.
SELECT a.id,a.order_id,a.x,a.y,a.reason,a.location_captured_at,a.location_source,a.review_status,a.review_note,a.reviewed_at FROM return_attempts a ORDER BY a.id DESC;
-- Q25: append-only carbon transactions and net value by order.
SELECT order_id,SUM(points_change) net_points,SUM(carbon_kg_change) net_carbon,COUNT(*) entries,GROUP_CONCAT(CONCAT(entry_type,':',rule_version) ORDER BY id) lineage FROM carbon_transactions GROUP BY order_id ORDER BY order_id;
-- Q26: filtered Beijing-time hotspot sample: workdays 07:00–10:00 over the last 7 days.
SELECT z.name,COUNT(CASE WHEN r.start_zone_id=z.id THEN 1 END) borrow_count,COUNT(CASE WHEN r.end_zone_id=z.id THEN 1 END) return_count FROM parking_zones z LEFT JOIN ride_orders r ON (r.start_zone_id=z.id OR r.end_zone_id=z.id) AND COALESCE(r.ended_at,r.started_at)>=UTC_TIMESTAMP()-INTERVAL 7 DAY AND WEEKDAY(COALESCE(r.ended_at,r.started_at)+INTERVAL 8 HOUR)<5 AND HOUR(COALESCE(r.ended_at,r.started_at)+INTERVAL 8 HOUR) BETWEEN 7 AND 9 GROUP BY z.id,z.name;
-- Q27: current road, review, suggestion, risk, and carbon object counts.
SELECT (SELECT COUNT(*) FROM road_edges) roads,(SELECT COUNT(*) FROM return_attempts WHERE review_status='PENDING') pending_returns,(SELECT COUNT(*) FROM dispatch_suggestions WHERE status='OPEN') open_suggestions,(SELECT COUNT(*) FROM risk_alerts WHERE status IN('OPEN','ACKNOWLEDGED')) open_risks,(SELECT COUNT(*) FROM carbon_transactions) carbon_entries;
