# QQQSP 2.15.0 / v95 部署与升级

使用 Node.js 22.16 或更新版本（生产验证使用 24）。没有新增 npm 运行时依赖，网页已构建；开发环境需要 Ajv 或 Python jsonschema 运行完整 schema 验证。

## 验证候选源码

```sh
node scripts/verify.mjs
node tests/run.mjs
node scripts/secret-scan.mjs .
python3 scripts/package.py /tmp/qqqsp-v2.15.0-source.zip
python3 scripts/package.py --verify /tmp/qqqsp-v2.15.0-source.zip
```

`npm run test:v95` 可单独运行缺陷复现回归。JPX 数据目录内已记录来源和快照日期；重建目录的脚本依赖开发用 openpyxl，服务器运行无需安装。

## 既有服务升级

1. 先备份原 `.env`、`state`、`logs`、systemd、反向代理和隧道配置，记录 current 指向。保持现有 API 域名及密钥。
2. 在独立候选目录跑完整验证，通过后将源码放入新的 release 目录。沿用 shared state/logs 及原 EnvironmentFile，不重新运行初始化密钥命令。
3. 短暂停服务后取得一致的 shared 备份，再原子切换 current，启动原服务。此版不要求改反向代理路径、端口、环境变量或密钥存储格式。
4. 验证本地 `/readyz` 为 v95，公网首页引用 v95 资源、旧只读密钥可调 v1/v2、科乐美搜索与 JPY 报价、AAOI/SPY 新闻及宏观新闻的发布时间均在7天内。无合格新闻应空，不得退回旧文填充。
5. 确認 watchlist、采样文件、管理员密钥和 API 密钥状态文件保留。应用 ready 与上游 dataReady 分别记录。

## 回滚

本版与 v94 的密钥状态格式兼容。回滚到刚保留的 v94 release 时只恢复 current 链接并重启，保留当前 shared 配置与数据，不覆盖已轮换/吊销的密钥状态。回退到 v93 或更老版本另需密钥治理兼容审查，不能忽略 v94 的吊销或权限记录。

## 覆盖边界

新闻来源元数据的时间与出处检查不是独立事实核查。Google 候选受已认可发布者域范围限制；目录以外的新来源不会自动被视为可信新闻。无来源或故障时明确为空/部分不可用。

Naver 日股快照只声明最优可得网站报价；不提供完整盘口或备用日本历史曲线。未配置的商业数据源、未经核验的交易所序号、精确报价步长和完整逐笔成交均不伪造。
