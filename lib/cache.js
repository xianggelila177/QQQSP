export function cacheSet(map,key,value,max=300) {
  if (map.size>=max && !map.has(key)) map.delete(map.keys().next().value);
  map.set(key,value);
}
