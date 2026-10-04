# 固定接口规范

所有路径加 /api，GET JSON，写入用 POST JSON。错误 {error,code}，数据 snake_case；id 数字，金额分整数，日期 ISO。用户 {id,name,email,phone,role,status} role=STUDENT/ADMIN/OPERATOR，status=ACTIVE/SUSPENDED。前端以响应为准刷新，不伪造成功。

- GET /health {status:'ok',system:'campus-bike'}
- POST /auth/login {email,password} -> {user}; POST /auth/register {name,email,phone,password}->{user}; GET /auth/me->{user}; POST /auth/logout-> {ok:true}。
- GET /dashboard -> {zones,bikes,rides,payments,staff,dispatches,tickets,carbon,summary,attempts}。zones 每行 {id,name,location,x,y,radius,capacity,status,available,occupied,reserved}; bikes {id,code,status,current_zone_id,zone_name,deployed_at,last_service_at}; rides {id,user_id,bike_id,bike_code,start_zone_id,end_zone_id,start_zone_name,end_zone_name,started_at,ended_at,amount_cents,status,distance_m,distance_source,route_mode}; payments {id,order_id,amount_cents,paid_at}; staff {id,user_id,name,phone,job,status}; dispatches {id,staff_id,staff_name,source_zone_id,target_zone_id,source_name,target_name,status,created_at,completed_at,bike_ids:number[]}; tickets {id,bike_id,bike_code,reporter_id,staff_id,staff_name,fault_type,description,status,result,created_at,completed_at}; carbon {points,carbon_kg,distance_m,entries:[{id,order_id,points,carbon_kg,distance_m,created_at}]}; summary {total_bikes,available_bikes,active_rides,today_rides,carbon_kg,open_tickets}; attempts {id,order_id,zone_id,x,y,reason,created_at}。
- POST /rides/start {bike_id} -> {id}
- POST /rides/:id/return {zone_id,x,y,route_mode:'shortest'|'safe'|'comfortable'} -> {id,amount_cents,distance_m}; 错误 OUTSIDE_FENCE/ZONE_FULL 保留尝试且订单不结束。
- POST /rides/:id/pay {idempotency_key:string} -> {id,order_id,amount_cents,duplicate:boolean}
- POST /maintenance {bike_id,fault_type:'BRAKE'|'TIRE'|'LOCK'|'CHAIN'|'OTHER',description} -> {id}
- POST /maintenance/:id/assign {staff_id}; POST /maintenance/:id/complete {result}; 都返回 {ok:true}
- POST /dispatches {source_zone_id,target_zone_id,bike_ids:number[],staff_id?:number} -> {id}; POST /dispatches/:id/assign {staff_id}; POST /dispatches/:id/start {}; POST /dispatches/:id/complete {}; POST /dispatches/:id/cancel {} -> {ok:true}
- POST /admin/zones {id?:number,name,location,x,y,radius,capacity,status:'ACTIVE'|'CLOSED'} -> {id}；POST /admin/bikes {id?:number,code,zone_id,deployed_at?:string,status?:'AVAILABLE'|'RETIRED'} -> {id}
- POST /admin/staff {name,phone,job:'DISPATCH'|'MAINTENANCE'|'BOTH',status:'ACTIVE'|'OFF_DUTY',email,password?} -> {id}；POST /admin/users/:id/status {status} -> {ok:true}; GET /admin/users -> {users}
- GET /analytics?days=7|30 -> {hotspots:[{zone_id,name,borrow_count,return_count,peak_hour,shortage_minutes,full_minutes,coverage_minutes}],hourly:[{hour,borrow_count,return_count}],suggestions:[{source_zone_id,target_zone_id,source_name,target_name,quantity,reason}],risks:[{bike_id,code,score,level,reasons:string[]}],weekday:[{weekday,borrow_count,return_count}],snapshot_count}
- GET /routes?from=1&to=2&mode=shortest|safe|comfortable -> {nodes:[{id,name,x,y}],edges:[{id,from_node_id,to_node_id,distance_m,safety_cost,comfort_cost}],path:number[],distance_m,duration_minutes,mode}; 同站返回零里程。
- GET /leaderboard?period=week|month&metric=points|distance|rides -> {period,metric,rows:[{rank,user_id,name,rides,distance_m,points,carbon_kg}]}
- GET /schema -> {entities:[{table,name,description,columns:[{name,type,key,nullable}],count}],relationships:[{name,from,to,cardinality,description}],objects:{views:string[],triggers:string[],procedures:string[]}}
- GET /report -> 报告 HTML；静态 /docs/ER图.svg 可打开。

## analytics.mjs 给后端的导出接口

export function findRoute(nodes,edges,fromId,toId,mode='shortest') -> {path,distance_m,duration_minutes,mode}，无路径抛 Error。
export function dispatchSuggestions(zones, demand=[]) -> suggestions。demand 行 {zone_id,borrow_count,return_count}。occupied/reserved 已含预留；quantity 不能超可用车和目标剩余车位。
export function bikeRisks(bikes,tickets,now=new Date()) -> risks。
export function aggregateHotspots(zones,rides,snapshots,days=7,now=new Date()) -> {hotspots,hourly,weekday,snapshot_count}。快照行 {zone_id,available,occupied,capacity,captured_at}。采样区间仅计相邻快照且差距<=5分钟；北京时间小时/工作日。
export function buildLeaderboard(users,rides,entries,period='week',metric='points',now=new Date()) -> {period,metric,rows}。周一/每月1日北京时间起算；只计 PAID 且 ended_at 在窗口的订单，榜单姓名脱敏。

演示账户 jia@qingxing.local（ADMIN）、ouyang@qingxing.local（STUDENT）、zheng@qingxing.local（OPERATOR BOTH）、wang@qingxing.local（STUDENT）；密码 Qingxing2026!。通过登录页选择演示身份；注册只能 STUDENT。
