import {filterRecentNews,combineNewsQuality} from './news-policy.js';
import {text,safeUrl} from './context-values.js';

/** Independently enforce publication policy at the external projection boundary. */
export function projectContextNews(snapshot,now){
 const checked=filterRecentNews(snapshot?.items,now);
 const items=checked.items.map(item=>({
  title:item.title,source:item.src,published_at_ms:item.t,url:safeUrl(item.link),
  provenance:{publisher:item.provenance.publisher,publisher_url:safeUrl(item.provenance.publisher_url),article_url:safeUrl(item.provenance.article_url),
   link_scope:item.provenance.link_scope,timestamp_basis:item.provenance.timestamp_basis,verification:item.provenance.verification},
  association:{symbol:text(item.association?.symbol),basis:text(item.association?.basis)||'not_provided'}
 }));
 return {items,quality:combineNewsQuality(checked.quality,snapshot?.quality)};
}
