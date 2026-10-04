# 共享自行车系统实施计划

**Goal:** 将旧主题完整迁移到可运行、可演示、可验收的共享自行车数据库课程系统。
**Architecture:** 前端通过固定 JSON API 访问数据库事务服务。分析算法独立模块供 API 使用。沿用本地启动基础设施。
**Tech Stack:** React / TypeScript / Express / MySQL 8.0 / node:test / Playwright。
**Spec:** docs/bike-design.md；接口规范 docs/bike-api.md。

## 约束

工作目录 D:\code\mysqpll；保留旧数据库和源码备份；不使用真实支付；本地平面坐标单位米；七项创新全部实现；测试使用独立 campus_bike_test；不读取或输出 .env 秘密。分工文件互斥，使用并行任务技能执行，根代理负责集成。

- [x] 1. 数据库及事务：schema.sql、business.mjs、auth.mjs、app.mjs；测试先覆盖借车竞争、圈外归还记录、超容、幂等支付、调度和维修状态。
- [x] 2. 分析：analytics.mjs 与 analytics.test.mjs；字面量输入验证路线、热点、建议、风险和周月榜。
- [x] 3. 前端：src/ 与 tests/ui.spec.ts；校园地图、骑行面板、管理页、7 项创新页面、数据设计页；真实 API 交互、移动端检查。
- [x] 4. 交付资料：报告、ER图、基本信息、答辩指南、数据库 SQL 案例、参考说明。
- [x] 5. 运行环境：新库初始化、种子数据、备份恢复、启停脚本、只读一致性检查。
- [x] 6. 联调：真实 MySQL 集成测试、前端编译、真实浏览器端到端与截图、备份恢复演练；审查修复后更新测试报告和打包。

验收证据见docs/测试报告.md及docs/evidence。最终交付包生成后记录在deliverables/交付清单.json。
