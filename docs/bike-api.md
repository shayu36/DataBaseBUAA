# 固定接口规范

除特别说明外，路径均加 /api；查询返回 JSON，写入使用 POST JSON。错误格式为 {error,code}；业务字段使用 snake_case，运营筛选参数使用下文列出的 camelCase。id 为数字，金额以整数分表示，日期为 ISO 格式。用户 {id,name,email,phone,role,status} role=STUDENT/ADMIN/OPERATOR，status=ACTIVE/SUSPENDED。除健康检查、登录、注册和退出外，接口均需登录；管理员或运维权限按下文和业务状态检查。前端以响应为准刷新，不伪造成功；写入成功但刷新失败时保留保存成功的结果并提示手动刷新，刷新成功或重新刷新时清除旧提示。

压缩请求内容损坏时返回 HTTP 400 和 `INVALID_COMPRESSED_BODY`；不支持的内容编码或字符编码分别返回 HTTP 415 和 `UNSUPPORTED_CONTENT_ENCODING`、`UNSUPPORTED_CHARSET`。

碳规则配置无效时，读取该规则的请求返回 HTTP 503 和 `INVALID_CARBON_RULE`；涉及写入的事务回滚。已完成支付的幂等重试仍返回原支付结果。配置范围和缺省值见 README。

行程按当前规则计算出的积分或减排量超出流水字段范围时，支付或确认有效行程返回 HTTP 503 和 `CARBON_AWARD_OUT_OF_RANGE`，事务回滚；具体范围和处理方法见 README。

为保留八位小数精度，`/dashboard` 中 `carbon.rule.kg_per_km` 和 `points_per_km` 是十进制字符串；`/dashboard` 及 `/carbon/entries` 中流水的 `factor_kg_per_km`、`points_per_km` 也是十进制字符串，历史未知的 `points_per_km` 为 null。人工调整幂等重试返回的流水包含相同类型的系数和比例字段。

