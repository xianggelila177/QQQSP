真实数据源回归样本，采集日期 2026-09-14。

- naver-kr.json: https://polling.finance.naver.com/api/realtime/domestic/stock/000660
- naver-us.json: https://polling.finance.naver.com/api/realtime/worldstock/stock/AAOI.O,LITE.O
- tencent.raw: https://qt.gtimg.cn/q=sz161128,usAAOI,usLITE（原始 GBK 字节）
- naver-kr-detail.json: https://m.stock.naver.com/api/stock/000660/integration（只保留身份和指标字段）
- naver-kr-company.html: https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd=000660（只保留身份和已发行股数行）

样本是固定历史数据，用于复现解析与刷新故障；不是实时行情。
