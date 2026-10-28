# 青行校园共享自行车系统

青行是校园共享自行车课程项目，支持借车、围栏还车、模拟支付、维修、调度和运营分析。前端使用 React，后端使用 Express，数据库使用 MySQL。地图、定位、支付和碳减排均为教学模拟。

## 环境要求

- Linux 或 Windows 11。
- Node.js 22.12 及以上版本，以及随 Node.js 安装的 npm。
- 已启动的本机 MySQL 8.0.21 及以上版本；初始化账号需要建库、建用户和授权权限。
- 仅在生成交付压缩包时需要 Python 和 uv。

不需要 Docker。MySQL 版本要求与 `JSON_TABLE` 对 JSON 空值的处理有关，详见 [MySQL 官方手册](https://dev.mysql.com/doc/refman/8.0/en/json-table-functions.html)。数据库默认时间使用 MySQL 的 [表达式默认值](https://dev.mysql.com/doc/refman/8.0/en/data-type-defaults.html)。

## 首次启动

在项目根目录执行：

```text
npm ci
```

将 `.env.example` 复制为 `.env`。以下命令在 Linux 和 Windows 11 均可使用；若 `.env` 已存在，命令会停止，避免覆盖原配置。

```text
node -e "require('fs').copyFileSync('.env.example','.env',require('fs').constants.COPYFILE_EXCL)"
```

编辑 `.env`，至少填写以下配置：

| 配置项 | 含义 |
|---|---|
| `DB_HOST`、`DB_PORT` | 本机 MySQL 地址和端口；默认分别为 `127.0.0.1`、`3306` |
| `DB_ADMIN_USER`、`DB_ADMIN_PASSWORD` | 本机 MySQL 管理员账号和密码 |
| `DB_USER`、`DB_PASSWORD` | 应用账号及密码；自动初始化时账号名固定为 `qingxing_app` |
| `DB_NAME` | 业务库名，自动初始化时固定为 `campus_bike` |
| `JWT_SECRET` | 至少 32 个字符的随机会话密钥 |
| `HOST`、`PORT` | 应用监听地址和端口，默认 `127.0.0.1:5188` |

可以用下面的命令生成会话密钥，将输出复制到 `.env` 的 `JWT_SECRET` 中：

```text
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

确认 MySQL 已启动，然后执行：

```text
npm run db:seed
npm run build
npm start
```

初始化会创建业务库 `campus_bike`、测试库 `campus_bike_test` 和业务账号；已有同名应用账号的密码不会被修改，必须与 `.env` 中一致。演示数据只在空库首次写入，重复初始化不会重置已有业务数据。构建同时生成前端页面和课程报告。浏览器访问 `http://127.0.0.1:5188`；在运行终端按 `Ctrl+C` 停止应用。

## 演示账号

| 身份 | 邮箱 | 演示密码 |
|---|---|---|
| 管理员 | `jia@qingxing.local` | `Qingxing2026!` |
| 学生 | `ouyang@qingxing.local` | `Qingxing2026!` |
| 运维员 | `zheng@qingxing.local` | `Qingxing2026!` |
| 学生 | `wang@qingxing.local` | `Qingxing2026!` |

这些账号仅供本机演示。普通注册只能创建学生账号；管理员可创建运维账号。

## 主要功能

- 学生借车、地图选点还车、模拟支付、个人订单和碳积分流水；历史订单可按状态筛选并完整导出，人工扣减不会使账户对应余额为负，重复请求编号须对应相同调整。
- 管理员维护停车区、车辆、道路、员工及账号状态，处理还车记录和订单资格复核。
- 运维员处理分配给自己的维修和调度任务，并处置车辆风险告警。
- 运营分析支持日期、工作日、小时和站点筛选；调度建议可以保存、确认或记录原因后不执行。
- 调度任务记录创建、出发和完成后的两站库存；旧任务缺失历史快照时显示未采集。
- 路网支持最短、安全和舒适三种路线；排行榜支持个人昵称、公开设置和私密名次。

数据库结构、读写查询、存储过程、迁移和种子数据均位于 `database/`。后端负责身份验证、参数校验、事务边界和路线图计算；前端负责交互与展示。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run db:seed` | 初始化数据库并幂等写入演示数据 |
| `npm run db:migrate` | 升级已有数据库并更新存储过程 |
| `npm run build` | 生成课程报告和前端构建结果 |
| `npm start` | 启动后端和已构建的前端 |
| `npm run dev` | 启动前端开发服务，地址为 `http://127.0.0.1:5189` |
| `npm test` | 运行后端和数据库测试 |
| `npm run test:e2e` | 运行浏览器测试 |
| `npm run format:check` | 检查代码格式 |
| `npm run check` | 检查业务数据不变量 |
| `npm run backup` | 备份当前业务数据库 |
| `npm run snapshot` | 导出当前业务库到本机 `database/demo-snapshot.sql`，成功时替换旧快照 |
| `npm run report` | 单独生成课程报告和实体关系图 |
| `uv run python scripts/package-project.py` | 生成不含本机凭据和临时数据的交付包；先运行 `npm run build` |
| `uv run python -m unittest discover -s tests -p package_project_test.py` | 验证交付包筛选和失败保护 |

开发服务将接口代理到 `127.0.0.1:5188`，使用 `npm run dev` 前需另开终端运行后端。浏览器测试同样需要后端已经启动。测试会重建 `campus_bike_test` 的测试数据；浏览器测试会在演示库中创建测试行程、工单和任务。

## 备份与恢复

对已有数据执行初始化或迁移前，先停止应用并运行 `npm run backup`；迁移会重建数据库过程，完成后再启动应用。备份和恢复需要 `mysql`、`mysqldump` 在系统路径中，也可以把 `MYSQL_BASE` 设置为 MySQL 安装目录。

```text
npm run backup
node scripts/restore.mjs backups/备份文件.sql campus_bike_restore_demo
node scripts/check.mjs campus_bike_restore_demo
```

备份和演示快照持有数据库结构锁，与项目初始化、演示数据初始化和迁移互斥；业务写入可以继续，InnoDB 数据由一致性事务导出，见 [MySQL 备份工具说明](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html)。本机快照不会随代码升级自动更新；需要当前结构时应重新生成，且快照包含当时的业务数据，不提交 Git 或放入交付包。结构锁等待最多 10 秒，超时需要稍后重试。直接连接数据库执行的外部 SQL 不受项目锁约束，备份时应自行停止外部结构变更。导出先写入同目录临时文件，成功、文件非空且确认释放锁后才发布；失败时保留已有快照。恢复目标必须是尚不存在的 `campus_bike_restore_` 前缀数据库。只导入可信的项目备份：脚本会以管理员权限执行 SQL，简单的切库语句检查不能隔离任意 SQL 或保证其他数据库不受影响。输入、输出或 MySQL 命令失败时，脚本会报告错误；恢复失败可能留下不完整的目标库，应检查后另选新库重试。MySQL 结构变更会隐式提交；迁移失败时应检查错误并从备份恢复，不能依赖事务回滚已完成的结构变更。员工姓名和电话统一保存在用户表；升级时若旧员工表中的姓名或电话与用户表不一致，迁移会报 `STAFF_NAME_MISMATCH` 或 `STAFF_PHONE_MISMATCH` 并停止。请先根据备份人工核对差异，再修正旧表或用户表后重新迁移。新版数据库使用 UTC 默认时间，不依赖 MySQL 服务器时区；迁移不修改历史时间，若旧库使用过非 UTC 服务器时区，应根据原始环境和备份核对历史记录。积分页面显示数据库中的当前碳系数、每公里积分和规则版本；新版积分发放会保存当时的精确碳系数和积分比例；旧流水中未记录的比例保留为空，旧版已舍入的系数无法还原。若历史系数与已发放减排量不一致，不变量检查会提示人工核对。


旧版员工表仍含 `name` 和 `phone` 时，可在 MySQL 中查询需要核对的记录：

```sql
SELECT s.id, s.name AS 员工表姓名, u.name AS 用户表姓名,
       s.phone AS 员工表电话, u.phone AS 用户表电话
FROM staff s LEFT JOIN users u ON u.id = s.user_id
WHERE u.id IS NULL OR NOT (BINARY s.name <=> BINARY u.name)
   OR NOT (BINARY s.phone <=> BINARY u.phone);
```

该查询仅用于尚未完成员工字段迁移的旧库；迁移完成后，姓名和电话只存在于用户表。

## 目录与文档

| 路径 | 内容 |
|---|---|
| `frontend/` | 前端页面、组件和样式 |
| `backend/` | 接口、权限、事务和数据库调用 |
| `database/` | MySQL 表结构、按业务拆分的存储过程、迁移和查询 |
| `scripts/` | 初始化、备份、恢复、验证和报告生成脚本 |
| `tests/` | 自动化测试和浏览器测试 |
| `docs/` | 需求、接口、课程设计、测试和答辩文档 |

本机凭据、依赖、构建结果、数据库快照、备份、截图、测试日志和交付包均不提交到 Git；对应文件可通过上述命令重新生成。交付包按目录和文件类型筛选项目文件及必要的前端构建结果，排除隐藏文件、符号链接和常见缓存，并检查当前 `.env` 和环境变量中配置的数据库密码与会话密钥；新增其他类型的项目文件时应更新打包脚本的类型列表。校验失败不会覆盖已有交付包。

## 数据与性能边界

校园道路、定位、支付、风险规则和碳系数均为教学模拟。计费固定为每开始 30 分钟 100 分，风险规则固定使用近 30 天窗口；旧库中遗留的 `pricing`、`risk` 配置行不会改变这些规则。库存持续时间只按相邻且间隔不超过五分钟的快照估计，缺失时间不视为正常；曲线按完整采样中的缺口分段，大样本会保留首尾和极值并抽样，统计仍使用完整数据。写事务使用数据库命名锁串行化，适合课程规模，尚未进行生产规模负载测试。

当前已在 Linux 和本机 MySQL 上完成运行、自动化测试及独立恢复验证；Windows 11 尚未实机验收。原始课程材料并未全部提供，因此不能对未提供的评分要求作完整性保证。
