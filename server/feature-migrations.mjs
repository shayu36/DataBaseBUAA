const VERSION = 2;

async function tableExists(db, table) {
  const [[row]] = await db.query(
    "SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? AND table_type='BASE TABLE'",
    [table],
  );
  return row.n === 1;
}

async function columnExists(db, table, column) {
  const [[row]] = await db.query(
    "SELECT COUNT(*) n FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=?",
    [table, column],
  );
  return row.n === 1;
}

async function addColumn(db, applied, table, column, definition) {
  if (await columnExists(db, table, column)) return;
  await db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
  applied.push(`${table}.${column}`);
}

async function constraintExists(db, table, constraint) {
  const [[row]] = await db.query(
    "SELECT COUNT(*) n FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=?",
    [table, constraint],
  );
  return row.n === 1;
}

async function foreignKeyExists(db, table, column) {
  const [[row]] = await db.query(
    "SELECT COUNT(*) n FROM information_schema.key_column_usage WHERE table_schema=DATABASE() AND table_name=? AND column_name=? AND referenced_table_name IS NOT NULL",
    [table, column],
  );
  return row.n === 1;
}

async function addConstraint(db, applied, table, name, definition) {
  if (await constraintExists(db, table, name)) return;
  await db.query(
    `ALTER TABLE \`${table}\` ADD CONSTRAINT \`${name}\` ${definition}`,
  );
  applied.push(`${table}.${name}`);
}

async function addExpandedColumns(db, applied) {
  await addColumn(
    db,
    applied,
    "users",
    "leaderboard_alias",
    "leaderboard_alias VARCHAR(40) NULL",
  );
  await addColumn(
    db,
    applied,
    "users",
    "leaderboard_visible",
    "leaderboard_visible BOOLEAN NOT NULL DEFAULT FALSE",
  );
  await db.query(
    "UPDATE users SET leaderboard_alias=CONCAT('骑行者',LPAD(id,4,'0')) WHERE leaderboard_alias IS NULL OR TRIM(leaderboard_alias)=''",
  );
  await db.query(
    "ALTER TABLE users MODIFY leaderboard_alias VARCHAR(40) NOT NULL DEFAULT '骑行者'",
  );

  for (const [column, definition] of [
    [
      "qualification_status",
      "qualification_status ENUM('VALID','UNDER_REVIEW','EXCLUDED') NOT NULL DEFAULT 'VALID'",
    ],
    ["qualification_reason", "qualification_reason VARCHAR(300) NULL"],
    ["reviewed_by", "reviewed_by BIGINT UNSIGNED NULL"],
    ["reviewed_at", "reviewed_at DATETIME(3) NULL"],
    ["return_x", "return_x DECIMAL(10,2) NULL"],
    ["return_y", "return_y DECIMAL(10,2) NULL"],
    ["location_captured_at", "location_captured_at DATETIME(3) NULL"],
    [
      "location_source",
      "location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL') NULL",
    ],
  ])
    await addColumn(db, applied, "ride_orders", column, definition);

  await db.query(
    "ALTER TABLE return_attempts MODIFY reason ENUM('OUTSIDE_FENCE','ZONE_FULL','ZONE_CLOSED','LOCATION_STALE','INVALID_LOCATION') NOT NULL",
  );
  for (const [column, definition] of [
    ["location_captured_at", "location_captured_at DATETIME(3) NULL"],
    [
      "location_source",
      "location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL','HISTORICAL_SIMULATION') NULL",
    ],
    [
      "review_status",
      "review_status ENUM('PENDING','RESOLVED','DISMISSED') NOT NULL DEFAULT 'PENDING'",
    ],
    ["reviewer_id", "reviewer_id BIGINT UNSIGNED NULL"],
    ["review_note", "review_note VARCHAR(300) NULL"],
    ["reviewed_at", "reviewed_at DATETIME(3) NULL"],
  ])
    await addColumn(db, applied, "return_attempts", column, definition);
  await db.query(
    "UPDATE return_attempts SET location_captured_at=created_at,location_source='HISTORICAL_SIMULATION' WHERE location_captured_at IS NULL OR location_source IS NULL",
  );
  await db.query(
    "ALTER TABLE return_attempts MODIFY location_captured_at DATETIME(3) NOT NULL,MODIFY location_source ENUM('MAP_SIMULATION','DEVICE_GPS','MANUAL','HISTORICAL_SIMULATION') NOT NULL",
  );

  for (const [column, definition] of [
    [
      "direction",
      "direction ENUM('BOTH','FORWARD','REVERSE') NOT NULL DEFAULT 'BOTH'",
    ],
    [
      "status",
      "status ENUM('OPEN','CLOSED','NO_RIDE') NOT NULL DEFAULT 'OPEN'",
    ],
    ["slope_percent", "slope_percent DECIMAL(5,2) NOT NULL DEFAULT 0"],
    [
      "surface",
      "surface ENUM('SMOOTH','AVERAGE','ROUGH') NOT NULL DEFAULT 'SMOOTH'",
    ],
    ["shade_level", "shade_level TINYINT UNSIGNED NOT NULL DEFAULT 3"],
    ["lighting_level", "lighting_level TINYINT UNSIGNED NOT NULL DEFAULT 3"],
    [
      "traffic_mix",
      "traffic_mix ENUM('BIKE_ONLY','MIXED','MOTOR_HEAVY') NOT NULL DEFAULT 'MIXED'",
    ],
    [
      "intersection_risk",
      "intersection_risk TINYINT UNSIGNED NOT NULL DEFAULT 1",
    ],
    [
      "attribute_source",
      "attribute_source ENUM('SIMULATED_COURSE_DATA','MEASURED') NOT NULL DEFAULT 'SIMULATED_COURSE_DATA'",
    ],
  ])
    await addColumn(db, applied, "road_edges", column, definition);
  await db.query(`UPDATE road_edges SET
    slope_percent=((CAST(MOD(id,5) AS SIGNED)-2)*1.5),
    surface=CASE WHEN MOD(id,5)=0 THEN 'ROUGH' WHEN MOD(id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END,
    shade_level=LEAST(5,2+MOD(id,4)),lighting_level=5-MOD(id,3),
    traffic_mix=CASE WHEN MOD(id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END,
    intersection_risk=MOD(id,4),attribute_source='SIMULATED_COURSE_DATA'`);
}

