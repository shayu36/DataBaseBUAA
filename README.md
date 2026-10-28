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
| `JWT_SECRET` | 至少 32 个字符的随机会话密钥；须替换示例占位符，不能只填空白 |
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

初始化会创建业务库 `campus_bike`、测试库 `campus_bike_test` 和业务账号；已有同名应用账号的密码不会被修改，必须与 `.env` 中一致。脚本会先验证密码及实际匹配的 MySQL 账号，再授予业务库权限；验证失败时不新增授权。演示数据只在空库首次写入，重复初始化不会重置已有业务数据。构建同时生成前端页面、课程报告和 E-R 图，可从“数据库设计”页面打开。浏览器访问 `http://127.0.0.1:5188`；在运行终端按 `Ctrl+C` 停止应用。

初始化和启动都会检查会话密钥；密钥缺失、过短、全为空白或仍是示例占位符时会直接报错。校验不能判断密钥是否随机，请使用上面的生成命令。

## 演示账号

| 身份 | 邮箱 | 演示密码 |
|---|---|---|
| 管理员 | `jia@qingxing.local` | `Qingxing2026!` |
| 学生 | `ouyang@qingxing.local` | `Qingxing2026!` |
| 运维员 | `zheng@qingxing.local` | `Qingxing2026!` |
| 学生 | `wang@qingxing.local` | `Qingxing2026!` |

这些账号仅供本机演示。普通注册只能创建学生账号；管理员可创建运维账号。

新注册密码至少 8 个字符，且须包含英文字母和数字；登录兼容历史账号已有的非空短密码。密码的 UTF-8 编码均不得超过 72 字节。

## 主要功能

- 学生借车、地图选点还车、模拟支付、个人订单和碳积分流水；历史订单可按状态筛选并完整导出，人工扣减不会使账户对应余额为负，重复请求编号须对应相同调整。
- 管理员维护停车区、车辆、道路、员工及账号状态，处理还车记录和订单资格复核；账户与待复核订单按编号分页，可继续处理较早记录。
- 运维员处理分配给自己的维修和调度任务，并处置车辆风险告警；生成工单时复用同车未完成工单，原工单完成后可再次发起，关联历史记录在审计中。
- 运营分析支持日期、工作日、小时和站点筛选；调度建议可以保存、确认或记录原因后不执行。
- 调度任务记录创建、出发和完成后的两站库存；旧任务缺失历史快照时显示未采集。
- 路网支持最短、安全和舒适三种路线；排行榜支持个人昵称、公开设置和私密名次。

人工积分调整提交后若未收到明确结果，当前浏览器标签页会保留请求内容，刷新后仍可用原请求重试，避免重复记账。放弃重试或关闭标签页前应先核对流水，因为请求可能已经提交；禁用浏览器会话存储时无法提交调整。

模拟支付重试须使用原请求编号；对已支付订单使用新的编号会提示订单已支付，可查看支付记录。网页按订单生成稳定编号，重试时无需手动填写。

归还页面显示模拟位置采集时间。选择站点、点击地图或修改坐标会重新采集；位置过期时可点击“重新采集模拟位置”，核对坐标后再归还。该页面只模拟定位，不读取真实 GPS。接口若声明设备 GPS 来源必须提供采集时间；模拟或手动输入未提供采集时间时记录服务器接收时间。

数据库结构、读写查询、存储过程、迁移和种子数据均位于 `database/`。后端负责身份验证、参数校验、事务边界和路线图计算；前端负责交互与展示。

数据库设计页面的触发器目录由管理员在初始化或迁移时核验，保存在对应数据库中并显示核验时间；外部修改触发器后应先备份，再运行 `npm run db:migrate` 更新目录。如果提示 `TRIGGER_CATALOGUE_CONFLICT`，已有配置占用了目录保留名称，请备份并核对该配置，避免覆盖原数据。

首页日期按北京时间自动更新；业务统计显示最近一次加载或刷新时的数据，页面长时间打开或跨日后可点击“刷新数据”获取最新统计。

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
| `npm audit --registry=https://registry.npmjs.org` | 使用 npm 官方服务检查锁文件中的已知依赖漏洞 |
| `npm run check` | 检查业务数据不变量 |
| `node scripts/run-queries.mjs` | 执行 27 组教学查询，结果写入本机 `docs/evidence/` |
| `npm run backup` | 备份当前业务数据库 |
| `npm run snapshot` | 导出当前业务库到本机 `database/demo-snapshot.sql`，成功时替换旧快照 |
| `npm run report` | 单独生成课程报告和实体关系图 |
| `uv run python scripts/package-project.py` | 生成不含本机凭据和临时数据的交付包；先运行 `npm run build` |
| `uv run python -m unittest discover -s tests -p package_project_test.py` | 验证交付包筛选和失败保护 |

