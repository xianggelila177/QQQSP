import {spawnSync} from 'node:child_process';

// The content digest identifies a dirty checkout; HEAD alone does not.
export function releaseProvenance(root,evidence){
  const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
  const status=git.status===0?spawnSync('git',['status','--porcelain','--untracked-files=normal'],{cwd:root,encoding:'utf8'}):null;
  return {
    sourceCommit:git.status===0?git.stdout.trim():null,
    workingTreeDirty:status?.status===0?!!status.stdout.trim():null,
    sourceDigest:evidence.sourceDigest,
    sourceDigestKind:'sha256-of-verification-source-manifest',
    node:process.version,platform:process.platform,
    verification:{runId:evidence.runId,synthetic:evidence.synthetic,
      stages:Object.fromEntries(Object.entries(evidence.stages).map(([name,value])=>[name,{passed:value.passed,sourceDigest:value.sourceDigest,node:value.node,platform:value.platform,synthetic:value.synthetic}]))},
  };
}
