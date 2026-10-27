# 青行校园共享自行车系统

青行是校园共享自行车课程项目，支持借车、围栏还车、模拟支付、维修、调度和运营分析。前端使用 React，后端使用 Express，数据库使用 MySQL。地图、定位、支付和碳减排均为教学模拟。

## 环境要求

- Linux 或 Windows 11。
- Node.js 22.12 及以上版本，以及随 Node.js 安装的 npm。
- 已启动的本机 MySQL 8.0.21 及以上版本；初始化账号需要建库、建用户和授权权限。
- 仅在生成交付压缩包时需要 Python 和 uv。

不需要 Docker。MySQL 版本要求与 `JSON_TABLE` 对 JSON 空值的处理有关，详见 [MySQL 官方手册](https://dev.mysql.com/doc/refman/8.0/en/json-table-functions.html)。

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

- 学生借车、地图选点还车、模拟支付、个人订单和碳积分流水；人工扣减不会使账户对应余额为负，重复请求编号须对应相同调整。
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
| `npm run report` | 单独生成课程报告和实体关系图 |
| `uv run python scripts/package-project.py` | 生成不含本机凭据和临时数据的交付包；先运行 `npm run build` |

开发服务将接口代理到 `127.0.0.1:5188`，使用 `npm run dev` 前需另开终端运行后端。浏览器测试同样需要后端已经启动。测试会重建 `campus_bike_test` 的测试数据；浏览器测试会在演示库中创建测试行程、工单和任务。

## 备份与恢复

对已有数据执行初始化或迁移前，先停止应用并运行 `npm run backup`；迁移会重建数据库过程，完成后再启动应用。备份和恢复需要 `mysql`、`mysqldump` 在系统路径中，也可以把 `MYSQL_BASE` 设置为 MySQL 安装目录。

```text
npm run backup
node scripts/restore.mjs backups/备份文件.sql campus_bike_restore_demo
node scripts/check.mjs campus_bike_restore_demo
```

恢复目标必须是尚不存在的 `campus_bike_restore_` 前缀数据库。MySQL 结构变更会隐式提交；迁移失败时应检查错误并从备份恢复，不能依赖事务回滚已完成的结构变更。

## 目录与文档

| 路径 | 内容 |
|---|---|
| `frontend/` | 前端页面、组件和样式 |
| `backend/` | 接口、权限、事务和数据库调用 |
| `database/` | MySQL 表结构、按业务拆分的存储过程、迁移和查询 |
| `scripts/` | 初始化、备份、恢复、验证和报告生成脚本 |
| `tests/` | 自动化测试和浏览器测试 |
| `docs/` | 需求、接口、课程设计、测试和答辩文档 |

本机凭据、依赖、构建结果、数据库快照、备份、截图、测试日志和交付包均不提交到 Git；对应文件可通过上述命令重新生成。

## 数据与性能边界

校园道路、定位、支付、风险规则和碳系数均为教学模拟。库存持续时间只按相邻且间隔不超过五分钟的快照估计，缺失时间不视为正常；曲线大样本会保留首尾和极值并抽样，统计仍使用完整数据。写事务使用数据库命名锁串行化，适合课程规模，尚未进行生产规模负载测试。

当前已在 Linux 和本机 MySQL 上完成运行、自动化测试及独立恢复验证；Windows 11 尚未实机验收。原始课程材料并未全部提供，因此不能对未提供的评分要求作完整性保证。
