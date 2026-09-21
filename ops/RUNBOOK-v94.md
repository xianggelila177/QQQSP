# v94 运维速查

## 概览

先确认版本94、Node22.16以上和持久化目录，再检查实际数据权限。不要因某个高级来源无权限而清空状态。

## 操作

健康入口/healthz与/readyz；后者基础就绪不等于全部行情可用。只读能力/api/v1/capabilities需要quote-only密钥，真实取数错误按missing_reason处理。管理员状态/API密钥只能通过私有入口查看。

429遵循Retry-After；滚动20证券单位，突发3请求。来源429由共享host gate和缓存退避承接，不切换未核验数据伪装成功。新报价流60秒主动结束是租期，不是内存泄漏；重连至少等待5秒，仍受查询额度限制。

KEY_STORE_INVALID先备份损坏文件并恢复可信备份；不直接删文件绕过撤销记录。KEY_ROTATED更新客户端密钥；INSUFFICIENT_SCOPE调整只读请求分区或在管理员面板新建合适权限，而不是把管理员密钥给智能体。

## 结论

升级保留.env及state/api-keys.json，回退旧程序前先关闭API入口并换用新凭据。完整说明见根目录部署与升级-v94.md及public/market-api-guide.md。