async function migrateCarbon(db, applied) {
  if (!(await tableExists(db, "carbon_transactions"))) {
    await db.query(`CREATE TABLE carbon_transactions (
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
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      FOREIGN KEY(order_id) REFERENCES ride_orders(id),
      FOREIGN KEY(actor_id) REFERENCES users(id), CHECK(distance_m>=0)
    ) ENGINE=InnoDB`);
    applied.push("carbon_transactions");
  }
  if (await tableExists(db, "carbon_ledger")) {
    await db.query(`INSERT IGNORE INTO carbon_transactions
      (id,order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,rule_version,reason,created_at)
      SELECT id,order_id,'AWARD',CONCAT('legacy-award-',order_id),distance_m,points,carbon_kg,factor_kg_per_km,'legacy-v1','历史积分迁移',created_at FROM carbon_ledger`);
    const [[oldTotals]] = await db.query(
      "SELECT COUNT(*) n,COALESCE(SUM(points),0) points,COALESCE(SUM(carbon_kg),0) carbon FROM carbon_ledger",
    );
    const [[newTotals]] = await db.query(
      "SELECT COUNT(*) n,COALESCE(SUM(points_change),0) points,COALESCE(SUM(carbon_kg_change),0) carbon FROM carbon_transactions WHERE entry_type='AWARD'",
    );
    if (
      Number(oldTotals.n) !== Number(newTotals.n) ||
      Number(oldTotals.points) !== Number(newTotals.points) ||
      Number(oldTotals.carbon) !== Number(newTotals.carbon)
    )
      throw new Error("Carbon migration verification failed");
    if (!(await tableExists(db, "carbon_ledger_legacy")))
      await db.query("RENAME TABLE carbon_ledger TO carbon_ledger_legacy");
    applied.push("carbon_ledger->carbon_transactions");
  }
}