开发服务将接口代理到 `127.0.0.1:5188`，使用 `npm run dev` 前需另开终端运行后端。浏览器测试同样需要后端已经启动。测试会重建 `campus_bike_test` 的测试数据；浏览器测试会在演示库中创建测试行程、工单和任务。教学查询使用 `.env` 中的数据库名称和管理员凭据，执行前应核对目标；查询结果可能包含业务数据，不提交 Git。

## 分支协作

日常开发在 `zyf` 分支进行。开始工作前先获取远程更新，并确认本地未提交内容：

```text
git fetch origin
git switch zyf
git pull --ff-only origin zyf
```

提交并推送到 `zyf` 后，定期把 `main` 的新提交合入开发分支，解决冲突并完成构建和相关测试，再将经过验证的结果合入 `main`。首次使用时可运行 `git switch --track origin/zyf`；本仓库目前没有配置定时自动合并。

## 备份与恢复

对已有数据执行初始化或迁移前，先停止应用并运行 `npm run backup`；迁移会重建数据库过程，完成后再启动应用。备份和恢复需要 `mysql`、`mysqldump` 在系统路径中，也可以把 `MYSQL_BASE` 设置为 MySQL 安装目录。

备份与恢复客户端使用与应用相同的主机和端口默认值；管理员账号和密码中的特殊字符会按 MySQL 选项文件规则转义。客户端执行期间会在 `.runtime` 创建临时配置，正常结束或出错后尝试删除；清理失败会报错。

```text
npm run backup
node scripts/restore.mjs backups/备份文件.sql campus_bike_restore_demo
node scripts/check.mjs campus_bike_restore_demo
```

备份和演示快照持有数据库结构锁，与项目初始化、演示数据初始化和迁移互斥；业务写入可以继续，InnoDB 数据由一致性事务导出，见 [MySQL 备份工具说明](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html)。本机快照不会随代码升级自动更新；需要当前结构时应重新生成，且快照包含当时的业务数据，不提交 Git 或放入交付包。结构锁等待最多 10 秒，超时需要稍后重试。直接连接数据库执行的外部 SQL 不受项目锁约束，备份时应自行停止外部结构变更。导出先写入同目录临时文件，成功、文件非空且确认释放锁后才发布；失败时保留已有快照。恢复目标必须是尚不存在的 `campus_bike_restore_` 前缀数据库。只导入可信的项目备份：脚本会以管理员权限执行 SQL，简单的切库语句检查不能隔离任意 SQL 或保证其他数据库不受影响。输入、输出或 MySQL 命令失败时，脚本会报告错误；恢复失败可能留下不完整的目标库，应检查后另选新库重试。

MySQL 结构变更会隐式提交；迁移失败时应检查错误并从备份恢复，不能依赖事务回滚已完成的结构变更。用户积分汇总视图只将有效已支付订单的发放里程计入里程，积分和减排仍按全部流水求净额；升级只更新视图，不改写历史流水。

新版迁移为待复核订单列表添加索引。若报 `MIGRATION_REVIEW_INDEX_CONFLICT`，请先备份并核对 `ride_orders` 中同名索引的定义；确认原因后修正冲突，再重新运行迁移。

新版迁移为个人订单按编号分页添加 `idx_ride_user_id(user_id,id)`。若报 `MIGRATION_RIDE_USER_INDEX_CONFLICT`，请先备份并核对同名索引的列、排序、可见性及唯一性；确认原因后修正冲突，再重新运行迁移。索引会占用存储并增加写入维护成本，实际性能取决于数据分布。

新版迁移限制一个调度任务最多关联一条已确认建议；尚未关联任务的建议可以有多条。若报 `MIGRATION_DUPLICATE_SUGGESTION_TASKS`，请备份后用下面的只读 SQL 找出重复任务，并结合建议、任务和审计记录人工核对，修正后重试；迁移不会自动删除或改写这些历史记录。

```sql
SELECT task_id, COUNT(*) AS 建议数
FROM dispatch_suggestions
WHERE task_id IS NOT NULL
GROUP BY task_id
HAVING COUNT(*) > 1;
```

若报 `MIGRATION_SUGGESTION_TASK_INDEX_CONFLICT`，请备份并检查同名索引的列和唯一性；调整索引时须保留外键所需索引，再重试迁移。

确认建议时，数据库还会核对任务的状态、两站和车辆数量。检查命令发现历史建议与任务不一致时，可使用以下只读 SQL 查询明细，再依据备份和审计记录人工核对；系统不会自动改写历史。

