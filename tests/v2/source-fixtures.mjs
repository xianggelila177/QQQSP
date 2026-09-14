export function sinaRow(symbol='NVDA',{price=100,date='2026-09-10 21:59:59',trade='Sep 10 09:59AM EDT',ext='',extPrice=''}={}){
 const f=Array(27).fill('');Object.assign(f,{0:symbol,1:String(price),2:'1',3:date,4:'1',5:'98',6:'102',7:'97',8:'150',9:'60',10:'1234',21:String(extPrice),24:ext,25:trade,26:'99'});
 return `var hq_str_gb_${symbol.toLowerCase()}="${f.join(',')}";`;
}