async function createSupportTables(db, applied) {
  if (!(await tableExists(db, "dispatch_suggestions"))) {
    await db.query(`CREATE TABLE dispatch_suggestions (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, source_zone_id BIGINT UNSIGNED NOT NULL, target_zone_id BIGINT UNSIGNED NOT NULL,
      quantity INT NOT NULL, source_available INT NOT NULL, target_occupied INT NOT NULL, target_capacity INT NOT NULL, target_reserved INT NOT NULL,
      borrow_count INT NOT NULL, return_count INT NOT NULL, desired_inventory INT NOT NULL,
      window_start DATETIME(3) NOT NULL, window_end DATETIME(3) NOT NULL, reason VARCHAR(500) NOT NULL, algorithm_version VARCHAR(30) NOT NULL,
      status ENUM('OPEN','CONFIRMED','STALE','DISMISSED') NOT NULL DEFAULT 'OPEN', task_id BIGINT UNSIGNED NULL, created_by BIGINT UNSIGNED NOT NULL,
      resolution_note VARCHAR(500) NULL, created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), resolved_at DATETIME(3) NULL,
      FOREIGN KEY(source_zone_id) REFERENCES parking_zones(id), FOREIGN KEY(target_zone_id) REFERENCES parking_zones(id),
      FOREIGN KEY(task_id) REFERENCES dispatch_tasks(id), FOREIGN KEY(created_by) REFERENCES users(id), CHECK(quantity>0 AND source_zone_id<>target_zone_id)
    ) ENGINE=InnoDB`);
    applied.push("dispatch_suggestions");
  }
  if (!(await tableExists(db, "risk_alerts"))) {
    await db.query(`CREATE TABLE risk_alerts (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, bike_id BIGINT UNSIGNED NOT NULL, score INT NOT NULL,
      level ENUM('MEDIUM','HIGH') NOT NULL, reasons JSON NOT NULL, ticket_ids JSON NOT NULL, fingerprint CHAR(64) NOT NULL,
      open_fingerprint CHAR(64) GENERATED ALWAYS AS (CASE WHEN status IN('OPEN','ACKNOWLEDGED') THEN fingerprint END) STORED UNIQUE,
      rule_version VARCHAR(30) NOT NULL, status ENUM('OPEN','ACKNOWLEDGED','RESOLVED','DISMISSED') NOT NULL DEFAULT 'OPEN',
      recommendation VARCHAR(300) NOT NULL, handler_id BIGINT UNSIGNED NULL, maintenance_ticket_id BIGINT UNSIGNED NULL,
      resolution_note VARCHAR(500) NULL, triggered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), acknowledged_at DATETIME(3) NULL, resolved_at DATETIME(3) NULL,
      FOREIGN KEY(bike_id) REFERENCES bikes(id), FOREIGN KEY(handler_id) REFERENCES users(id), FOREIGN KEY(maintenance_ticket_id) REFERENCES maintenance_tickets(id), CHECK(score BETWEEN 0 AND 100)
    ) ENGINE=InnoDB`);
    applied.push("risk_alerts");
  }
}