```sql
SELECT s.id AS 建议编号, s.task_id AS 任务编号, s.quantity AS 建议数量,
       s.source_zone_id AS 建议调出站, s.target_zone_id AS 建议调入站,
       t.source_zone_id AS 任务调出站, t.target_zone_id AS 任务调入站,
       (SELECT COUNT(*) FROM dispatch_bikes d WHERE d.task_id = s.task_id) AS 任务车辆数
FROM dispatch_suggestions s LEFT JOIN dispatch_tasks t ON t.id = s.task_id
WHERE s.status = 'CONFIRMED' AND s.task_id IS NOT NULL
  AND (t.id IS NULL OR s.source_zone_id <> t.source_zone_id
       OR s.target_zone_id <> t.target_zone_id
       OR s.quantity <> (SELECT COUNT(*) FROM dispatch_bikes d WHERE d.task_id = s.task_id));
```

支付与积分流水的请求编号区分字母大小写；升级会保留历史编号。如果旧记录的编号为空，迁移报 `MIGRATION_INVALID_PAYMENT_KEYS` 或 `MIGRATION_INVALID_CARBON_KEYS` 并停止，应依据备份人工核对并补全后重试。员工姓名和电话统一保存在用户表；升级时若旧员工表中的姓名或电话与用户表不一致，迁移会报 `STAFF_NAME_MISMATCH` 或 `STAFF_PHONE_MISMATCH` 并停止。请先根据备份人工核对差异，再修正旧表或用户表后重新迁移。

新版数据库使用 UTC 默认时间，不依赖 MySQL 服务器时区；迁移不修改历史时间，若旧库使用过非 UTC 服务器时区，应根据原始环境和备份核对历史记录。

积分页面显示数据库中的当前碳系数、每公里积分和规则版本；旧库迁移会保留已有碳规则配置，仅在版本字段缺失时补默认版本；显式空值保持原样，读取时使用默认版本。若旧版迁移已覆盖原规则版本，无法自动恢复，应依据迁移前备份人工核对。新版积分发放会保存当时的精确碳系数和积分比例；旧流水中未记录的比例保留为空，旧版已舍入的系数无法还原。若历史系数与已发放减排量不一致，不变量检查会提示人工核对。

积分一致性检查和教学查询采用与发放过程相同的计算顺序，先乘历史系数再换算公里，避免 MySQL 会话除法精度设置截断中间距离而产生误报。

归还计费用整数除法按每开始 30 分钟计算，避免 MySQL 会话除法精度改变计费边界。升级不会修改历史订单和支付；如果旧环境调整过 `div_precision_increment`，可先备份，再用以下只读 SQL 核对与当前固定规则不一致的已结束订单，结合历史规则和支付记录人工处理：

```sql
SELECT id, status, started_at, ended_at, amount_cents,
       GREATEST(1, (TIMESTAMPDIFF(MICROSECOND, started_at, ended_at)
                    + 1799999999) DIV 1800000000) * 100 AS expected_cents
FROM ride_orders
WHERE status IN ('UNPAID', 'PAID')
  AND amount_cents <> GREATEST(1, (TIMESTAMPDIFF(MICROSECOND, started_at, ended_at)
                                   + 1799999999) DIV 1800000000) * 100;
```

碳规则存放在 `system_settings` 的 `carbon` JSON 对象中。`kg_per_km` 和 `points_per_km` 须为非负数，最大为 `999999999999.99999999`，最多保留八位有效小数；支持数字及数字字符串（包括科学计数法）。字段缺失或 JSON 空值分别使用 `0.21` 和 `10`。`rule_version` 须为不超过 30 个字符、不含控制字符且不全为空格的字符串，缺失、JSON 空值或空字符串使用 `carbon-v1`；字符串 `"null"` 是普通版本名。配置无效时，读取规则的请求返回 `INVALID_CARBON_RULE`，相关支付和记账事务会回滚；请备份后核对并修正配置。

配置精确数值时应使用 JSON 字符串，例如 `"999999999999.99999999"`；MySQL 保存 JSON 数字时可能先产生浮点舍入。首页接口中的当前碳系数和积分比例，以及积分流水中的历史系数和比例，均以十进制字符串返回，防止客户端浮点转换丢失精度；历史未知的比例仍为 `null`。调用方升级时应按字符串处理这些字段。

每笔发放的积分最多为 `2147483647`，减排量最多为 `99999999.9999` 千克。即使规则字段本身有效，与某笔行程距离相乘后也可能超出流水字段范围；此时需要新增发放的支付或确认有效行程返回 `CARBON_AWARD_OUT_OF_RANGE` 并回滚。管理员应核对行程距离与碳规则，修正后重试。复核已有发放流水的历史订单时，保留原发放数值，不重新读取当前规则或重复发放。

