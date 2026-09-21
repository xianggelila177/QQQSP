// Public metric vocabulary shared by API responses and the detail view.
// This is field metadata, not a symbol-to-company or provider-price mapping.
export const METRIC_CATALOG = Object.freeze(Object.fromEntries([
 ['turnoverAmount','成交额','trading','money','来源直接报告的常规时段累计成交金额，不用最新价乘成交量替代。'],
 ['turnoverRate','换手率','trading','percent','常规成交量除以流通股或总股本；具体分母见 basis 与 denominator。'],
 ['amplitude','振幅','trading','percent','（常规最高价－最低价）除以昨收乘100。'],
 ['priceToBook','市净率','valuation','ratio','价格相对于每股净资产；非正净资产单独标明。'],
 ['peTTM','市盈率·滚动','valuation','ratio','最近十二个月盈利口径，不是预测市盈率。'],
 ['marketCap','总市值','capital','money','公司总市值，币种独立标识；不是基金净资产。'],
 ['floatMarketCap','流通市值','capital','money','直接报告值优先；估算值保留价格及股本依据。'],
 ['sharesOutstanding','总股本','capital','shares','最近取得的已发行股份或基金份额；日期未知时不推断。'],
 ['floatShares','流通股','capital','shares','来源定义的流通股份或份额，不得大于总股本。'],
 ['volumeRatio','量比','trading','ratio','当前每分钟成交量与前五交易日每分钟均量比较，非全天量比。'],
 ['orderImbalance','委比','trading','percent','仅对来源明确的委托档位计算，档位数见 depth。不是成交方向。'],
 ['peLYR','市盈率·年度','valuation','ratio','最近完整财年盈利口径；历史财年末估值单独标明。'],
 ['psTTM','市销率·滚动','valuation','ratio','总市值相对最近十二个月营业收入。'],
 ['dividendTTM','股息·滚动','dividends','money-per-share','过去十二个月已派现金股息，不是预期股息。'],
 ['dividendYieldTTM','股息率·滚动','dividends','percent','过去十二个月现金股息率；数值1代表1%。'],
 ['lotSize','每手数量','capital','shares','可靠来源明确给出的整手数量，不等同券商最小下单数。'],
 ['week52High','52周最高','trading','price','同一来源、币种、观测和复权口径的五十二周高点。'],
 ['week52Low','52周最低','trading','price','同一来源、币种、观测和复权口径的五十二周低点。'],
 ['trailingEps','每股收益·滚动','inputs','money-per-share','用于估值计算的最近十二个月每股收益。'],
 ['annualEps','每股收益·年度','inputs','money-per-share','用于估值计算的最近完整财年每股收益。'],
 ['revenueTTM','营业收入·滚动','inputs','money','用于市销率计算的最近十二个月营业收入。'],
 ['bookValue','每股净资产','inputs','money-per-share','用于市净率计算的净资产分母。'],
 ['netIncomeTTM','归属净利润·滚动','inputs','money','最近十二个月归属普通股股东净利润。'],
 ['netIncomeAnnual','归属净利润·年度','inputs','money','最近完整财年归属普通股股东净利润。']
].map(([key,label,group,unit,description]) => [key,Object.freeze({key,label,group,unit,description})])));
const companyFields = new Set(['priceToBook','peTTM','peLYR','psTTM','marketCap','floatMarketCap','trailingEps','annualEps','revenueTTM','bookValue','netIncomeTTM','netIncomeAnnual']);
export function applicableMetric(key,type) {
  if (key === 'amplitude') return true;
  if (!['EQUITY','ETF','MUTUALFUND'].includes(type)) return false;
  return type === 'EQUITY' || !companyFields.has(key);
}
