# 校园单车独立正确性审查

审查日期：2026-10-04。范围：business、admin、db、auth、app、read-model、analytics、schema，参照 bike-design / bike-api。只读取源码及一次数据库时区 SELECT，未修改实现、未重跑测试套件。以下是审查时快照的具体问题；并行实现者可能随后修复，须以回归验证确认。

## 发现

### P1：数据库 DECIMAL 字符串阻断默认归还流程

- 位置：server/db.mjs:14 (`decimalNumbers:false`)；server/read-model.mjs:7、20（直接输出停车区）；src/pages.tsx:101、149、194、209（从站点取得 x/y 并直接提交）；server/business.mjs:5、38（只接受 z.number）。
- 触发：读取仪表盘后借车，选择归还停车区或点击地图站点，不手工编辑坐标，直接确认归还。MySQL DECIMAL 的 x/y 默认解码成字符串，提交 JSON 为字符串，Zod 返回 INVALID_INPUT；正常站点中心也不能还车。
- 建议：在读取边界统一将明确的数值字段转 number，或对本系统有界 DECIMAL 字段启用 decimalNumbers；前端坐标状态也显式 Number(...)，防止其它字符串来源。
- 回归：真实数据库/API GET dashboard，断言 zone.x/y 为 number，然后原样使用站点中心 POST return 成功；浏览器测试通过站点选择/地图点击归还，完全不编辑坐标。

### P2：仅修改围栏半径也覆盖道路长度

已解决（2026-10-04）：server/admin.mjs 分离 coordinatesChanged 与 geometryChanged，仅坐标变化重算边长，半径变化仍执行围栏安全检查。新增真实 MySQL 回归将已有道路设为650米（欧氏400米），仅改半径保持650米，移动终点坐标后变为500米。修复前回归失败：actual400 / expected650；修复后 `node --test tests/admin.test.mjs` 12通过、0失败（23.38秒）。

- 位置：server/admin.mjs:25、30。
- 触发：geometryChanged 包含 radius 差异；对空站仅修改 radius 会执行 road_edges 欧氏距离重算。scripts/seed.mjs:22 的道路长度并非所有都等于端点直线距离（例如1-4存320，直线约314），因此无道路位移也改变路线距离，继而改变订单估算里程和积分。
- 建议：分别计算 coordinatesChanged 与 fenceChanged；两者都使用占位/任务安全检查，但仅 x/y 变化重算道路距离。半径修改不能改路网边属性。
- 回归：空站已有一条非直线长度道路，更新半径后 edge.distance_m 保持原值；更新坐标才重算。

### P2：排队事务继续使用停用前的权限快照

- 位置：server/auth.mjs:16-19；server/business.mjs:7；server/admin.mjs:20-21、51-52、66-67；server/business.mjs:120-126。
- 触发：请求通过 authenticate 的 ACTIVE 检查后，在等待命名锁（或 saveStaff 的 bcrypt）期间被另一管理员停用。后续写事务仍信任 req.user，管理员可以继续新增员工/车辆，普通停用用户仍可报修并锁定可用车辆。startRide 已在事务内检查账户状态，其它这些入口缺少对应检查。
- 建议：每个业务写事务获得命名锁后锁定 actor users 行，重新验证 ACTIVE 与所需 role；不要只依赖 HTTP 请求开始时的快照。返回/支付的停用政策应保持与账号停用限制一致。
- 回归：在有控制的异步屏障中让写请求完成前置鉴权，先提交另一个管理员的停用，再释放原请求获取命名锁；断言原请求403，目标数据和审计无写入。普通报修同样验证。

### P2：运输中取消按钮与服务器状态机不一致

- 位置：src/pages.tsx:608附近（取消按钮条件含 IN_PROGRESS）；server/business.mjs:113-116（取消仅允许 PENDING）。
- 触发：管理员启动调度后界面仍显示“取消”，点击必定 INVALID_STATE。运输车辆已离开源站，服务器选择只允许完成是合理策略，但界面给出不可执行动作。
- 建议：将取消按钮限制为 PENDING，运输中显示“运输中须完成入库”；若要支持运输中取消，需要另行设计并校验源站容量，不能直接恢复车辆造成超容。
- 回归：浏览器验证 PENDING 可取消、IN_PROGRESS 不显示取消，完成操作仍可用。

## 已核查的关键边界与剩余验证

- 所有正常写业务使用同一数据库范围 GET_LOCK，加行锁；调度预留、归还和管理员加车均计 occupied+reserved，未发现现有状态机内的并发超容路径。支付和积分与订单状态同事务，唯一键限制重复记账。
- 围栏拒绝返回错误发生在记录尝试的事务提交之后，骑行保留；坐标来自浏览器的示意模拟已明确，不误称真实GPS。
- STUDENT 的订单、付款、报修、积分明细和违规记录均按本人过滤，staff/dispatches 不返回；排行榜只输出脱敏名，没有邮箱电话。OPERATOR 写操作校验分配给本人的员工记录，ADMIN 也不能替别人归还/支付。
- Dijkstra 使用无向加权图且输出原始边距离；快照只计<=5分钟相邻区间，覆盖缺口不当正常；排行榜通过 PAID且窗口内 ended_at 关联账本，边界按北京时间周一/月初。
- 只读查询确认当前 MySQL session/global time_zone 均为 +00:00；因此当前 CURRENT_TIMESTAMP 与 UTC_TIMESTAMP 一致。createPool 的 timezone:'Z' 只控制驱动日期解码，部署其它 MySQL 时仍应显式保证会话UTC，避免默认DATETIME与UTC结束时间不一致。这是部署前提，不是当前环境已复现故障。
- db.mjs:51-52 在 RELEASE_LOCK 查询失败时未保证 connection.release；建议异常清理使用嵌套 finally。需要模拟释放锁失败的连接测试验证是否导致连接泄漏，未列为当前实际复现的阻塞缺陷。

本审查为静态推导，不替代业务/API/浏览器测试。严重问题已有可定位的输入路径和回归建议，不能仅凭现有测试通过宣告解决。

## 最终整改状态（2026-10-05）

上述四项均已解决。DECIMAL开启明确有界数值解码并经HTTP/真实地图归还验证；半径回归12项管理测试通过；actorTransaction在锁内重验账户，排队停用回归通过；前端取消仅PENDING，调度浏览器流程通过。完整后端46项与浏览器6项通过。额外发现875米减排舍入误差，已使用整数比例计算修复并验证。原发现段落保留为审查历史，不代表仍有未修复阻塞项。SQL表字段和计数实时读取，触发器名称用初始化核验目录展示，无需扩大业务账号DDL权限。
