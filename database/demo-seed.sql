-- Seed data is inserted in the caller's transaction, under the application lock.
-- The map and precomputed route distances are inputs shared with the application.
CREATE PROCEDURE __SEED_PROCEDURE__(IN campus JSON, IN distances JSON, IN password_hash VARCHAR(100))
SQL SECURITY INVOKER
seed: BEGIN
  DECLARE now_utc DATETIME(3) DEFAULT UTC_TIMESTAMP(3);
  DECLARE day_no, user_no, trip_no, origin_zone, destination_zone, metres INT DEFAULT 0;
  DECLARE started, ended DATETIME(3);
  DECLARE order_id BIGINT UNSIGNED;
  DECLARE bike_max INT;

  IF EXISTS (SELECT 1 FROM system_settings WHERE name='seed_version') THEN
    SELECT 0 AS seeded;
    LEAVE seed;
  END IF;
  IF EXISTS (SELECT 1 FROM users LIMIT 1) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Nonempty unmarked database: refusing automatic seed';
  END IF;

  INSERT INTO users(id,name,email,phone,password_hash,role) VALUES
    (1,'贾鑫洋','jia@qingxing.local','13800000001',password_hash,'ADMIN'),
    (2,'欧阳晨','ouyang@qingxing.local','13800000002',password_hash,'STUDENT'),
    (3,'郑一凡','zheng@qingxing.local','13800000003',password_hash,'OPERATOR'),
    (4,'王奕','wang@qingxing.local','13800000004',password_hash,'STUDENT');
  UPDATE users SET leaderboard_alias=CONCAT('骑行者',LPAD(id,GREATEST(4,CHAR_LENGTH(id)),'0')),leaderboard_visible=(id IN(2,4));
  INSERT INTO staff(id,user_id,name,phone,job) VALUES(1,3,'郑一凡','13800000003','BOTH');

  INSERT INTO parking_zones(id,name,location,x,y,radius,capacity)
    SELECT id,name,location,x,y,35,capacity FROM JSON_TABLE(campus,'$.zones[*]' COLUMNS(
      id INT PATH '$.id',name VARCHAR(60) PATH '$.name',location VARCHAR(160) PATH '$.location',
      x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y',capacity INT PATH '$.capacity'
    )) z;
  SELECT MAX(z.bike_count) INTO bike_max FROM JSON_TABLE(campus,'$.zones[*]' COLUMNS(bike_count INT PATH '$.count')) z;
  INSERT INTO bikes(id,code,deployed_at,current_zone_id,last_service_at)
    WITH RECURSIVE seq AS (SELECT 0 AS n UNION ALL SELECT n+1 FROM seq WHERE n+1<bike_max)
    SELECT bike_id,CONCAT('QX-',LPAD(bike_id,3,'0')),DATE_SUB(UTC_DATE(),INTERVAL 120 DAY),zone_id,DATE_SUB(UTC_TIMESTAMP(),INTERVAL MOD(n*7,100) DAY)
    FROM (SELECT ROW_NUMBER() OVER (ORDER BY z.id,seq.n) AS bike_id,z.id AS zone_id,seq.n
      FROM JSON_TABLE(campus,'$.zones[*]' COLUMNS(id INT PATH '$.id',bike_count INT PATH '$.count')) z JOIN seq ON seq.n<z.bike_count) seed_bikes;
  INSERT INTO road_nodes(id,name,x,y,zone_id)
    SELECT id,name,x,y,zone_id FROM JSON_TABLE(campus,'$.nodes[*]' COLUMNS(
      id INT PATH '$.id',name VARCHAR(60) PATH '$.name',x DECIMAL(10,2) PATH '$.x',y DECIMAL(10,2) PATH '$.y',zone_id INT PATH '$.zone_id' NULL ON EMPTY
    )) nodes;
  INSERT INTO road_edges(from_node_id,to_node_id,distance_m,safety_cost,comfort_cost,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk,attribute_source)
    SELECT from_id,to_id,distance_m,safety_cost,comfort_cost,'BOTH','OPEN',
      (CAST(MOD(id,5) AS SIGNED)-2)*1.5,CASE WHEN MOD(id,5)=0 THEN 'ROUGH' WHEN MOD(id,2)=0 THEN 'AVERAGE' ELSE 'SMOOTH' END,
      LEAST(5,2+MOD(id,4)),5-MOD(id,3),CASE WHEN MOD(id,7)=0 THEN 'MOTOR_HEAVY' WHEN MOD(id,3)=0 THEN 'BIKE_ONLY' ELSE 'MIXED' END,
      MOD(id,4),'SIMULATED_COURSE_DATA'
    FROM JSON_TABLE(campus,'$.edges[*]' COLUMNS(id INT PATH '$.id',from_id INT PATH '$.from_node_id',to_id INT PATH '$.to_node_id',
      distance_m INT PATH '$.distance_m',safety_cost DECIMAL(6,2) PATH '$.safety_cost',comfort_cost DECIMAL(6,2) PATH '$.comfort_cost')) edges;
  INSERT INTO system_settings(name,value) VALUES('campus_map',JSON_OBJECT('version',JSON_UNQUOTE(JSON_EXTRACT(campus,'$.version')),'source',JSON_UNQUOTE(JSON_EXTRACT(campus,'$.source'))));

  WHILE day_no<14 DO
    SET user_no=1;
    WHILE user_no<=4 DO
      SET trip_no=0;
      WHILE trip_no<3 DO
        SET origin_zone=MOD(day_no+user_no+trip_no,6)+1;
        SET destination_zone=MOD(origin_zone+trip_no,6)+1;
        SET started=TIMESTAMP(UTC_DATE()) - INTERVAL day_no DAY + INTERVAL (trip_no*5+1) HOUR + INTERVAL (user_no*10) MINUTE;
        SET ended=started + INTERVAL 20 MINUTE;
        IF ended<=now_utc THEN
          SET metres=CAST(JSON_UNQUOTE(JSON_EXTRACT(distances,CONCAT('$[',((origin_zone-1)*6+destination_zone-1),']'))) AS UNSIGNED);
          INSERT INTO ride_orders(user_id,bike_id,start_zone_id,end_zone_id,started_at,ended_at,amount_cents,distance_m,status)
            VALUES(user_no,user_no,origin_zone,destination_zone,started,ended,100,metres,'UNPAID');
          SET order_id=LAST_INSERT_ID();
          INSERT INTO payments(order_id,idempotency_key,amount_cents,paid_at) VALUES(order_id,CONCAT('seed-',order_id),100,ended);
          UPDATE ride_orders SET status='PAID' WHERE id=order_id;
          INSERT INTO carbon_transactions(order_id,entry_type,idempotency_key,distance_m,points_change,carbon_kg_change,factor_kg_per_km,points_per_km,rule_version,reason,created_at)
            VALUES(order_id,'AWARD',CONCAT('seed-award-',order_id),metres,FLOOR(metres/100),ROUND(metres*0.00021,4),0.210,10,'carbon-v1','有效已支付行程积分发放',ended);
        END IF;
        SET trip_no=trip_no+1;
      END WHILE;
      SET user_no=user_no+1;
    END WHILE;
    SET day_no=day_no+1;
  END WHILE;

  INSERT INTO maintenance_tickets(bike_id,reporter_id,staff_id,fault_type,description,status,result,created_at,completed_at)
    SELECT 1,2,1,'BRAKE','演示历史：制动性能下降','COMPLETED','检查并更换制动组件',DATE_SUB(now_utc,INTERVAL ago DAY),DATE_SUB(now_utc,INTERVAL (ago-1) DAY)
    FROM (SELECT 3 AS ago UNION ALL SELECT 12 UNION ALL SELECT 22) history;
  UPDATE bikes SET last_service_at=DATE_SUB(now_utc,INTERVAL 2 DAY) WHERE id=1;
  INSERT INTO maintenance_tickets(bike_id,reporter_id,fault_type,description) VALUES(63,4,'LOCK','演示报修：车锁无法正常打开');
  INSERT INTO maintenance_tickets(bike_id,reporter_id,staff_id,fault_type,description,status) VALUES(15,2,1,'TIRE','演示报修：后轮缓慢漏气','ASSIGNED');
  UPDATE bikes SET status='MAINTENANCE' WHERE id IN(15,63);

  INSERT INTO zone_snapshots(zone_id,available,occupied,capacity,captured_at,source)
    WITH RECURSIVE days AS (SELECT 0 AS n UNION ALL SELECT n+1 FROM days WHERE n<6),
      intervals AS (SELECT 0 AS n UNION ALL SELECT n+1 FROM intervals WHERE n<48)
    SELECT id,GREATEST(0,occupied-(id IN(1,6))),occupied,capacity,captured_at,'DEMO' FROM (
      SELECT z.id,z.capacity,TIMESTAMP(UTC_DATE()) - INTERVAL days.n DAY + INTERVAL (intervals.n*5) MINUTE AS captured_at,
        CASE WHEN z.id=4 THEN CASE WHEN MOD(intervals.n,12)<5 THEN z.capacity ELSE FLOOR(z.capacity*0.8) END
          ELSE GREATEST(0,LEAST(z.capacity,ROUND(z.capacity*(0.48+0.4*SIN(intervals.n/5+z.id))))) END AS occupied
      FROM JSON_TABLE(campus,'$.zones[*]' COLUMNS(id INT PATH '$.id',capacity INT PATH '$.capacity')) z CROSS JOIN days CROSS JOIN intervals
    ) samples WHERE captured_at<=now_utc;
  INSERT INTO system_settings(name,value) VALUES('seed_version',JSON_OBJECT('version',1,'history','synthetic'));
  INSERT IGNORE INTO system_settings(name,value) VALUES('carbon',JSON_OBJECT('kg_per_km',0.21,'points_per_km',10,'rule_version','carbon-v1'));
  SELECT 1 AS seeded;
END
