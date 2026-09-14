// One capacity policy shared by request diagnostics and the scheduled check.
export function assessCapacity(stat, {warningPct=85,minFreeGiB=9}={}) {
  const total=Number(stat.blocks)*Number(stat.bsize);
  const free=Number(stat.bavail)*Number(stat.bsize);
  const known=Number.isFinite(total)&&total>0&&Number.isFinite(free)&&free>=0;
  const usedPct=known?+((1-free/total)*100).toFixed(1):null;
  return {usedPct,freeBytes:known?free:null,minFreeGiB,warningPct,
    warning:!known||usedPct>=warningPct||free<minFreeGiB*1024**3,
    critical:!known||usedPct>=95||free<1024**3,owner:'server administrator'};
}