async function addExpandedConstraints(db, applied) {
  if (!(await foreignKeyExists(db, "ride_orders", "reviewed_by"))) {
    await db.query(
      "ALTER TABLE ride_orders ADD CONSTRAINT fk_ride_reviewer FOREIGN KEY(reviewed_by) REFERENCES users(id)",
    );
    applied.push("ride_orders.fk_ride_reviewer");
  }
  if (!(await foreignKeyExists(db, "return_attempts", "reviewer_id"))) {
    await db.query(
      "ALTER TABLE return_attempts ADD CONSTRAINT fk_return_reviewer FOREIGN KEY(reviewer_id) REFERENCES users(id)",
    );
    applied.push("return_attempts.fk_return_reviewer");
  }
  await addConstraint(
    db,
    applied,
    "ride_orders",
    "chk_ride_return_pair",
    "CHECK((return_x IS NULL)=(return_y IS NULL))",
  );
  await addConstraint(
    db,
    applied,
    "ride_orders",
    "chk_ride_qualification_review",
    `CHECK(
      (qualification_status='UNDER_REVIEW' AND reviewed_by IS NULL AND reviewed_at IS NULL) OR
      (qualification_status='VALID' AND ((reviewed_by IS NULL AND reviewed_at IS NULL) OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))) OR
      (qualification_status='EXCLUDED' AND reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL))`,
  );
  await addConstraint(
    db,
    applied,
    "return_attempts",
    "chk_return_review_state",
    "CHECK((review_status='PENDING' AND reviewer_id IS NULL AND reviewed_at IS NULL) OR (review_status<>'PENDING' AND reviewer_id IS NOT NULL AND reviewed_at IS NOT NULL AND review_note IS NOT NULL))",
  );
  await addConstraint(
    db,
    applied,
    "road_edges",
    "chk_road_attributes",
    "CHECK(slope_percent BETWEEN -30 AND 30 AND shade_level BETWEEN 0 AND 5 AND lighting_level BETWEEN 0 AND 5 AND intersection_risk BETWEEN 0 AND 5)",
  );
  await addConstraint(
    db,
    applied,
    "dispatch_suggestions",
    "chk_suggestion_state",
    "CHECK((status='OPEN' AND task_id IS NULL AND resolved_at IS NULL) OR (status='CONFIRMED' AND task_id IS NOT NULL AND resolved_at IS NOT NULL) OR (status IN('STALE','DISMISSED') AND task_id IS NULL AND resolved_at IS NOT NULL))",
  );
  await addConstraint(
    db,
    applied,
    "risk_alerts",
    "chk_risk_state",
    "CHECK((status='OPEN' AND handler_id IS NULL AND acknowledged_at IS NULL AND resolved_at IS NULL) OR (status='ACKNOWLEDGED' AND handler_id IS NOT NULL AND acknowledged_at IS NOT NULL AND resolved_at IS NULL) OR (status IN('RESOLVED','DISMISSED') AND handler_id IS NOT NULL AND resolved_at IS NOT NULL))",
  );
}

export async function applyFeatureMigrations(db) {
  if (!(await tableExists(db, "users"))) return { applied: [] };
  const [[marker]] = await db.query(
    "SELECT value FROM system_settings WHERE name='pdf_expansion'",
  );
  const value = marker
    ? typeof marker.value === "string"
      ? JSON.parse(marker.value)
      : marker.value
    : null;
  const currentVersion = Number(value?.version || 0);
  if (currentVersion >= VERSION) return { applied: [] };
  const applied = [];
  if (currentVersion < 1) {
    await addExpandedColumns(db, applied);
    await migrateCarbon(db, applied);
    await createSupportTables(db, applied);
    await db.query(
      "INSERT INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km',0.21,'points_per_km',10,'source','ROUTE_ESTIMATE','rule_version','carbon-v1')) ON DUPLICATE KEY UPDATE value=JSON_SET(value,'$.rule_version','carbon-v1')",
    );
    await db.query(
      "INSERT INTO system_settings(name,value) VALUES('risk',JSON_OBJECT('rule_version','risk-v1','window_days',30)) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    );
  }
  await addExpandedConstraints(db, applied);
  await db.query(
    "INSERT INTO system_settings(name,value) VALUES('pdf_expansion',JSON_OBJECT('version',?,'applied_at',UTC_TIMESTAMP(3))) ON DUPLICATE KEY UPDATE value=VALUES(value)",
    [VERSION],
  );
  applied.push(`pdf_expansion@${VERSION}`);
  return { applied };
}
