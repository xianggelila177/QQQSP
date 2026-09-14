# QQQSP 2.5 运行手册

## 一、概况

本版只使用 ops/install.sh 生成的 qqqsp-v2.service。仓库其他旧版 service/timer/sh 为兼容测试保留，不要一起安装。本版完整安装、备份、域名、通知和回滚方案见根目录部署说明.md。

## 二、操作

```bash
sudo systemctl status qqqsp-v2 --no-pager
sudo journalctl -u qqqsp-v2 -n 100 --no-pager
sudo systemctl restart qqqsp-v2
node ops/macro-smoke.mjs http://127.0.0.1:8568 --stream
node ops/macro-smoke.mjs http://127.0.0.1:8568 --background
node ops/macro-smoke.mjs http://127.0.0.1:8568 --live
sudo bash ops/rollback.sh /opt/qqqsp-v2
```

配置在 shared/.env，持久化在 shared/state，日志在 shared/logs。升级保留这些内容，安装参数不覆盖已有PORT。后台观察默认65秒，仅证明无页面时调度运行，不替代来源新鲜度验证。状态接口 /api/macro/status 和快照 /api/macro/snapshot 用于区分后台停止、网络失败、缓存、来源冷却和时间缺失。

## 三、结论

只在本地端口与实际域名两侧均验收事件流后完成切换。宏观判断错误应检查地区、事件类型及原始证据；来源缺失时不要强行补价格或时间。真实网络、付费权限、接收端与长期稳定性需在你的服务器验收。
