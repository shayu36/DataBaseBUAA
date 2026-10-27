# 固定接口规范

除特别说明外，路径均加 /api；查询返回 JSON，写入使用 POST JSON。错误格式为 {error,code}；业务字段使用 snake_case，运营筛选参数使用下文列出的 camelCase。id 为数字，金额以整数分表示，日期为 ISO 格式。用户 {id,name,email,phone,role,status} role=STUDENT/ADMIN/OPERATOR，status=ACTIVE/SUSPENDED。除健康检查、登录、注册和退出外，接口均需登录；管理员或运维权限按下文和业务状态检查。前端以响应为准刷新，不伪造成功。

- GET /health {status:'ok',system:'campus-bike'}
- POST /auth/login {email,password} -> {user}; POST /auth/register {name,email,phone,password}->{user}; GET /auth/me->{user}; POST /auth/logout-> {ok:true}。
- GET /dashboard -> {zones,bikes,rides,payments,staff,dispatches,tickets,carbon,summary,attempts}。zones 每行 {id,name,location,x,y,radius,capacity,status,available,occupied,reserved}; bikes {id,code,status,current_zone_id,zone_name,deployed_at,last_service_at}; rides {id,user_id,bike_id,bike_code,start_zone_id,end_zone_id,start_zone_name,end_zone_name,started_at,ended_at,amount_cents,status,distance_m,distance_source,route_mode}; payments {id,order_id,amount_cents,paid_at}; staff {id,user_id,name,phone,job,status}; dispatches {id,staff_id,staff_name,source_zone_id,target_zone_id,source_name,target_name,status,created_at,completed_at,bike_ids:number[]}; tickets {id,bike_id,bike_code,reporter_id,staff_id,staff_name,fault_type,description,status,result,created_at,completed_at}; carbon {points,carbon_kg,distance_m,entries:[{id,order_id,points,carbon_kg,distance_m,created_at}]}; summary {total_bikes,available_bikes,active_rides,today_rides,carbon_kg,open_tickets}; attempts {id,order_id,zone_id,x,y,reason,created_at}。
- POST /rides/start {bike_id} -> {id}
- POST /rides/:id/return {zone_id,x,y,route_mode:'shortest'|'safe'|'comfortable'} -> {id,amount_cents,distance_m}; 坐标按米保留两位小数后用于围栏判断和记录；错误 OUTSIDE_FENCE/ZONE_FULL 保留尝试且订单不结束。
- POST /rides/:id/pay {idempotency_key:string} -> {id,order_id,amount_cents,duplicate:boolean}
- POST /carbon/adjustments {order_id,points_change,carbon_kg_change,reason,idempotency_key}；人工扣减不得超过账户余额，相同请求编号内容不一致返回 `IDEMPOTENCY_CONFLICT`。
- POST /maintenance {bike_id,fault_type:'BRAKE'|'TIRE'|'LOCK'|'CHAIN'|'OTHER',description} -> {id}
- POST /maintenance/:id/assign {staff_id}; POST /maintenance/:id/complete {result}; 都返回 {ok:true}
- POST /analytics/suggestions {days? 或 start/end?,dayType?,startHour?,endHour?,zoneId?} -> {suggestions,filter}；GET /analytics/suggestions -> {suggestions}；POST /analytics/suggestions/:id/dismiss {note} -> {id,status,resolution_note}。均需管理员权限；不执行建议须记录原因。超过 100 辆的分配拆成多条建议；确认升级前的超量建议会将其标记为过期，需重新生成。
- POST /dispatches/from-suggestion/:id {staff_id?} -> {id,suggestion_id}；管理员确认建议时重新校验车辆和目标容量，失效返回 SUGGESTION_STALE。
- POST /dispatches {source_zone_id,target_zone_id,bike_ids:number[],staff_id?:number} -> {id}; POST /dispatches/:id/assign {staff_id}; POST /dispatches/:id/start {}; POST /dispatches/:id/complete {}; POST /dispatches/:id/cancel {} -> {ok:true}
- POST /admin/zones {id?:number,name,location,x,y,radius,capacity,status:'ACTIVE'|'CLOSED'} -> {id}；坐标和半径按米保留两位小数，输入半径最小为 0.005 米；POST /admin/bikes {id?:number,code,zone_id,deployed_at?:string,status?:'AVAILABLE'|'RETIRED'} -> {id}
- POST /admin/staff {name,phone,job:'DISPATCH'|'MAINTENANCE'|'BOTH',status:'ACTIVE'|'OFF_DUTY',email,password?} -> {id}；POST /admin/users/:id/status {status} -> {ok:true}; GET /admin/users -> {users}
- GET /analytics?days=7|30 -> {hotspots:[{zone_id,name,borrow_count,return_count,peak_hour,shortage_minutes,full_minutes,coverage_minutes}],hourly:[{hour,borrow_count,return_count}],suggestions:[{source_zone_id,target_zone_id,source_name,target_name,quantity,reason}],risks:[{bike_id,code,score,level,reasons:string[]}],weekday:[{weekday,borrow_count,return_count}],snapshot_count}
- GET /risks -> {risks}；管理员和运维员可查看。POST /risks/refresh {} -> {created,evaluated,rule_version}，仅管理员可刷新。
- POST /risks/:id/:action {note} -> {id,status,maintenance_ticket_id}；action 为 acknowledge、create_ticket、resolve 或 dismiss；管理员或在岗维修岗位运维员可处理。
- GET /return-attempts -> {attempts}；管理员查看全部，其余用户只查看本人记录。POST /returns/:id/review {action:'RESOLVE'|'DISMISS',note} -> {id,review_status}，仅管理员可复核。
- GET /admin/orders/review -> {orders}；POST /orders/:id/qualification {decision:'VALID'|'EXCLUDED',reason} -> {id,qualification_status}。均需管理员权限。
- GET /admin/roads -> {roads}；POST /admin/roads {id,direction,status,slope_percent,surface,shade_level,lighting_level,traffic_mix,intersection_risk} -> {id}，均需管理员权限。方向为 BOTH/FORWARD/REVERSE，状态为 OPEN/CLOSED/NO_RIDE。
- POST /profile/leaderboard {alias,visible} -> {leaderboard_alias,leaderboard_visible}；昵称为 2–20 字符，visible 为布尔值。
- GET /routes?from=1&to=2&mode=shortest|safe|comfortable -> {nodes:[{id,name,x,y}],edges:[{id,from_node_id,to_node_id,distance_m,safety_cost,comfort_cost}],path:number[],distance_m,duration_minutes,mode}; 同站返回零里程。
- GET /leaderboard?period=week|month&metric=points|distance|rides -> {period,metric,rows:[{rank,user_id,name,rides,distance_m,points,carbon_kg}],me,window}；me 为个人结果，没有有效记录时 rank 为 null；rows 只包含自愿公开的参与者。
- GET /schema -> {entities:[{table,name,description,columns:[{name,type,key,nullable}],count}],relationships:[{name,from,to,cardinality,description}],objects:{views:string[],triggers:string[],procedures:string[]}}
- GET /report -> 报告 HTML；生成报告后也可直接访问不带 /api 前缀的 /docs/ER图.svg 和 /docs/数据库课程设计报告.html。

