-- MySQL 8.0.16+; times UTC, money integer cents, coordinates metres.
CREATE TABLE IF NOT EXISTS users (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
 name VARCHAR(40) NOT NULL, email VARCHAR(160) NOT NULL UNIQUE, phone VARCHAR(20) NOT NULL UNIQUE,
 password_hash VARCHAR(100) NOT NULL, role ENUM('STUDENT','ADMIN','OPERATOR') NOT NULL DEFAULT 'STUDENT',
 status ENUM('ACTIVE','SUSPENDED') NOT NULL DEFAULT 'ACTIVE', created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
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
 status ENUM('RUNNING','UNPAID','PAID') NOT NULL DEFAULT 'RUNNING',
 active_user BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status='RUNNING' THEN user_id END) STORED UNIQUE,
 active_bike BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN status='RUNNING' THEN bike_id END) STORED UNIQUE,
 FOREIGN KEY(user_id) REFERENCES users(id), FOREIGN KEY(bike_id) REFERENCES bikes(id),
 FOREIGN KEY(start_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(end_zone_id) REFERENCES parking_zones(id),
 INDEX idx_ride_start(start_zone_id,started_at), INDEX idx_ride_end(end_zone_id,ended_at), INDEX idx_ride_user(user_id,started_at),
 CHECK(amount_cents>=0), CHECK(distance_m>=0),
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
 x DECIMAL(10,2) NOT NULL, y DECIMAL(10,2) NOT NULL, reason ENUM('OUTSIDE_FENCE','ZONE_FULL','ZONE_CLOSED') NOT NULL,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES ride_orders(id), FOREIGN KEY(zone_id) REFERENCES parking_zones(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS road_nodes (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, name VARCHAR(60) NOT NULL, x DECIMAL(10,2) NOT NULL,y DECIMAL(10,2) NOT NULL,
 zone_id BIGINT UNSIGNED NULL UNIQUE, FOREIGN KEY(zone_id) REFERENCES parking_zones(id)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS road_edges (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, from_node_id BIGINT UNSIGNED NOT NULL,to_node_id BIGINT UNSIGNED NOT NULL,
 distance_m INT NOT NULL, safety_cost DECIMAL(6,2) NOT NULL DEFAULT 1, comfort_cost DECIMAL(6,2) NOT NULL DEFAULT 1,
 FOREIGN KEY(from_node_id) REFERENCES road_nodes(id), FOREIGN KEY(to_node_id) REFERENCES road_nodes(id),
 UNIQUE(from_node_id,to_node_id), CHECK(from_node_id<to_node_id), CHECK(distance_m>0 AND safety_cost>=1 AND comfort_cost>=1)
) ENGINE=InnoDB;
CREATE TABLE IF NOT EXISTS carbon_ledger (
 id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL UNIQUE, distance_m INT NOT NULL,
 points INT NOT NULL, carbon_kg DECIMAL(12,4) NOT NULL, factor_kg_per_km DECIMAL(5,3) NOT NULL DEFAULT 0.210,
 created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), FOREIGN KEY(order_id) REFERENCES ride_orders(id), CHECK(distance_m>=0 AND points>=0 AND carbon_kg>=0)
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
 SELECT u.id user_id,COALESCE(SUM(c.points),0) points,COALESCE(SUM(c.carbon_kg),0) carbon_kg,COALESCE(SUM(c.distance_m),0) distance_m FROM users u LEFT JOIN ride_orders r ON r.user_id=u.id LEFT JOIN carbon_ledger c ON c.order_id=r.id GROUP BY u.id;
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
CREATE TRIGGER trg_carbon_guard BEFORE INSERT ON carbon_ledger FOR EACH ROW
BEGIN
 DECLARE paid_count INT;
 SELECT COUNT(*) INTO paid_count FROM payments WHERE order_id=NEW.order_id;
 IF paid_count<>1 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Carbon credit requires successful payment'; END IF;
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
