# 青行 Qingxing · 校园共享自行车系统

授权依据：用户要求在 D:\code\mysqpll 彻底实现新主题，落实三张图中的实体、联系、创新点。日期 2026-10-04。

## 设计与边界

沿用 React 19 + TypeScript + Vite、Express 5、MySQL 8.0。独立库 campus_bike，测试库 campus_bike_test；旧 mysqpll 数据库保留。源码已压缩备份至 backups/legacy-web3-source-20261004.zip。

校园示意图采用以米为单位的本地平面坐标，停车区为圆形电子围栏；不声称真实 GPS、支付、碳核证。路网由可审计道路节点、边长和安全/舒适权重组成。行程里程取归还时服务器计算的所选路网路线估算长度，保存 distance_source=ROUTE_ESTIMATE，不信任客户端里程。金额用整数分保存，每开始 30 分钟 100 分，至少 100 分；积分仅成功支付时记一笔，10 分/公里取整，模拟减排系数 0.21 kg/km。

8 个核心实体：users、bikes、parking_zones、ride_orders、payments、staff、dispatch_tasks、maintenance_tickets。dispatch_bikes 实现任务与车辆 M:N。支持表 zone_snapshots、return_attempts、road_nodes、road_edges、carbon_ledger、audit_logs、system_settings。

所有写业务事务持有数据库命名锁 campus-bike:<db> 并对受影响行加锁。课堂规模串行化换取清晰的防超借、防超容、支付幂等和任务状态一致性。唯一生成列限制用户/车辆只能有一笔 RUNNING 订单；payments.order_id 和 carbon_ledger.order_id 唯一；维护工单同车至多一笔未完成。调度创建即锁定车辆及目标车位，PENDING 时车在源站，IN_PROGRESS 车无当前站，完成后落到目标站；取消恢复源站。归还校验计入目标站预留车位。

ADMIN 管理车辆、站点、员工、任务及账户；OPERATOR 仅处理分配给自己的任务和工单；STUDENT 仅查看/操作自己的骑行与报修。统计不向学生公开他人的电话等信息。

## 7 项创新验收

1. 热点：近 7/30 日按工作日、小时聚合借还量，库存快照估计缺车/满车时间并显示采样覆盖；缺失时间不当作正常。
2. 调度：可用量、容量、历史借车需求生成来源、目标和数量建议；管理员确认后建任务，执行至完成。
3. 风险：近期报修、同类型复发、距维修时间规则评分，返回每条原因，明确非学习模型。
4. 路线：Dijkstra 支持 shortest/safe/comfortable，图中高亮节点路线，里程来源明确。
5. 碳积分：支付事务内一次性记账，订单关联，可追溯模拟规则。
6. 排行榜：按周/月的已支付骑行次数、里程和积分排名，默认使用脱敏显示名。
7. 电子围栏：圈外拒绝结束订单但独立提交违规尝试，圈内且有车位才归还。

## 课程材料

保留四位成员贾鑫洋、欧阳晨、郑一凡、王奕。报告含需求、E-R、关系模式、数据字典、候选码/函数依赖/3NF/BCNF、约束、索引、视图、触发器、存储过程、查询、事务/并发、权限、备份恢复、测试、分工与演示。引用聊天仅可见缓存摘要，课程 PPT 原文无法从当前工具取得，因此不声称已逐页核对。参考项目作为思路来源，记录具体参考内容及差异，不复制其成品代码。