- GET /health {status:'ok',system:'campus-bike'}
- POST /auth/login {email,password} -> {user}; POST /auth/register {name,email,phone,password}->{user}; GET /auth/me->{user}; POST /auth/logout-> {ok:true}。
- GET /dashboard -> {zones,bikes,rides,rides_next_before,actionable_rides,payments,payments_next_before,staff,dispatches,dispatches_next_before,tickets,tickets_next_before,carbon,summary,attempts,attempts_next_before}。zones 每行 {id,name,location,x,y,radius,capacity,status,available,occupied,reserved}; bikes {id,code,status,current_zone_id,zone_name,deployed_at,last_service_at}; rides {id,user_id,bike_id,bike_code,start_zone_id,end_zone_id,start_zone_name,end_zone_name,started_at,ended_at,amount_cents,status,distance_m,distance_source,route_mode} 为本人订单第一页，actionable_rides 包含全部本人进行中及待支付订单；payments {id,order_id,amount_cents,paid_at} 为本人支付第一页；staff {id,user_id,name,phone,job,status}; dispatches {id,staff_id,staff_name,source_zone_id,target_zone_id,source_name,target_name,status,created_at,completed_at,bike_ids:number[]}; tickets {id,bike_id,bike_code,reporter_id,staff_id,staff_name,fault_type,description,status,result,created_at,completed_at}；调度和工单均包含全部未完成记录与已结束历史的第一页，历史游标分别为 dispatches_next_before 和 tickets_next_before；carbon {points,carbon_kg,distance_m,ride_count,rule:{kg_per_km,points_per_km,rule_version},entries,entries_next_before}；rule 是当前生效的数据库配置，缺省时使用 0.21 kg/km、每公里 10 分及 carbon-v1；历史流水保留发放时的规则快照。积分和减排为流水净额，里程和行程数只统计有效已支付订单的发放，entries 为本人的第一页流水；summary {total_bikes,available_bikes,active_rides,today_rides,carbon_kg,open_tickets} 中 today_rides 统计北京时间当日零点至查询时刻（含边界）的开始骑行数，不计未来记录；attempts {id,order_id,zone_id,x,y,reason,created_at} 为本人的第一页记录，可使用 attempts_next_before 获取后续页。
- POST /rides/start {bike_id} -> {id}
- GET /rides?status=ALL|RUNNING|UNPAID|PAID&before=编号 -> {rides,next_before}；GET /payments?before=编号 -> {payments,next_before}。均只返回本人数据，按编号倒序每页最多 100 条，next_before 为 null 表示结束。
- GET /rides/export.csv?status=ALL|RUNNING|UNPAID|PAID 流式导出符合条件的全部本人订单，包含表头和 UTF-8 字节顺序标记，并处理电子表格公式前缀。
- POST /rides/:id/return {zone_id,x,y,route_mode:'shortest'|'safe'|'comfortable'} -> {id,amount_cents,distance_m}; 坐标按米保留两位小数后用于围栏判断和记录；错误 OUTSIDE_FENCE/ZONE_FULL 保留尝试且订单不结束。
- POST /rides/:id/pay {idempotency_key:string} -> {id,order_id,amount_cents,duplicate:boolean}；请求编号为 8–80 位英文字母、数字、下划线或连字符，区分字母大小写。
- POST /carbon/adjustments {order_id,points_change,carbon_kg_change,reason,idempotency_key}；减排量在 -1000 至 1000 范围内且最多四位有效小数，精度无效返回 HTTP 400 和 `INVALID_ADJUSTMENT_AMOUNT`；请求编号遵循相同字符、长度和大小写规则，人工扣减不得超过账户余额，相同请求编号内容不一致返回 `IDEMPOTENCY_CONFLICT`。
- GET /carbon/entries?before=编号 -> {entries,next_before}；仅返回当前用户的积分流水，按编号倒序每页最多 100 条，使用 next_before 获取更早记录，null 表示结束。
- POST /maintenance {bike_id,fault_type:'BRAKE'|'TIRE'|'LOCK'|'CHAIN'|'OTHER',description} -> {id}
- GET /maintenance?before=编号 -> {tickets,next_before}；返回已完成工单历史，学生仅查看本人报修，管理员和运维员可查看全部。按编号倒序每页最多 100 条，null 表示结束。
- POST /maintenance/:id/assign {staff_id}; POST /maintenance/:id/complete {result}; 都返回 {ok:true}
- POST /analytics/suggestions {days? 或 start/end?,dayType?,startHour?,endHour?,zoneId?} -> {suggestions,filter}；GET /analytics/suggestions?before=编号 -> {suggestions,next_before}，按编号倒序返回最多 100 条，使用返回的 next_before 获取更早记录，null 表示结束；POST /analytics/suggestions/:id/dismiss {note} -> {id,status,resolution_note}。均需管理员权限；不执行建议须记录原因。每条建议包含 source_available、target_occupied、target_capacity、target_reserved、borrow_count、return_count 和 desired_inventory，记录生成时的库存与需求依据；超过 100 辆的分配拆成多条建议；确认升级前的超量建议会将其标记为过期，需重新生成。
- POST /dispatches/from-suggestion/:id {staff_id?} -> {id,suggestion_id}；管理员确认建议时重新校验车辆和目标容量，失效返回 SUGGESTION_STALE。确认时 MySQL 核对任务待执行、调出站、调入站和车辆数量均与建议一致，异常分别返回 `SUGGESTION_TASK_MISMATCH` 或 `SUGGESTION_TASK_LINKED` 并回滚；确认后任务与建议一对一关联，数据库约束阻止同一任务被多条建议引用。
- POST /dispatches {source_zone_id,target_zone_id,bike_ids:number[],staff_id?:number} -> {id}；bike_ids 须为 1–100 个不重复正整数车辆编号，数据库存储过程也会校验车辆列表及元素类型； POST /dispatches/:id/assign {staff_id}; POST /dispatches/:id/start {}; POST /dispatches/:id/complete {}; POST /dispatches/:id/cancel {} -> {ok:true}
- GET /dispatches?before=编号 -> {dispatches,next_before}；管理员和运维员按编号倒序查看已完成或已取消任务，每页最多 100 条，null 表示结束。
- POST /admin/zones {id?:number,name,location,x,y,radius,capacity,status:'ACTIVE'|'CLOSED'} -> {id}；坐标和半径按米保留两位小数，输入半径最小为 0.005 米；POST /admin/bikes {id?:number,code,zone_id,deployed_at?:string,status?:'AVAILABLE'|'RETIRED'} -> {id}
- POST /admin/staff {name,phone,job:'DISPATCH'|'MAINTENANCE'|'BOTH',status:'ACTIVE'|'OFF_DUTY',email,password?} -> {id}；POST /admin/users/:id/status {status} -> {ok:true}；GET /admin/users?before=编号 -> {users,next_before}，账户按编号倒序每页最多 100 条，使用 next_before 获取更早记录，null 表示结束。
- GET /analytics?days=7|30 -> {hotspots:[{zone_id,name,borrow_count,return_count,peak_hour,shortage_minutes,full_minutes,coverage_minutes}],hourly:[{hour,borrow_count,return_count}],suggestions:[{source_zone_id,target_zone_id,source_name,target_name,quantity,source_available,target_occupied,target_capacity,target_reserved,borrow_count,return_count,desired_inventory,reason}],saved_suggestions,saved_suggestions_next_before,risk_alerts,risk_alerts_next_before,risks:[{bike_id,code,score,level,reasons:string[]}],weekday:[{weekday,borrow_count,return_count}],snapshot_count}；保存的建议和风险告警返回第一页及后续游标。
- GET /risks?before=编号 -> {risks,next_before}；管理员和运维员可查看。每页按编号倒序最多 100 条，使用 next_before 获取更早记录，null 表示结束。POST /risks/refresh {} -> {created,evaluated,rule_version}，仅管理员可刷新。
- POST /risks/:id/:action {note} -> {id,status,maintenance_ticket_id}；action 为 acknowledge、create_ticket、resolve 或 dismiss；管理员或在岗维修岗位运维员可处理。生成工单时复用同车未完成工单；已关联工单完成后再次操作会复用当前未完成工单或新建工单，历史关联保留在审计记录中。
- GET /return-attempts?scope=own|all&before=编号 -> {attempts,next_before}；管理员默认查看全部，也可选 own 查看本人记录；其他用户只能查看本人记录。每页按编号倒序最多 100 条，使用 next_before 获取更早记录，null 表示结束。POST /returns/:id/review {action:'RESOLVE'|'DISMISS',note} -> {id,review_status}，仅管理员可复核。
- GET /admin/orders/review?before=编号 -> {orders,next_before}；待复核订单按编号倒序每页最多 100 条，使用 next_before 获取更早记录，null 表示结束。POST /orders/:id/qualification {decision:'VALID'|'EXCLUDED',reason} -> {id,qualification_status}。均需管理员权限。
- GET /admin/roads -> {roads}；POST /admin/roads {id,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk} -> {id}，均需管理员权限。方向为 BOTH/FORWARD/REVERSE，状态为 OPEN/CLOSED/NO_RIDE。坡度以道路的 from_node_id 至 to_node_id 为正向，入库保留两位小数；修改坡度、路面、遮阴、照明、混行或风险属性后，来源标为课程模拟，只有方向或状态变化时保留原来源。审计同时保存修改前、实际入库结果和校验后的请求。
- POST /profile/leaderboard {alias,visible} -> {leaderboard_alias,leaderboard_visible}；昵称为 2–20 字符，visible 为布尔值。
- GET /routes?from=1&to=2&mode=shortest|safe|comfortable -> {nodes:[{id,name,x,y}],edges:[{id,from_node_id,to_node_id,distance_m,safety_cost,comfort_cost}],path:number[],segments,distance_m,duration_minutes,mode}；同站返回零里程和空路段。`segments` 的 `from_node_id`、`to_node_id` 按实际行驶顺序排列，`slope_percent` 按该行驶方向表示；`road_from_node_id`、`road_to_node_id` 是数据库中的道路原始起终点，`direction` 是相对于这两个原始端点的通行规则。反向行驶时路段坡度与原始道路坡度符号相反。
- GET /routes?from=1&to=2&mode=all -> {nodes,edges,routes:{shortest,safe,comfortable}}；三个结果与单模式接口的路线字段一致，共用同一份 MySQL 一致性快照读取的路网。无可通行路线返回 `NO_ROUTE`，同站三个结果均为零里程。
- GET /leaderboard?period=week|month&metric=points|distance|rides -> {period,metric,rows:[{rank,user_id,name,rides,distance_m,points,carbon_kg}],me,window}；me 为个人结果，没有有效记录时 rank 为 null；rows 只包含自愿公开的参与者。
- GET /schema -> {entities:[{table,name,description,columns:[{name,type,key,nullable}],count}],relationships:[{name,from,to,cardinality,description}],objects:{views:string[],triggers:string[],procedures:string[]}}
- GET /report -> 报告 HTML；生成报告后也可直接访问不带 /api 前缀的 /docs/ER图.svg 和 /docs/数据库课程设计报告.html；其他文档路径返回 404。

