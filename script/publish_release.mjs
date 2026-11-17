#!/usr/bin/env node
/** Publish reviewed images and an immutable Flux bundle. Run only with operator authorization. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from './tasks.mjs';
import { uniqueJSON } from './json.mjs';
export const SOURCE='https://github.com/seventwo-studio/canaveral';
// Repo-scoped names: packages first pushed by this repository's GITHUB_TOKEN are linked to it
// and grant its workflows write access. The older top-level packages are not used.
export const NAMESPACE='ghcr.io/seventwo-studio/canaveral';
export const IMAGES={orchestrator:NAMESPACE+'/orchestrator',dashboard:NAMESPACE+'/dashboard',kubevirt:NAMESPACE+'/kubevirt'};
export const DEPLOYMENT=NAMESPACE+'/deploy';
const DIGEST=/^sha256:[a-f0-9]{64}$/;
/** Describe a registry failure without credentials: status, path and registry error codes only. */
export function registryFailure(url,status,body) {
  let codes='';
  try {codes=(JSON.parse(body).errors??[]).slice(0,3).map(e=>typeof e.code==='string' && /^[A-Z_]{1,64}$/.test(e.code) ? e.code : 'UNKNOWN').join('; ');} catch {}
  return 'Registry request failed: HTTP '+status+' for '+url.pathname+(codes?' ('+codes+')':'')+'.';
}
/** Read at most 4 KiB of an error body, then stop the transfer. */
async function boundedText(response,limit=4096) {
  const chunks=[];let length=0;
  for await(const chunk of response.body??[]) {chunks.push(chunk);length+=chunk.length;if(length>=limit) break;}
  return Buffer.concat(chunks).subarray(0,limit).toString('utf8');
}
export class Registry {
  constructor(packageName, authorization) { this.package=packageName.replace(/^ghcr\.io\//,'');this.authorization=authorization; }
  static async get(url,auth) {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:' || parsed.hostname!=='ghcr.io' || parsed.username || parsed.password) throw new Error('Unexpected registry origin.');
    const response=await fetch(url,{headers:{Authorization:auth,Accept:'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json','User-Agent':'canaveral-release'},signal:AbortSignal.timeout(30_000),redirect:'error'}).catch(()=>{throw new Error('Registry transport failed.');});
    if(!response.ok) {const error=new Error(registryFailure(parsed,response.status,await boundedText(response).catch(()=>'')));error.status=response.status;throw error;}
    const chunks=[];let length=0;
    for await(const chunk of response.body) {
      length+=chunk.length;
      if(length>2*1048576) throw new Error('Oversized registry manifest.');
      chunks.push(chunk);
    }
    return [Buffer.concat(chunks),response.headers];
  }
  static async connect(packageName) {
    if(!process.env.GITHUB_ACTOR || !process.env.GITHUB_TOKEN) throw new Error('Registry credentials are required.');
    const basic=Buffer.from(process.env.GITHUB_ACTOR+':'+process.env.GITHUB_TOKEN).toString('base64');
    const scope='repository:'+packageName.replace(/^ghcr\.io\//,'')+':pull';
    const [body]=await Registry.get('https://ghcr.io/token?service=ghcr.io&scope='+encodeURIComponent(scope),'Basic '+basic);
    const token=uniqueJSON(body.toString('utf8')).token;
    if(typeof token!=='string' || !token) throw new Error('Missing registry token.');
    return new Registry(packageName,'Bearer '+token);
  }
  async manifest(tag) {
    let raw,headers;
    try {[raw,headers]=await Registry.get(`https://ghcr.io/v2/${this.package}/manifests/${encodeURIComponent(tag)}`,this.authorization);}
    catch(error) {if(error.status===404) return null;throw error;}
    const digest='sha256:'+createHash('sha256').update(raw).digest('hex');
    if(headers.get('Docker-Content-Digest')!==digest) throw new Error('Registry manifest digest differs.');
    return [uniqueJSON(raw.toString('utf8')),digest];
  }
}
export function checkIdentity(manifest,version,revision,artifact=false) {
  const labels=manifest.annotations??{};
  for(const [key,value] of Object.entries({'org.opencontainers.image.source':SOURCE,'org.opencontainers.image.version':version,'org.opencontainers.image.revision':revision})) if(labels[key]!==value) throw new Error('Published version belongs to different source; refusing to overwrite.');
  if(artifact) {
    if(manifest.layers?.length!==1 || manifest.layers[0]?.mediaType!=='application/vnd.cncf.flux.content.v1.tar+gzip') throw new Error('A single Flux content layer is required.');
  } else {
    for(const architecture of ['amd64','arm64']) if(!manifest.manifests?.some(e=>e.platform?.os==='linux' && e.platform?.architecture===architecture)) throw new Error('Both Linux architectures must be published.');
  }
}
export function bundle(version,revision,images,output,sourceRoot=ROOT) {
  if(!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version) || !/^[a-f0-9]{40}$/.test(revision)) throw new Error('Semantic version and full source revision required.');
  if(Object.keys(images).sort().join(',')!==Object.keys(IMAGES).sort().join(',')) throw new Error('Controller, dashboard and KubeVirt worker images are required.');
  for(const [stage,packageName] of Object.entries(IMAGES)) {
    const prefix=packageName+':'+version+'@';
    if(typeof images[stage]!=='string' || !images[stage].startsWith(prefix) || !DIGEST.test(images[stage].slice(prefix.length))) throw new Error('Images must pin their own version and digest.');
  }
  if(existsSync(output) && (lstatSync(output).isSymbolicLink() || readdirSync(output).length)) throw new Error('Release output must be empty.');
  // Validate every input before producing any release files.
  const sources={};
  for(const stage of ['orchestrator','dashboard','kubevirt']) {
    const source=join(sourceRoot,'deploy',stage), expected=stage==='kubevirt' ? ['serviceaccount.json','role.json','rolebinding.json','configmap.json','service.json','statefulset.json','kustomization.yaml'] : ['deployment.json','service.json','kustomization.yaml'];
    if(stage==='orchestrator') expected.push('persistentvolumeclaim.json');
    if(lstatSync(source).isSymbolicLink() || readdirSync(source).sort().join(',')!==expected.sort().join(',') || expected.some(name=>!lstatSync(join(source,name)).isFile() || lstatSync(join(source,name)).isSymbolicLink())) throw new Error('Only declared deployment sources may enter the artifact.');
    sources[stage]=Object.fromEntries(expected.map(name=>[name,readFileSync(join(source,name),'utf8')]));
  }
  mkdirSync(output,{recursive:true});
  for(const stage of ['orchestrator','dashboard','kubevirt']) {
    const directory=join(output,stage);mkdirSync(directory);
    for(const [name,source] of Object.entries(sources[stage])) {
      let text=source;
      if(name==='deployment.json' || name==='statefulset.json') {
        const data=uniqueJSON(text), containers=data.spec.template.spec.containers;
        if(containers.length!==1) throw new Error('Expected one runtime per stage.');
        containers[0].image=images[stage];
        for(const init of data.spec.template.spec.initContainers??[]) init.image=images[stage];
        const metadata=data.spec.template.metadata;
        (metadata.labels??={})['app.kubernetes.io/version']=version;
        text=JSON.stringify(data,null,2)+'\n';
      }
      writeFileSync(join(directory,name),text,{flag:'wx'});
    }
  }
  const result={schemaVersion:1,version,source:SOURCE,revision,images};
  writeFileSync(join(output,'app-release.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});return result;
}
export function draftRelease(pages,tag,revision) {
  const matches=pages.flat().filter(r=>r.tag_name===tag);
  if(matches.length!==1 || matches[0].draft!==true || matches[0].target_commitish!==revision) throw new Error('One unfinished draft targeting the exact source commit is required.');
  return matches[0];
}
// Never relay subprocess stderr/stdout on failure: remote errors can contain credentials.
export function capture(command,args) {
  try {return execFileSync(command,args,{cwd:ROOT,encoding:'utf8',maxBuffer:32*1048576,stdio:['ignore','pipe','pipe']}).trim();}
  catch {throw new Error(command+' operation failed; inspect publication state before retrying.');}
}
export const STABLE_TAG=/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
export function releaseIdentity(tag,configured,lock,revision,tagRevision,remoteTagRevision,eventRevision) {
  if(!STABLE_TAG.test(tag??'')) throw new Error('Stable release tag required.');
  if(configured!==tag.slice(1) || lock.version!==configured || lock.packages?.['']?.version!==configured) throw new Error('Release tag differs from package/lock version.');
  if(!/^[a-f0-9]{40}$/.test(revision) || tagRevision!==revision || remoteTagRevision!==revision || eventRevision!==undefined && eventRevision!==revision) throw new Error('Checked-out release identity differs.');
}
export function remoteTag(output,tag) {
  const refs=new Map(output.split('\n').filter(Boolean).map(line=>line.split(/\s+/).reverse()));
  return refs.get('refs/tags/'+tag+'^{}')??refs.get('refs/tags/'+tag);
}
export function ensureDraft(pages,tag,revision,create,reload) {
  if(!pages.flat().some(r=>r.tag_name===tag)) {
    create(['release','create',tag,'--verify-tag','--draft','--target',revision,'--title',tag,'--notes','Release metadata and signed deployment artifact are prepared by the release workflow.']);
    pages=reload();
  }
  return draftRelease(pages,tag,revision);
}
export async function main(finalize=false,{execute=capture,connect=packageName=>Registry.connect(packageName),root=ROOT}={}) {
  const capture=execute,run=(command,args)=>{execute(command,args);};
  const tag=process.env.RELEASE_TAG;
  if(!STABLE_TAG.test(tag??'')) throw new Error('Stable release tag required.');
  const version=tag.slice(1), configured=uniqueJSON(readFileSync(join(root,'package.json'),'utf8')).version;
  const lock=uniqueJSON(readFileSync(join(root,'package-lock.json'),'utf8'));
  const revision=capture('git',['rev-parse','HEAD']);
  run('git',['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main']);
  run('git',['merge-base','--is-ancestor',revision,'origin/main']);
  releaseIdentity(tag,configured,lock,revision,capture('git',['rev-parse','refs/tags/'+tag+'^{commit}']),remoteTag(capture('git',['ls-remote','origin','refs/tags/'+tag,'refs/tags/'+tag+'^{}']),tag),process.env.GITHUB_SHA);
  const releases=()=>uniqueJSON(capture('gh',['api','--paginate','--slurp','repos/seventwo-studio/canaveral/releases?per_page=100']));
  if(finalize) draftRelease(releases(),tag,revision);
  else ensureDraft(releases(),tag,revision,args=>run('gh',args),releases);
  const dist=join(root,'dist');mkdirSync(dist,{recursive:true});
  const images={};
  for(const [stage,packageName] of Object.entries(IMAGES)) {
    let registry=await connect(packageName), found=await registry.manifest(version);
    if(found===null) {
      if(finalize) throw new Error('Cannot finalize missing image.');
      const annotations={'org.opencontainers.image.source':SOURCE,'org.opencontainers.image.version':version,'org.opencontainers.image.revision':revision};
      run('docker',['buildx','build','.', '--target',stage,'--platform','linux/amd64,linux/arm64','--push','--tag',packageName+':'+version,...Object.entries(annotations).flatMap(([k,v])=>['--label',k+'='+v,'--annotation','index:'+k+'='+v])]);
      registry=await connect(packageName);found=await registry.manifest(version);
    }
    if(!found) throw new Error('Image publication did not complete.');
    checkIdentity(found[0],version,revision);images[stage]=packageName+':'+version+'@'+found[1];
  }
  const temporary=mkdtempSync(join(tmpdir(),'canaveral-release-'));const metadata=join(dist,'release.json');
  try {
    const output=join(temporary,'bundle'), result=bundle(version,revision,images,output);
    for(const stage of ['orchestrator','dashboard','kubevirt']) run('kubectl',['kustomize',join(output,stage)]);
    const registry=await connect(DEPLOYMENT), candidate='candidate-'+version+'-'+revision;
    let artifact=await registry.manifest(candidate);
    const stable=await registry.manifest(version);
    const sourceRevision=tag+'@sha1:'+revision;
    if(stable) {
      checkIdentity(stable[0],version,sourceRevision,true);
      if(artifact && stable[1]!==artifact[1]) throw new Error('Stable deployment differs from its candidate.');
      artifact=stable;
    }
    if(!artifact) {
      if(finalize) throw new Error('Cannot finalize missing deployment artifact.');
      run('flux',['push','artifact','oci://'+DEPLOYMENT+':'+candidate,'--path',output,'--source',SOURCE,'--revision',sourceRevision,'--reproducible','--annotations','org.opencontainers.image.version='+version]);
      artifact=await registry.manifest(candidate);
    }
    if(!artifact) throw new Error('Deployment publication did not complete.');
    checkIdentity(artifact[0],version,sourceRevision,true);
    // Registry annotations are insufficient on retries: compare the actual
    // immutable bundle contents, with no ignored paths, to the rebuilt source.
    run('flux',['diff','artifact','oci://'+DEPLOYMENT+'@'+artifact[1],'--path',output,'--ignore-paths','']);
    result.deployment={url:'oci://'+DEPLOYMENT,tag:version,digest:artifact[1]};
    const text=JSON.stringify(result,null,2)+'\n';
    if(finalize && readFileSync(metadata,'utf8')!==text) throw new Error('Prepared release metadata differs.');
    if(!finalize) writeFileSync(metadata,text);
    if(finalize) {
      run('cosign',['verify','--new-bundle-format=false','--certificate-oidc-issuer','https://token.actions.githubusercontent.com','--certificate-identity',SOURCE+'/.github/workflows/release.yaml@refs/tags/'+tag,DEPLOYMENT+'@'+artifact[1]]);
      // Only complete, verified candidates enter the stable semver feed.
      // A failed signing/provenance step leaves no new selectable version.
      draftRelease(releases(),tag,revision);
      const current=await registry.manifest(version);
      if(current && current[1]!==artifact[1]) throw new Error('Stable deployment changed before promotion.');
      if(!current) run('flux',['tag','artifact','oci://'+DEPLOYMENT+'@'+artifact[1],'--tag',version]);
      const promoted=await registry.manifest(version);
      if(!promoted || promoted[1]!==artifact[1]) throw new Error('Stable deployment promotion was not confirmed.');
    }
  } finally {rmSync(temporary,{recursive:true,force:true});}
  // Recheck immediately before touching release assets; published releases are never edited.
  draftRelease(releases(),tag,revision);
  if(finalize) {
    run('gh',['release','upload',tag,metadata,'--clobber']);
    run('gh',['release','edit',tag,'--draft=false']);
  }
  console.log((finalize?'Published':'Prepared')+' Canaveral '+version+' at '+revision);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main(process.argv[2]==='--finalize').catch(()=>{console.error('Release publication failed. Inspect saved metadata, draft and registry state before retrying.');process.exitCode=1;});
