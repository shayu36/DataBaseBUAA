-- MySQL 8.0.16+; times UTC, money integer cents, coordinates metres.
CREATE TABLE IF NOT EXISTS users (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(40) NOT NULL, email VARCHAR(160) NOT NULL UNIQUE, phone VARCHAR(20) NOT NULL UNIQUE,
 password_hash VARCHAR(100) NOT NULL, role ENUM('STUDENT','ADMIN','OPERATOR') NOT NULL DEFAULT 'STUDENT',
 status ENUM('ACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE',
 leaderboard_alias VARCHAR(40) NOT NULL DEFAULT '骑行者', leaderboard_visible BOOLEAN NOT NULL DEFAULT FALSE,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS parking_zones (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL UNIQUE, location VARCHAR(160) NOT NULL,
 x DECIMAL(10,2) NOT NULL, y DECIMAL(10,2) NOT NULL, radius DECIMAL(8,2) NOT NULL DEFAULT 45,
 capacity INT NOT NULL, status ENUM('ACTIVE','CLOSED') NOT NULL DEFAULT 'ACTIVE',
 CHECK(capacity BETWEEN 1 AND 1000), CHECK(radius>0), CHECK(x BETWEEN 0 AND 2000), CHECK(y BETWEEN 0 AND 2000)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS bikes (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, code VARCHAR(30) NOT NULL UNIQUE,
 deployed_at DATE NOT NULL, status ENUM('AVAILABLE','RIDING','MAINTENANCE','DISPATCHING','RETIRED') NOT NULL DEFAULT 'AVAILABLE',
 current_zone_id BIGINT UNSIGNED NULL, last_service_at DATETIME(3) NULL,
 FOREIGN KEY(current_zone_id) REFERENCES parking_zones(id), INDEX idx_bike_zone_status(current_zone_id,status),
 CHECK(status<>'AVAILABLE' OR current_zone_id IS NOT NULL), CHECK(status<>'RIDING' OR current_zone_id IS NULL)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS ride_orders (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, bike_id BIGINT UNSIGNED NOT NULL,
 start_zone_id BIGINT UNSIGNED NOT NULL, end_zone_id BIGINT UNSIGNED NULL,
 started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), ended_at DATETIME(3) NULL,
 amount_cents INT NOT NULL DEFAULT 0, distance_m INT NOT NULL DEFAULT 0,
 distance_source ENUM('ROUTE_ESTIMATE') NOT NULL DEFAULT 'ROUTE_ESTIMATE', route_mode ENUM('shortest','safe','comfortable') NOT NULL DEFAULT 'shortest',
 qualification_status ENUM('VALID','UNDER_REVIEW','EXCLUDED') NOT NULL DEFAULT 'VALID',
 qualification_reason VARCHAR(300) NULL, reviewed_by BIGINT UNSIGNED NULL, reviewed_at DATETIME(3) NULL,
 return_x DECIMAL(10,2) NULL, return_y DECIMAL(10,2) NULL,
 location_captured_at DATETIME(3) NULL, location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL') NULL,
 status ENUM('RUNNING','UNPAID','PAID') NOT NULL DEFAULT 'RUNNING',
 active_user BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status='RUNNING' THEN user_id END) STORED UNIQUE,
 active_bike BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status='RUNNING' THEN bike_id END) STORED UNIQUE,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(bike_id) REFERENCES bikes(id),
 FOREIGN KEY(start_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(end_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(reviewed_by) REFERENCES users(id),
 INDEX idx_ride_start(start_zone_id,started_at), INDEX idx_ride_end(end_zone_id,ended_at), INDEX idx_ride_user(user_id,started_at),
 CHECK(amount_cents>=0), CHECK(distance_m>=0), CONSTRAINT chk_ride_return_pair CHECK((return_x IS NULL)=(return_y IS NULL)),
 CONSTRAINT chk_ride_qualification_review CHECK(
   (qualification_status='UNDER_REVIEW' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
   (qualification_status='VALID' AND ((reviewed_by IS NULL AND reviewed_at IS NULL) OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))) OR
   (qualification_status='EXCLUDED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)),
 CHECK((status='RUNNING' AND ended_at IS NULL AND end_zone_id IS NULL) OR (status<>'RUNNING' AND ended_at IS NOT NULL AND end_zone_id IS NOT NULL AND ended_at>=started_at))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS payments (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL UNIQUE,
 idempotency_key VARCHAR(100) NOT NULL UNIQUE, amount_cents INT NOT NULL,
 paid_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), method ENUM('SIMULATED') NOT NULL DEFAULT 'SIMULATED',
 FOREIGN KEY(order_id) REFERENCES ride_orders(id), CHECK(amount_cents>0)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS staff (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL UNIQUE,
 name VARCHAR(40) NOT NULL, phone VARCHAR(20) NOT NULL, job ENUM('DISPATCH','MAINTENANCE','BOTH') NOT NULL,
 status ENUM('ACTIVE','OFF_DUTY') NOT NULL DEFAULT 'ACTIVE', FOREIGN KEY(user_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS dispatch_tasks (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, staff_id BIGINT UNSIGNED NULL,
 source_zone_id BIGINT UNSIGNED NOT NULL, target_zone_id BIGINT UNSIGNED NOT NULL,
 status ENUM('PENDING','IN_PROGRESS','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PENDING',
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), started_at DATETIME(3) NULL, completed_at DATETIME(3) NULL,
 FOREIGN KEY(staff_id) REFERENCES staff(id), FOREIGN KEY(source_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(target_zone_id) REFERENCES parking_zones(id),
 CHECK(source_zone_id<>target_zone_id), CHECK(status<>'IN_PROGRESS' OR (staff_id IS NOT NULL AND started_at IS NOT NULL)),
 CHECK(status<>'COMPLETED' OR (staff_id IS NOT NULL AND completed_at IS NOT NULL)), INDEX idx_dispatch_status(status,created_at)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS dispatch_bikes (
 task_id BIGINT UNSIGNED NOT NULL, bike_id BIGINT UNSIGNED NOT NULL, PRIMARY KEY(task_id,bike_id),
 FOREIGN KEY(task_id) REFERENCES dispatch_tasks(id), FOREIGN KEY(bike_id) REFERENCES bikes(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS maintenance_tickets (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, bike_id BIGINT UNSIGNED NOT NULL, reporter_id BIGINT UNSIGNED NOT NULL, staff_id BIGINT UNSIGNED NULL,
 fault_type ENUM('BRAKE','TIRE','LOCK','CHAIN','OTHER') NOT NULL, description VARCHAR(500) NOT NULL,
 status ENUM('OPEN','ASSIGNED','COMPLETED') NOT NULL DEFAULT 'OPEN', result VARCHAR(500) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), completed_at DATETIME(3) NULL,
 active_bike BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status<>'COMPLETED' THEN bike_id END) STORED UNIQUE,
 FOREIGN KEY(bike_id) REFERENCES bikes(id), FOREIGN KEY(reporter_id) REFERENCES users(id), FOREIGN KEY(staff_id) REFERENCES staff(id),
 INDEX idx_ticket_bike_time(bike_id,created_at),
 CHECK(status<>'COMPLETED' OR (result IS NOT NULL AND completed_at IS NOT NULL AND staff_id IS NOT NULL)), CHECK(status<>'ASSIGNED' OR staff_id IS NOT NULL)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS zone_snapshots (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, zone_id BIGINT UNSIGNED NOT NULL,
 available INT NOT NULL, occupied INT NOT NULL, capacity INT NOT NULL, captured_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
 source ENUM('LIVE','DEMO') NOT NULL DEFAULT 'LIVE', FOREIGN KEY(zone_id) REFERENCES parking_zones(id), INDEX idx_snapshot_zone_time(zone_id,captured_at),
 CHECK(available>=0 AND occupied>=available AND capacity>0 AND occupied<=capacity)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS return_attempts (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, zone_id BIGINT UNSIGNED NOT NULL,
 x DECIMAL(10,2) NOT NULL, y DECIMAL(10,2) NOT NULL,
 reason ENUM('OUTSIDE_FENCE','ZONE_FULL','ZONE_CLOSED','LOCATION_STALE','INVALID_LOCATION') NOT NULL,
 location_captured_at DATETIME(3) NOT NULL, location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL','HISTORICAL_SIMULATION') NOT NULL,
 review_status ENUM('PENDING','RESOLVED','DISMISSED') NOT NULL DEFAULT 'PENDING',
 reviewer_id BIGINT UNSIGNED NULL, review_note VARCHAR(300) NULL, reviewed_at DATETIME(3) NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES ride_orders(id), FOREIGN KEY(zone_id) REFERENCES parking_zones(id), FOREIGN KEY(reviewer_id) REFERENCES users(id),
 CONSTRAINT chk_return_review_state CHECK((review_status='PENDING' AND reviewer_id IS NULL AND reviewed_at IS NULL) OR (review_status<>'PENDING' AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS road_nodes (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, x DECIMAL(10,2) NOT NULL,y DECIMAL(10,2) NOT NULL,
 zone_id BIGINT UNSIGNED NULL UNIQUE, FOREIGN KEY(zone_id) REFERENCES parking_zones(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS road_edges (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, from_node_id BIGINT UNSIGNED NOT NULL,to_node_id BIGINT UNSIGNED NOT NULL,
 distance_m INT NOT NULL, safety_cost DECIMAL(6,2) NOT NULL DEFAULT 1, comfort_cost DECIMAL(6,2) NOT NULL DEFAULT 1,
 direction ENUM('BOTH','FORWARD','REVERSE') NOT NULL DEFAULT 'BOTH', status ENUM('OPEN','CLOSED','NO_RIDE') NOT NULL DEFAULT 'OPEN',
 slope_percent DECIMAL(5,2) NOT NULL DEFAULT 0, surface ENUM('SMOOTH','AVERAGE','ROUGH') NOT NULL DEFAULT 'SMOOTH',
 shade_level TINYINT UNSIGNED NOT NULL DEFAULT 3, lighting_level TINYINT UNSIGNED NOT NULL DEFAULT 3,
 traffic_mix ENUM('BIKE_ONLY','MIXED','MOTOR_HEAVY') NOT NULL DEFAULT 'MIXED', intersection_risk TINYINT UNSIGNED NOT NULL DEFAULT 1,
 attribute_source ENUM('SIMULATED_COURSE_DATA','MEASURED') NOT NULL DEFAULT 'SIMULATED_COURSE_DATA',
 FOREIGN KEY(from_node_id) REFERENCES road_nodes(id), FOREIGN KEY(to_node_id) REFERENCES road_nodes(id),
 UNIQUE(from_node_id,to_node_id), CHECK(from_node_id<to_node_id), CHECK(distance_m>0 AND safety_cost>=1 AND comfort_cost>=1),
 CONSTRAINT chk_road_attributes CHECK(slope_percent BETWEEN -30 AND 30 AND shade_level BETWEEN 0 AND 5 AND lighting_level BETWEEN 0 AND 5 AND intersection_risk BETWEEN 0 AND 5)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS dispatch_suggestions (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, source_zone_id BIGINT UNSIGNED NOT NULL, target_zone_id BIGINT UNSIGNED NOT NULL,
 quantity INT NOT NULL, source_available INT NOT NULL, target_occupied INT NOT NULL, target_capacity INT NOT NULL, target_reserved INT NOT NULL,
 borrow_count INT NOT NULL, return_count INT NOT NULL, desired_inventory INT NOT NULL,
 window_start DATETIME(3) NOT NULL, window_end DATETIME(3) NOT NULL, reason VARCHAR(500) NOT NULL, algorithm_version VARCHAR(30) NOT NULL,
 status ENUM('OPEN','CONFIRMED','STALE','DISMISSED') NOT NULL DEFAULT 'OPEN', task_id BIGINT UNSIGNED NULL, created_by BIGINT UNSIGNED NOT NULL,
 resolution_note VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), resolved_at DATETIME(3) NULL,
 FOREIGN KEY(source_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(target_zone_id) REFERENCES parking_zones(id),
 FOREIGN KEY(task_id) REFERENCES dispatch_tasks(id), FOREIGN KEY(created_by) REFERENCES users(id), CHECK(quantity>0 AND source_zone_id<>target_zone_id),
 CONSTRAINT chk_suggestion_state CHECK((status='OPEN' AND task_id IS NULL AND resolved_at IS NULL) OR (status='CONFIRMED' AND task_id IS NOT NULL AND resolved_at IS NOT NULL) OR (status IN('STALE','DISMISSED') AND task_id IS NULL AND resolved_at IS NOT NULL))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS risk_alerts (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, bike_id BIGINT UNSIGNED NOT NULL, score INT NOT NULL,
 level ENUM('MEDIUM','HIGH') NOT NULL, reasons JSON NOT NULL, ticket_ids JSON NOT NULL,
 fingerprint CHAR(64) NOT NULL, open_fingerprint CHAR(64) GENERATED ALWAYS AS (CASE WHEN status IN('OPEN','ACKNOWLEDGED') THEN fingerprint END) STORED UNIQUE,
 rule_version VARCHAR(30) NOT NULL, status ENUM('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
 recommendation VARCHAR(300) NOT NULL, handler_id BIGINT UNSIGNED NULL, maintenance_ticket_id BIGINT UNSIGNED NULL,
 resolution_note VARCHAR(500) NULL, triggered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), acknowledged_at DATETIME(3) NULL, resolved_at DATETIME(3) NULL,
 FOREIGN KEY(bike_id) REFERENCES bikes(id), FOREIGN KEY(handler_id) REFERENCES users(id), FOREIGN KEY(maintenance_ticket_id) REFERENCES maintenance_tickets(id), CHECK(score BETWEEN 0 AND 100),
 CONSTRAINT chk_risk_state CHECK((status='OPEN' AND handler_id IS NULL AND acknowledged_at IS NULL AND resolved_at IS NULL) OR (status='ACKNOWLEDGED' AND handler_id IS NOT NULL AND acknowledged_at IS NOT NULL AND resolved_at IS NULL) OR (status IN('RESOLVED','DISMISSED') AND handler_id IS NOT NULL AND resolved_at IS NOT NULL))
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS carbon_transactions (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL,
 entry_type ENUM('AWARD','ADJUSTMENT') NOT NULL, award_order_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN entry_type='AWARD' THEN order_id END) STORED UNIQUE,
 idempotency_key VARCHAR(100) NOT NULL UNIQUE, distance_m INT NOT NULL DEFAULT 0,
 points_change INT NOT NULL, carbon_kg_change DECIMAL(12,4) NOT NULL, factor_kg_per_km DECIMAL(5,3) NOT NULL DEFAULT 0.210,
 rule_version VARCHAR(30) NOT NULL, reason VARCHAR(300) NOT NULL, actor_id BIGINT UNSIGNED NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES ride_orders(id), FOREIGN KEY(actor_id) REFERENCES users(id), CHECK(distance_m>=0)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS audit_logs (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, actor_id BIGINT UNSIGNED NULL, action VARCHAR(60) NOT NULL,
 entity_type VARCHAR(40) NOT NULL, entity_id BIGINT UNSIGNED NULL, detail JSON NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(actor_id) REFERENCES users(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS system_settings (name VARCHAR(50) PRIMARY KEY, value JSON NOT NULL) ENGINE=InnoDB;
CREATE OR REPLACE VIEW v_zone_inventory AS
 SELECT z.*, COALESCE(b.available,0) available,COALESCE(b.occupied,0) occupied, COALESCE(d.reserved,0) reserved
 FROM parking_zones z
 LEFT JOIN (SELECT current_zone_id,COUNT(*) occupied,SUM(status='AVAILABLE') available FROM bikes WHERE current_zone_id IS NOT NULL GROUP BY current_zone_id) b ON b.current_zone_id=z.id
 LEFT JOIN (SELECT t.target_zone_id,COUNT(*) reserved FROM dispatch_tasks t JOIN dispatch_bikes d ON d.task_id=t.id WHERE t.status IN ('PENDING','IN_PROGRESS') GROUP BY t.target_zone_id) d ON d.target_zone_id=z.id;
CREATE OR REPLACE VIEW v_ride_details AS
 SELECT r.*,b.code bike_code,s.name start_zone_name,e.name end_zone_name FROM ride_orders r JOIN bikes b ON b.id=r.bike_id JOIN parking_zones s ON s.id=r.start_zone_id LEFT JOIN parking_zones e ON e.id=r.end_zone_id;
CREATE OR REPLACE VIEW v_user_carbon AS
 SELECT u.id user_id,COALESCE(SUM(c.points_change),0) points,COALESCE(SUM(c.carbon_kg_change),0) carbon_kg,COALESCE(SUM(CASE WHEN c.entry_type='AWARD' THEN c.distance_m ELSE 0 END),0) distance_m FROM users u LEFT JOIN ride_orders r ON r.user_id=u.id LEFT JOIN carbon_transactions c ON c.order_id=r.id GROUP BY u.id;
CREATE OR REPLACE VIEW carbon_ledger AS
 SELECT id,order_id,distance_m,points_change points,carbon_kg_change carbon_kg,factor_kg_per_km,created_at FROM carbon_transactions WHERE entry_type='AWARD';
DROP TRIGGER IF EXISTS trg_payment_guard;
DELIMITER $$
CREATE TRIGGER trg_payment_guard BEFORE INSERT ON payments FOR EACH ROW
BEGIN
 DECLARE fee INT;
 DECLARE order_status VARCHAR(20);
 SELECT amount_cents,status INTO fee,order_status FROM ride_orders WHERE id=NEW.order_id;
 IF order_status<>'UNPAID' OR fee<>NEW.amount_cents THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Payment requires an unpaid order with matching amount'; END IF;
END$$
DELIMITER ;
DROP TRIGGER IF EXISTS trg_carbon_guard;
DELIMITER $$
CREATE TRIGGER trg_carbon_guard BEFORE INSERT ON carbon_transactions FOR EACH ROW
BEGIN
 DECLARE paid_count INT;
 SELECT COUNT(*) INTO paid_count FROM payments WHERE order_id=NEW.order_id;
 IF paid_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Carbon transaction requires successful payment'; END IF;
 IF NEW.entry_type='AWARD' AND (NEW.points_change<0 OR NEW.carbon_kg_change<0) THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Carbon award cannot be negative'; END IF;
END$$
DELIMITER ;
DROP PROCEDURE IF EXISTS sp_capture_zone_snapshots;
DELIMITER $$
CREATE PROCEDURE sp_capture_zone_snapshots()
SQL SECURITY INVOKER
BEGIN
 INSERT INTO zone_snapshots(zone_id,available,occupied,capacity) SELECT id,available,occupied,capacity FROM v_zone_inventory;
END$$
DELIMITER ;