## analytics.mjs 给后端的导出接口

export function findRoute(nodes,edges,fromId,toId,mode='shortest') -> {path,distance_m,duration_minutes,mode}，无路径抛 Error。
运营筛选可选 `days=7|30`，或同时指定北京时间日期 `start=YYYY-MM-DD` 和 `end=YYYY-MM-DD`；两种周期不可混用。两种周期均可叠加 `dayType=ALL|WEEKDAY|WEEKEND`、`startHour`、`endHour` 和 `zoneId`。小时范围包含起点、不包含终点；自定义日期最多 31 天，当前日期以后的部分会裁剪到当前时刻。

调度建议、风险评分与热点统计分别由 MySQL `sp_dispatch_suggestions`、`sp_risk_inputs` 和 `sp_hotspot_report` 计算。生成调度建议时仅查询库存和借还需求，不计算库存曲线与覆盖时长；使用的筛选范围与完整热点报表相同。快照区间仅计相邻且间隔不超过五分钟的采样，并裁剪到所选北京时间日期和小时。借还汇总、高峰小时与覆盖率均由 MySQL 计算，覆盖率先根据原始微秒时长计算，再以十进制四舍五入保留两位小数；展示的分钟数也仅在输出时舍入。事件及曲线采样的时间范围包含起点、不包含终点；确定边界处的覆盖时长时，可使用截止查询时刻已经存在的相邻区间外快照；仅统计区间内的时长，不将这些快照计入曲线或数量。库存曲线返回的 `segment_id` 基于筛选后的完整采样计算；相邻采样间隔超过五分钟时分段，抽样后不得跨段连线。
排行榜由 MySQL `sp_leaderboard` 按北京时间自然周/月聚合和排名；有效订单按结束时间计数，积分流水按入账时间计入周期。

演示账户 jia@qingxing.local（ADMIN）、ouyang@qingxing.local（STUDENT）、zheng@qingxing.local（OPERATOR BOTH）、wang@qingxing.local（STUDENT）；密码 Qingxing2026!。通过登录页选择演示身份；注册只能 STUDENT。注册、员工密码设置和登录均限制密码的 UTF-8 编码不超过 72 字节，以避免 bcrypt 截断多字节输入。