## analytics.mjs 给后端的导出接口

export function findRoute(nodes,edges,fromId,toId,mode='shortest') -> {path,distance_m,duration_minutes,mode}，无路径抛 Error。
运营筛选可选 `days=7|30`，或同时指定北京时间日期 `start=YYYY-MM-DD` 和 `end=YYYY-MM-DD`；两种周期不可混用。两种周期均可叠加 `dayType=ALL|WEEKDAY|WEEKEND`、`startHour`、`endHour` 和 `zoneId`。小时范围包含起点、不包含终点；自定义日期最多 31 天，当前日期以后的部分会裁剪到当前时刻。

调度建议、风险评分与热点统计分别由 MySQL `sp_dispatch_suggestions`、`sp_risk_inputs` 和 `sp_hotspot_report` 计算。生成调度建议时仅查询库存和借还需求，不计算库存曲线与覆盖时长；使用的筛选范围与完整热点报表相同。快照区间仅计相邻且间隔不超过五分钟的采样，并裁剪到所选北京时间日期和小时。事件及曲线采样的时间范围包含起点、不包含终点；确定边界处的覆盖时长时，可使用截止查询时刻已经存在的相邻区间外快照；仅统计区间内的时长，不将这些快照计入曲线或数量。库存曲线返回的 `segment_id` 基于筛选后的完整采样计算；相邻采样间隔超过五分钟时分段，抽样后不得跨段连线。
排行榜由 MySQL `sp_leaderboard` 按北京时间自然周/月聚合和排名；有效订单按结束时间计数，积分流水按入账时间计入周期。

演示账户 jia@qingxing.local（ADMIN）、ouyang@qingxing.local（STUDENT）、zheng@qingxing.local（OPERATOR BOTH）、wang@qingxing.local（STUDENT）；密码 Qingxing2026!。通过登录页选择演示身份；注册只能 STUDENT。注册、员工密码设置和登录均限制密码的 UTF-8 编码不超过 72 字节，以避免 bcrypt 截断多字节输入。
