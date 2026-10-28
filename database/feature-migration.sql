-- The caller supplies a unique procedure name and drops it after execution.
-- MySQL DDL implicitly commits; make a backup before migrating an existing database.
CREATE PROCEDURE __MIGRATION_PROCEDURE__(IN p_preparing BOOLEAN)
SQL SECURITY INVOKER
migration: BEGIN
  DECLARE current_version INT DEFAULT 0;
  DECLARE has_staff_name, has_staff_phone, has_road_source, seed_road_attributes BOOLEAN DEFAULT FALSE;
  DECLARE road_attribute_count INT DEFAULT 0;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='users' AND table_type='BASE TABLE') THEN
    SELECT 0 AS migrated;
    LEAVE migration;
  END IF;
  IF EXISTS(SELECT 1 FROM system_settings WHERE name='pdf_expansion' AND (
    COALESCE(JSON_TYPE(JSON_EXTRACT(value,'$.version')),'') NOT IN ('INTEGER','UNSIGNED INTEGER','STRING') OR
    COALESCE(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')),'')='' OR
    JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) REGEXP '[^0-9]' OR
    (CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')))>1 AND LEFT(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')),1)='0'))) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='INVALID_SCHEMA_VERSION: reconcile the migration marker before continuing';
  END IF;
  IF EXISTS(SELECT 1 FROM system_settings WHERE name='pdf_expansion' AND
    CASE WHEN CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')))>2 THEN TRUE
    ELSE CAST(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) AS UNSIGNED)>16 END) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='UNSUPPORTED_SCHEMA_VERSION: use the matching newer application version';
  END IF;
  SELECT COALESCE(MAX(CAST(JSON_UNQUOTE(JSON_EXTRACT(value,'$.version')) AS UNSIGNED)),0) INTO current_version FROM system_settings WHERE name='pdf_expansion';
  IF current_version < 1 THEN
    SELECT COUNT(*) INTO road_attribute_count FROM information_schema.columns
    WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name IN
      ('slope_percent','surface','shade_level','lighting_level','traffic_mix','intersection_risk');
    SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='attribute_source') INTO has_road_source;
    IF has_road_source AND road_attribute_count<6 THEN
      IF EXISTS(SELECT 1 FROM road_edges WHERE attribute_source='MEASURED') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_INCOMPLETE_MEASURED_ROADS';
      END IF;
    END IF;
    SET seed_road_attributes=(road_attribute_count=0 AND NOT has_road_source);
  END IF;
  IF current_version>=1 AND current_version<14 THEN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger' AND table_type='BASE TABLE') THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_CARBON_LEGACY_COLLISION';
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger_legacy' AND table_type='BASE TABLE') THEN
      IF EXISTS (SELECT 1 FROM carbon_ledger_legacy l LEFT JOIN carbon_transactions c ON c.id=l.id WHERE c.id IS NULL OR
          NOT (c.entry_type<=>'AWARD') OR NOT (c.order_id<=>l.order_id) OR NOT (c.distance_m<=>l.distance_m)
          OR NOT (c.points_change<=>l.points) OR NOT (c.carbon_kg_change<=>l.carbon_kg)
          OR NOT (c.factor_kg_per_km<=>l.factor_kg_per_km) OR NOT (c.created_at<=>l.created_at)) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_CARBON_CONFLICT';
      END IF;
    END IF;
  END IF;
  IF p_preparing OR current_version<16 THEN
    DELETE FROM system_settings WHERE name='procedure_revision';
  END IF;
  IF current_version = 16 THEN
    SELECT 0 AS migrated;
    LEAVE migration;
  END IF;
  -- Preserve historical keys; a missing key requires explicit reconciliation.
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='payments' AND column_name='idempotency_key') THEN
    IF EXISTS(SELECT 1 FROM payments WHERE idempotency_key IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_INVALID_PAYMENT_KEYS';
    END IF;
  END IF;
  IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='carbon_transactions' AND column_name='idempotency_key') THEN
    IF EXISTS(SELECT 1 FROM carbon_transactions WHERE idempotency_key IS NULL) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_INVALID_CARBON_KEYS';
    END IF;
  END IF;
  -- Do not discard conflicting legacy contact data: require explicit reconciliation.
  SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='staff' AND column_name='name'),
         EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='staff' AND column_name='phone')
  INTO has_staff_name,has_staff_phone;
  IF has_staff_name THEN
    IF EXISTS(SELECT 1 FROM staff s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL OR NOT (BINARY s.name <=> BINARY u.name)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_NAME_MISMATCH: reconcile staff and users before migration';
    END IF;
  END IF;
  IF has_staff_phone THEN
    IF EXISTS(SELECT 1 FROM staff s LEFT JOIN users u ON u.id=s.user_id WHERE u.id IS NULL OR NOT (BINARY s.phone <=> BINARY u.phone)) THEN
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='STAFF_PHONE_MISMATCH: reconcile staff and users before migration';
    END IF;
  END IF;
  IF current_version < 1 THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='leaderboard_alias') THEN
      ALTER TABLE `users` ADD COLUMN `leaderboard_alias` VARCHAR(40) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='users' AND column_name='leaderboard_visible') THEN
      ALTER TABLE `users` ADD COLUMN `leaderboard_visible` BOOLEAN NOT NULL DEFAULT FALSE;
    END IF;
    UPDATE users SET leaderboard_alias=CONCAT('骑行者',LPAD(id,GREATEST(4,CHAR_LENGTH(id)),'0')) WHERE leaderboard_alias IS NULL OR TRIM(leaderboard_alias)='';
    ALTER TABLE users MODIFY leaderboard_alias VARCHAR(40) NOT NULL DEFAULT '骑行者';
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='qualification_status') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `qualification_status` ENUM('VALID','UNDER_REVIEW','EXCLUDED') NOT NULL DEFAULT 'VALID';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='qualification_reason') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `qualification_reason` VARCHAR(300) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='reviewed_by') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `reviewed_by` BIGINT UNSIGNED NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='reviewed_at') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `reviewed_at` DATETIME(3) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='return_x') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `return_x` DECIMAL(10,2) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='return_y') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `return_y` DECIMAL(10,2) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='location_captured_at') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `location_captured_at` DATETIME(3) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='location_source') THEN
      ALTER TABLE `ride_orders` ADD COLUMN `location_source` ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL') NULL;
    END IF;
    ALTER TABLE return_attempts MODIFY reason ENUM('OUTSIDE_FENCE','ZONE_FULL','ZONE_CLOSED','LOCATION_STALE','INVALID_LOCATION') NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='location_captured_at') THEN
      ALTER TABLE `return_attempts` ADD COLUMN `location_captured_at` DATETIME(3) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='location_source') THEN
      ALTER TABLE `return_attempts` ADD COLUMN `location_source` ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL','HISTORICAL_SIMULATION') NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='review_status') THEN
      ALTER TABLE `return_attempts` ADD COLUMN `review_status` ENUM('PENDING','RESOLVED','DISMISSED') NOT NULL DEFAULT 'PENDING';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='reviewer_id') THEN
      ALTER TABLE `return_attempts` ADD COLUMN `reviewer_id` BIGINT UNSIGNED NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='review_note') THEN
      ALTER TABLE `return_attempts` ADD COLUMN `review_note` VARCHAR(300) NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='reviewed_at') THEN
      ALTER TABLE `return_attempts` ADD COLUMN `reviewed_at` DATETIME(3) NULL;
    END IF;
    UPDATE return_attempts SET location_captured_at=COALESCE(location_captured_at,created_at),location_source=COALESCE(location_source,'HISTORICAL_SIMULATION') WHERE location_captured_at IS NULL OR location_source IS NULL;
    ALTER TABLE return_attempts MODIFY location_captured_at DATETIME(3) NOT NULL, MODIFY location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL','HISTORICAL_SIMULATION') NOT NULL;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='direction') THEN
      ALTER TABLE `road_edges` ADD COLUMN `direction` ENUM('BOTH','FORWARD','REVERSE') NOT NULL DEFAULT 'BOTH';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='status') THEN
      ALTER TABLE `road_edges` ADD COLUMN `status` ENUM('OPEN','CLOSED','NO_RIDE') NOT NULL DEFAULT 'OPEN';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='slope_percent') THEN
      ALTER TABLE `road_edges` ADD COLUMN `slope_percent` DECIMAL(5,2) NOT NULL DEFAULT 0;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='surface') THEN
      ALTER TABLE `road_edges` ADD COLUMN `surface` ENUM('SMOOTH','AVERAGE','ROUGH') NOT NULL DEFAULT 'SMOOTH';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='shade_level') THEN
      ALTER TABLE `road_edges` ADD COLUMN `shade_level` TINYINT UNSIGNED NOT NULL DEFAULT 3;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='lighting_level') THEN
      ALTER TABLE `road_edges` ADD COLUMN `lighting_level` TINYINT UNSIGNED NOT NULL DEFAULT 3;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='traffic_mix') THEN
      ALTER TABLE `road_edges` ADD COLUMN `traffic_mix` ENUM('BIKE_ONLY','MIXED','MOTOR_HEAVY') NOT NULL DEFAULT 'MIXED';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='intersection_risk') THEN
      ALTER TABLE `road_edges` ADD COLUMN `intersection_risk` TINYINT UNSIGNED NOT NULL DEFAULT 1;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='road_edges' AND column_name='attribute_source') THEN
      ALTER TABLE `road_edges` ADD COLUMN `attribute_source` ENUM('SIMULATED_COURSE_DATA','MEASURED') NOT NULL DEFAULT 'SIMULATED_COURSE_DATA';
    END IF;
    IF seed_road_attributes THEN
      UPDATE road_edges SET slope_percent=((CAST(MOD(id,5) AS SIGNED)-2)*1.5),
        surface=CASE WHEN MOD(id,5)=0 THEN 'ROUGH' WHEN MOD(id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END,
        shade_level=LEAST(5,2+MOD(id,4)),lighting_level=5-MOD(id,3),
        traffic_mix=CASE WHEN MOD(id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END,
        intersection_risk=MOD(id,4),attribute_source='SIMULATED_COURSE_DATA';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_transactions' AND table_type='BASE TABLE') THEN
      CREATE TABLE carbon_transactions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      order_id BIGINT UNSIGNED NOT NULL,
      entry_type ENUM('AWARD','ADJUSTMENT') NOT NULL,
      award_order_id BIGINT UNSIGNED GENERATED ALWAYS AS (CASE WHEN entry_type='AWARD' THEN order_id END) STORED UNIQUE,
      idempotency_key VARCHAR(100) NOT NULL UNIQUE,
      distance_m INT NOT NULL DEFAULT 0,
      points_change INT NOT NULL,
      carbon_kg_change DECIMAL(12,4) NOT NULL,
      factor_kg_per_km DECIMAL(5,3) NOT NULL DEFAULT 0.210,
      rule_version VARCHAR(30) NOT NULL,
      reason VARCHAR(300) NOT NULL,
      actor_id BIGINT UNSIGNED NULL,
      created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)),
      FOREIGN KEY(order_id) REFERENCES ride_orders(id),
      FOREIGN KEY(actor_id) REFERENCES users(id), CHECK(distance_m>=0)
    ) ENGINE=InnoDB;
    END IF;
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger' AND table_type='BASE TABLE') THEN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger_legacy') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_CARBON_LEGACY_COLLISION';
      END IF;
      IF EXISTS (SELECT 1 FROM carbon_ledger l LEFT JOIN ride_orders r ON r.id=l.order_id LEFT JOIN payments p ON p.order_id=l.order_id
        WHERE r.id IS NULL OR p.id IS NULL OR NOT (r.status<=>'PAID') OR NOT (p.amount_cents<=>r.amount_cents)
          OR l.distance_m IS NULL OR l.points IS NULL OR l.carbon_kg IS NULL OR l.factor_kg_per_km IS NULL OR l.created_at IS NULL
          OR l.distance_m<0 OR l.points<0 OR l.carbon_kg<0 OR l.factor_kg_per_km<0)
        OR EXISTS (SELECT 1 FROM carbon_ledger GROUP BY order_id HAVING COUNT(*)>1)
        OR EXISTS (SELECT 1 FROM carbon_ledger l JOIN carbon_transactions c ON c.id=l.id WHERE
          NOT (c.entry_type<=>'AWARD') OR NOT (c.order_id<=>l.order_id) OR NOT (c.distance_m<=>l.distance_m)
          OR NOT (c.points_change<=>l.points) OR NOT (c.carbon_kg_change<=>l.carbon_kg)
          OR NOT (c.factor_kg_per_km<=>l.factor_kg_per_km) OR NOT (c.created_at<=>l.created_at))
        OR EXISTS (SELECT 1 FROM carbon_transactions c LEFT JOIN carbon_ledger l ON l.id=c.id WHERE c.entry_type='AWARD' AND l.id IS NULL)
        OR EXISTS (SELECT 1 FROM carbon_ledger l JOIN carbon_transactions c ON c.idempotency_key=CONCAT('legacy-award-',l.order_id) WHERE c.id<>l.id) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_CARBON_CONFLICT';
      END IF;
      INSERT INTO carbon_transactions (id,order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,created_at)
        SELECT l.id,l.order_id,'AWARD',CONCAT('legacy-award-',l.order_id),l.distance_m,l.points,l.carbon_kg,l.factor_kg_per_km,'legacy-v1','历史积分迁移',l.created_at
        FROM carbon_ledger l LEFT JOIN carbon_transactions c ON c.id=l.id WHERE c.id IS NULL;
      IF EXISTS (SELECT 1 FROM carbon_ledger l LEFT JOIN carbon_transactions c ON c.id=l.id WHERE c.id IS NULL OR
          NOT (c.entry_type<=>'AWARD') OR NOT (c.order_id<=>l.order_id) OR NOT (c.distance_m<=>l.distance_m)
          OR NOT (c.points_change<=>l.points) OR NOT (c.carbon_kg_change<=>l.carbon_kg)
          OR NOT (c.factor_kg_per_km<=>l.factor_kg_per_km) OR NOT (c.created_at<=>l.created_at))
        OR EXISTS (SELECT 1 FROM carbon_transactions c LEFT JOIN carbon_ledger l ON l.id=c.id WHERE c.entry_type='AWARD' AND l.id IS NULL) THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_CARBON_VERIFY_FAILED';
      END IF;
      RENAME TABLE carbon_ledger TO carbon_ledger_legacy;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='dispatch_suggestions' AND table_type='BASE TABLE') THEN
      CREATE TABLE dispatch_suggestions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, source_zone_id BIGINT UNSIGNED NOT NULL, target_zone_id BIGINT UNSIGNED NOT NULL,
      quantity INT NOT NULL, source_available INT NOT NULL, target_occupied INT NOT NULL, target_capacity INT NOT NULL, target_reserved INT NOT NULL,
      borrow_count INT NOT NULL, return_count INT NOT NULL, desired_inventory INT NOT NULL,
      window_start DATETIME(3) NOT NULL, window_end DATETIME(3) NOT NULL, reason VARCHAR(500) NOT NULL, algorithm_version VARCHAR(30) NOT NULL,
      status ENUM('OPEN','CONFIRMED','STALE','DISMISSED') NOT NULL DEFAULT 'OPEN', task_id BIGINT UNSIGNED NULL, created_by BIGINT UNSIGNED NOT NULL,
      resolution_note VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)), resolved_at DATETIME(3) NULL,
      FOREIGN KEY(source_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(target_zone_id) REFERENCES parking_zones(id),
      FOREIGN KEY(task_id) REFERENCES dispatch_tasks(id), FOREIGN KEY(created_by) REFERENCES users(id), CHECK(quantity>0 AND source_zone_id<>target_zone_id)
    ) ENGINE=InnoDB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='risk_alerts' AND table_type='BASE TABLE') THEN
      CREATE TABLE risk_alerts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, bike_id BIGINT UNSIGNED NOT NULL, score INT NOT NULL,
      level ENUM('MEDIUM','HIGH') NOT NULL, reasons JSON NOT NULL, ticket_ids JSON NOT NULL, fingerprint CHAR(64) NOT NULL,
      open_fingerprint CHAR(64) GENERATED ALWAYS AS (CASE WHEN status IN('OPEN','ACKNOWLEDGED') THEN fingerprint END) STORED UNIQUE,
      rule_version VARCHAR(30) NOT NULL, status ENUM('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
      recommendation VARCHAR(300) NOT NULL, handler_id BIGINT UNSIGNED NULL, maintenance_ticket_id BIGINT UNSIGNED NULL,
      resolution_note VARCHAR(500) NULL, triggered_at DATETIME(3) NOT NULL DEFAULT (UTC_TIMESTAMP(3)), acknowledged_at DATETIME(3) NULL, resolved_at DATETIME(3) NULL,
      FOREIGN KEY(bike_id) REFERENCES bikes(id), FOREIGN KEY(handler_id) REFERENCES users(id), FOREIGN KEY(maintenance_ticket_id) REFERENCES maintenance_tickets(id), CHECK(score BETWEEN 0 AND 100)
    ) ENGINE=InnoDB;
    END IF;
    INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km',0.21,'points_per_km',10,'rule_version','carbon-v1')) ON DUPLICATE KEY UPDATE value=JSON_INSERT(value,'$.rule_version','carbon-v1');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='ride_orders' AND column_name='reviewed_by' AND referenced_table_name IS NOT NULL) THEN
    ALTER TABLE `ride_orders` ADD CONSTRAINT `fk_ride_reviewer` FOREIGN KEY(`reviewed_by`) REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name='return_attempts' AND column_name='reviewer_id' AND referenced_table_name IS NOT NULL) THEN
    ALTER TABLE `return_attempts` ADD CONSTRAINT `fk_return_reviewer` FOREIGN KEY(`reviewer_id`) REFERENCES users(id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='ride_orders' AND constraint_name='chk_ride_return_pair') THEN
    ALTER TABLE `ride_orders` ADD CONSTRAINT `chk_ride_return_pair` CHECK((return_x IS NULL)=(return_y IS NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='ride_orders' AND constraint_name='chk_ride_qualification_review') THEN
    ALTER TABLE `ride_orders` ADD CONSTRAINT `chk_ride_qualification_review` CHECK((qualification_status='UNDER_REVIEW' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR (qualification_status='VALID' AND ((reviewed_by IS NULL AND reviewed_at IS NULL) OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))) OR (qualification_status='EXCLUDED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='return_attempts' AND constraint_name='chk_return_review_state') THEN
    ALTER TABLE `return_attempts` ADD CONSTRAINT `chk_return_review_state` CHECK((review_status='PENDING' AND reviewer_id IS NULL AND reviewed_at IS NULL) OR (review_status<>'PENDING' AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='road_edges' AND constraint_name='chk_road_attributes') THEN
    ALTER TABLE `road_edges` ADD CONSTRAINT `chk_road_attributes` CHECK(slope_percent BETWEEN -30 AND 30 AND shade_level BETWEEN 0 AND 5 AND lighting_level BETWEEN 0 AND 5 AND intersection_risk BETWEEN 0 AND 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='dispatch_suggestions' AND constraint_name='chk_suggestion_state') THEN
    ALTER TABLE `dispatch_suggestions` ADD CONSTRAINT `chk_suggestion_state` CHECK((status='OPEN' AND task_id IS NULL AND resolved_at IS NULL) OR (status='CONFIRMED' AND task_id IS NOT NULL AND resolved_at IS NOT NULL) OR (status IN('STALE','DISMISSED') AND task_id IS NULL AND resolved_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name='risk_alerts' AND constraint_name='chk_risk_state') THEN
    ALTER TABLE `risk_alerts` ADD CONSTRAINT `chk_risk_state` CHECK((status='OPEN' AND handler_id IS NULL AND acknowledged_at IS NULL AND resolved_at IS NULL) OR (status='ACKNOWLEDGED' AND handler_id IS NOT NULL AND acknowledged_at IS NOT NULL AND resolved_at IS NULL) OR (status IN('RESOLVED','DISMISSED') AND handler_id IS NOT NULL AND resolved_at IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_started_at') THEN
    CREATE INDEX idx_ride_started_at ON ride_orders(started_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_ended_at') THEN
    CREATE INDEX idx_ride_ended_at ON ride_orders(ended_at);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='zone_snapshots' AND table_type='BASE TABLE')
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='zone_snapshots' AND index_name='idx_snapshot_time') THEN
    CREATE INDEX idx_snapshot_time ON zone_snapshots(captured_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_status') THEN
    CREATE INDEX idx_ride_user_status ON ride_orders(user_id,status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='dispatch_tasks' AND index_name='idx_dispatch_target_status') THEN
    CREATE INDEX idx_dispatch_target_status ON dispatch_tasks(target_zone_id,status);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='carbon_transactions' AND index_name='idx_carbon_created_order') THEN
    CREATE INDEX idx_carbon_created_order ON carbon_transactions(created_at,order_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='maintenance_tickets' AND index_name='idx_ticket_created_bike') THEN
    CREATE INDEX idx_ticket_created_bike ON maintenance_tickets(created_at,bike_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='maintenance_tickets' AND column_name='completed_at')
     AND NOT EXISTS (SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='maintenance_tickets' AND index_name='idx_ticket_completed_bike') THEN
    CREATE INDEX idx_ticket_completed_bike ON maintenance_tickets(status,bike_id,completed_at);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dispatch_tasks' AND column_name='inventory_created') THEN
    ALTER TABLE dispatch_tasks ADD COLUMN inventory_created JSON NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dispatch_tasks' AND column_name='inventory_started') THEN
    ALTER TABLE dispatch_tasks ADD COLUMN inventory_started JSON NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='dispatch_tasks' AND column_name='inventory_completed') THEN
    ALTER TABLE dispatch_tasks ADD COLUMN inventory_completed JSON NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='carbon_transactions'
    AND column_name='factor_kg_per_km' AND numeric_precision=20 AND numeric_scale=8) THEN
    ALTER TABLE carbon_transactions MODIFY factor_kg_per_km DECIMAL(20,8) NOT NULL DEFAULT 0.21;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='carbon_transactions' AND column_name='points_per_km') THEN
    ALTER TABLE carbon_transactions ADD COLUMN points_per_km DECIMAL(20,8) NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='carbon_ledger' AND table_type='BASE TABLE') THEN
    CREATE OR REPLACE VIEW carbon_ledger AS
      SELECT id,order_id,distance_m,points_change points,carbon_kg_change carbon_kg,factor_kg_per_km,created_at
      FROM carbon_transactions WHERE entry_type='AWARD';
  END IF;
  IF current_version < 10 THEN
    BEGIN
      DECLARE done BOOLEAN DEFAULT FALSE;
      DECLARE v_table,v_column VARCHAR(64);
      DECLARE defaults_cursor CURSOR FOR
        SELECT c.table_name,c.column_name FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema=c.table_schema AND t.table_name=c.table_name AND t.table_type='BASE TABLE'
        WHERE c.table_schema=DATABASE() AND c.data_type='datetime' AND (
          (c.table_name='users' AND c.column_name='created_at') OR
          (c.table_name='ride_orders' AND c.column_name='started_at') OR
          (c.table_name='payments' AND c.column_name='paid_at') OR
          (c.table_name='dispatch_tasks' AND c.column_name='created_at') OR
          (c.table_name='maintenance_tickets' AND c.column_name='created_at') OR
          (c.table_name='zone_snapshots' AND c.column_name='captured_at') OR
          (c.table_name='return_attempts' AND c.column_name='created_at') OR
          (c.table_name='dispatch_suggestions' AND c.column_name='created_at') OR
          (c.table_name='risk_alerts' AND c.column_name='triggered_at') OR
          (c.table_name='carbon_transactions' AND c.column_name='created_at') OR
          (c.table_name='audit_logs' AND c.column_name='created_at')
        ) AND (c.column_default IS NULL OR LOWER(c.column_default) NOT IN ('utc_timestamp(3)','(utc_timestamp(3))'));
      DECLARE CONTINUE HANDLER FOR NOT FOUND SET done=TRUE;
      OPEN defaults_cursor;
      defaults_loop: LOOP
        FETCH defaults_cursor INTO v_table,v_column;
        IF done THEN LEAVE defaults_loop; END IF;
        SET @qingxing_utc_default_sql=CONCAT('ALTER TABLE `',v_table,'` ALTER COLUMN `',v_column,'` SET DEFAULT (UTC_TIMESTAMP(3))');
        PREPARE qingxing_utc_default FROM @qingxing_utc_default_sql;
        EXECUTE qingxing_utc_default;
        DEALLOCATE PREPARE qingxing_utc_default;
      END LOOP;
      CLOSE defaults_cursor;
      SET @qingxing_utc_default_sql=NULL;
    END;
  END IF;
  IF has_staff_name AND has_staff_phone THEN
    ALTER TABLE staff DROP COLUMN name, DROP COLUMN phone;
  ELSEIF has_staff_name THEN
    ALTER TABLE staff DROP COLUMN name;
  ELSEIF has_staff_phone THEN
    ALTER TABLE staff DROP COLUMN phone;
  END IF;
  IF current_version < 12 THEN
    ALTER TABLE payments MODIFY idempotency_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
    ALTER TABLE carbon_transactions MODIFY idempotency_key VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL;
  END IF;
  IF current_version < 13 THEN
    CREATE OR REPLACE VIEW v_user_carbon AS
      SELECT u.id user_id,COALESCE(SUM(c.points_change),0) points,COALESCE(SUM(c.carbon_kg_change),0) carbon_kg,
       COALESCE(SUM(CASE WHEN c.entry_type='AWARD' AND r.status='PAID' AND r.qualification_status='VALID' THEN c.distance_m ELSE 0 END),0) distance_m
      FROM users u LEFT JOIN ride_orders r ON r.user_id=u.id LEFT JOIN carbon_transactions c ON c.order_id=r.id GROUP BY u.id;
  END IF;
  IF current_version < 15 THEN
    IF EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_qualification') THEN
      IF (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_qualification')<>1
       OR NOT EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_qualification'
        AND seq_in_index=1 AND column_name='qualification_status' AND sub_part IS NULL AND non_unique=1 AND index_type='BTREE' AND is_visible='YES') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_REVIEW_INDEX_CONFLICT';
      END IF;
    ELSE
      CREATE INDEX idx_ride_qualification ON ride_orders(qualification_status);
    END IF;
  END IF;
  IF current_version < 16 THEN
    IF EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_id') THEN
      IF (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_id')<>2
       OR NOT EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_id'
        AND seq_in_index=1 AND column_name='user_id' AND sub_part IS NULL AND non_unique=1 AND index_type='BTREE' AND collation='A' AND is_visible='YES')
       OR NOT EXISTS(SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name='ride_orders' AND index_name='idx_ride_user_id'
        AND seq_in_index=2 AND column_name='id' AND sub_part IS NULL AND non_unique=1 AND index_type='BTREE' AND collation='A' AND is_visible='YES') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='MIGRATION_RIDE_USER_INDEX_CONFLICT';
      END IF;
    ELSE
      CREATE INDEX idx_ride_user_id ON ride_orders(user_id,id);
    END IF;
  END IF;
  INSERT INTO system_settings(name,value) VALUES('pdf_expansion',JSON_OBJECT('version',16,'applied_at',UTC_TIMESTAMP(3))) ON DUPLICATE KEY UPDATE value=VALUES(value);
  SELECT 1 AS migrated;
END
