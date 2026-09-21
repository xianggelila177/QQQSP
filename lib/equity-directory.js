import {readFileSync} from 'node:fs';
import {INDEX_SYMBOL_ALIASES} from './symbol-canonical.js';
const data=JSON.parse(readFileSync(new URL('../data/jpx-equities.json',import.meta.url),'utf8'));
const aliases=JSON.parse(readFileSync(new URL('../data/equity-aliases.json',import.meta.url),'utf8'));
export const equityAliases=symbol=>aliases[symbol]||[];
export const equityDirectoryInfo=Object.freeze({source:data.source,asOf:data.asOf,count:data.rows.length,scope:data.scope,sources:data.sources});
export const directoryEquities=Object.freeze(data.rows.map(row=>Object.freeze({
 symbol:row.code+'.T',name:row.name,nameJa:row.nameJa,market:'jp',type:'EQUITY',typeSource:'catalog',
 exchange:'JPX',currency:'JPY',identitySource:'JPX',listingAsOf:data.asOf,listingSection:row.section,
 sources:data.sources,aliases:[row.nameJa,row.code,...equityAliases(row.code+'.T')],
 quoteCoverage:'provider-dependent',
})));
// Accept explicit venue notation only for a supported venue; never guess a
// country from a bare numeric code (those remain directory/provider matches).
export function canonicalSearchQuery(query){
 const text=String(query||'').normalize('NFKC').trim();
 const index=INDEX_SYMBOL_ALIASES[text.toUpperCase()];
 if(index)return index;
 const japanese=/^(?:JPX|TSE|TYO):\s*(\d[0-9A-Z]{3})$/i.exec(text);
 if(japanese)return japanese[1].toUpperCase()+'.T';
 const hk=/^(\d{1,5})\.HK$/i.exec(text);
 if(hk)return hk[1].replace(/^0+(?=\d)/,'').padStart(4,'0')+'.HK';
 return text;
}
