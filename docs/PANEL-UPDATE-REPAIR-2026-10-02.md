# 旧面板无法升级：v114修复与验收

用户反馈正确公网入口仍显示旧界面。本次复核确认服务器已部署v113，但此前验收遗漏了有旧Service Worker缓存的浏览器升级路径。

## 原因

1. 静态路由把带任意v参数的sw.js也赋予一年immutable缓存。公网旧注册URL确实出现CDN HIT；裸sw.js还受4小时缓存影响。
2. 旧Worker为避免版本混用，在收到新版HTML时继续返回配套的旧HTML。
3. 旧页面只在启动时注册Worker，只监听随后发生的updatefound；没有控制器接管后的版本核验/切换，更新提示会消失。顶栏刷新只刷新行情。

## 修复

- sw.js所有查询形式、update.html及update.js均返回no-store,max-age=0。
- 稳定/sw.js注册，updateViaCache:none；五分钟检查、前台/联网事件节流检查、处理已存在的installing/waiting。
- Worker通过MessageChannel回答真实安装版本。新版激活并接管后才切换；同版、首次安装、离线、隐藏页及重复重载均有保护。
- 顶栏持久显示“面板 v114”，兼作检查更新按钮。
- 独立更新入口：https://qqqsp.avalon-izumi.online/update.html 。旧Worker不会把它当成首页缓存，入口等待新Worker激活和版本确认后返回行情页。不清除localStorage、IndexedDB、自选或设置。
- 精确清理新域名115个Worker URL的CDN缓存，4批全部成功。未修改安全设置。

## 验收

- 27项更新/缓存/前端/发布相邻回归通过；构建通过；546项脚本及资源一致性检查通过；服务器发布包shell语法检查通过。未运行全量测试。
- 浏览器真实复现：从v113发布包启动旧页，加入NVDA自选、设置三列；服务切换至v114后普通刷新仍加载panel.bundle.js?v=113。
- 进入独立更新入口后自动返回/?updated=114；DOM加载panel.bundle.js?v=114，顶栏显示“面板 v114”；QQQ、SPY、NVDA及三列设置保留。该步骤是本机升级场景验收，API读取生产数据，不冒充用户设备已完成更新。
- 公网首页、bundle、CSS、更新HTML/JS均200且SHA匹配发布包。更新入口为no-store；裸SW及旧版本108/111/112/113/114查询均返回version114、no-store、CF BYPASS。
- 发布目录：/opt/qqqsp-v2/releases/20261002T035912Z-v114；回退版本v113；备份/opt/qqqsp-v2/backups/20261002T035912Z-v114。
- 258个发布文件逐一校验，配置/密钥/自选保护验证通过，两服务active。最终ready=true；行情上游16项正常、SEPQ/SKHY仍陈旧，dataReady=false，与静态更新验收分开记录。

用户设备需要打开上述更新入口；顶部“面板 v114”是该设备完成更新的可见依据。

参考：[ServiceWorker updateViaCache](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/updateViaCache)、[Cloudflare精确URL缓存清理](https://developers.cloudflare.com/cache/how-to/purge-cache/purge-by-single-file/)。

## v115 卡片留白调整

- 根因：quote-meta 下距12px与 numrow 上距12px在 flow-root 内叠加；独立FX对齐区会让无说明的卡片也保留其他卡片的说明高度。
- 修改：报价年龄下距4px，价格区上距0、下距14px；FX说明放入价格区下方，取消独立FX占位。手机覆盖同步调整，保留图表对齐。
- 浏览器实测：普通USD卡与CNY换汇卡并排，报价年龄到价格间距由52px降至4px；375px窗口（内容视口360px）无横向溢出。发布后通过SSH转发读取真实生产服务，确认面板v115、两张卡间距4px。
- 验证：构建、546项脚本/资源检查通过；258个发布文件校验、服务器Shell语法检查通过。仅版本与前端文件相对v114发生改变；本次为低影响视觉调整，未新增测试或运行全量测试。
- 公网首页、v115 CSS、bundle、裸SW均HTTP200且SHA256与本机发布内容完全一致；SW保持no-store、Cloudflare BYPASS。
- 已发布：/opt/qqqsp-v2/releases/20261002T041342Z-v115；回退v114；备份/opt/qqqsp-v2/backups/20261002T041342Z-v115。配置/密钥/自选保护校验通过，两服务active，ready=true；启动时dataReady=false，不将上游数据就绪与UI发布混为一谈。
- 部署日志、公开资源校验、浏览器布局记录及截图属于内部验证材料，未随仓库发布。