人工调整的减排量最多保留四位有效小数，接口允许范围为 -1000 至 1000 千克；超出精度返回 `INVALID_ADJUSTMENT_AMOUNT`，不会自动舍入或写入流水。此前已经按较高精度提交并被舍入的历史流水不会改写；再次处理时应先核对历史流水与审计，再使用符合精度要求的数值和新的请求编号。

旧碳积分表迁移会逐条核对订单、里程、积分、减排、系数和时间，并保留原表 `carbon_ledger_legacy`，同时建立兼容视图。若报 `MIGRATION_CARBON_CONFLICT`、`MIGRATION_CARBON_LEGACY_COLLISION` 或 `MIGRATION_CARBON_VERIFY_FAILED`，请停止操作，依据迁移前备份核对旧表、新流水、订单和支付记录；不要通过删除旧表或修改版本标记绕过检查。验证失败时可能已有部分写入，须结合备份检查后再处理。已升级库若保留了旧表，也会在本次升级时核对历史记录；后续新增的正常流水会保留，缺失的兼容视图会重建。

旧库道路迁移保留已有属性。完全没有扩展属性的旧道路会生成教学模拟值；部分字段缺失时只补数据库默认值，缺少来源字段时标记为模拟数据，不能视为实测。如果已有 `MEASURED` 道路但缺少属性列，迁移会报 `MIGRATION_INCOMPLETE_MEASURED_ROADS` 并停止；应依据备份补齐缺失字段和对应的实测值，再重试。旧版迁移如果已覆盖道路属性，无法自动恢复，须根据备份核对。

旧版演示校园地图升级会替换站点位置及道路。只有站点名称、位置描述、坐标和半径，以及道路编号、拓扑、距离、权重、通行与属性均符合旧版演示数据时才自动升级；道路扩展属性允许旧版默认值或旧库迁移生成的模拟值。如果发现差异或道路审计记录，初始化会提示 `customized map` 并停止地图升级，不会执行站点坐标重写或道路替换；此前的结构迁移可能已经完成。请保留备份并人工核对，再制定适用于该地图的迁移方案；若旧版升级已覆盖修改，需依据升级前备份恢复，不能自动还原。

旧还车记录已有定位时间或来源时会分别保留。定位时间缺失时以记录创建时间补全，只能视为近似时间；来源缺失时标记为 `HISTORICAL_SIMULATION`。不要将补全的历史时间视为已验证的设备采样时刻。

旧版员工表仍含 `name` 和 `phone` 时，可在 MySQL 中查询需要核对的记录：

```sql
SELECT s.id, s.name AS 员工表姓名, u.name AS 用户表姓名,
       s.phone AS 员工表电话, u.phone AS 用户表电话
FROM staff s LEFT JOIN users u ON u.id = s.user_id
WHERE u.id IS NULL OR NOT (BINARY s.name <=> BINARY u.name)
   OR NOT (BINARY s.phone <=> BINARY u.phone);
```

该查询仅用于尚未完成员工字段迁移的旧库；迁移完成后，姓名和电话只存在于用户表。

启动时会持有结构锁，核对数据库迁移标记和安装过程时记录的 SQL 源码摘要；标记缺失或不匹配时，应用在监听端口前报 `SCHEMA_VERSION_MISMATCH`。更新代码后若过程文件发生变化，应先备份并运行 `npm run db:migrate`，再启动应用。结构或过程安装失败时，摘要会保持无效，需排查并完成迁移后再启动。迁移报 `UNSUPPORTED_SCHEMA_VERSION` 时，数据库来自更新的应用版本，应使用与该数据库匹配的版本；报 `INVALID_SCHEMA_VERSION` 时，应核对备份和 `system_settings` 中的迁移标记。不要通过修改标记绕过检查。摘要记录项目安装的源码，不检测外部直接修改的过程或其他数据库对象；升级后仍应按上文执行数据检查。

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

内置校园道路、定位、支付、风险规则和碳系数均为教学模拟；旧库保留的实测来源标记不代表项目已核实其准确性。计费固定为每开始 30 分钟 100 分，风险规则固定使用近 30 天窗口；旧库中遗留的 `pricing`、`risk` 配置行不会改变这些规则。库存持续时间只按相邻且间隔不超过五分钟的快照估计，缺失时间不视为正常；曲线按完整采样中的缺口分段，大样本会保留首尾和极值并抽样，统计仍使用完整数据。写事务使用数据库命名锁串行化，适合课程规模，尚未进行生产规模负载测试。

当前已在 Linux 和本机 MySQL 上完成运行、自动化测试及独立恢复验证；Windows 11 尚未实机验收。原始课程材料并未全部提供，因此不能对未提供的评分要求作完整性保证。
