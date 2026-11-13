#!/usr/bin/env node
/** Publish reviewed images and an immutable Flux bundle. Run only with operator authorization. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, run } from './tasks.mjs';
import { uniqueJSON } from './json.mjs';
export const SOURCE='https://github.com/seventwo-studio/canaveral';
export const PACKAGE='ghcr.io/seventwo-studio/canaveral';
export const IMAGES={orchestrator:PACKAGE,dashboard:PACKAGE+'-dashboard',kubevirt:PACKAGE+'-kubevirt'};
const DIGEST=/^sha256:[a-f0-9]{64}$/;
export class Registry {
  constructor(packageName, authorization) { this.package=packageName.replace(/^ghcr\.io\//,'');this.authorization=authorization; }
  static async get(url,auth) {
    const parsed=new URL(url);
    if(parsed.protocol!=='https:' || parsed.hostname!=='ghcr.io' || parsed.username || parsed.password) throw new Error('Unexpected registry origin.');
    const response=await fetch(url,{headers:{Authorization:auth,Accept:'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json','User-Agent':'canaveral-release'},signal:AbortSignal.timeout(30_000),redirect:'error'});
    if(!response.ok) {const error=new Error('Registry request failed.');error.status=response.status;throw error;}
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
const capture=(command,args)=>execFileSync(command,args,{cwd:ROOT,encoding:'utf8',maxBuffer:8*1048576}).trim();
export async function main() {
  const tag=process.env.RELEASE_TAG;
  if(!/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(tag??'')) throw new Error('Stable release tag required.');
  const version=tag.slice(1), configured=uniqueJSON(readFileSync(join(ROOT,'package.json'),'utf8')).version;
  if(configured!==version) throw new Error('Release tag differs from package version.');
  const revision=capture('git',['rev-parse','HEAD']);
  run('git',['merge-base','--is-ancestor',revision,'origin/main']);
  if(capture('git',['rev-parse',tag+'^{commit}'])!==revision) throw new Error('Checked-out release identity differs.');
  draftRelease(uniqueJSON(capture('gh',['api','--paginate','--slurp','repos/seventwo-studio/canaveral/releases?per_page=100'])),tag,revision);
  const dist=join(ROOT,'dist');mkdirSync(dist,{recursive:true});
  const images={};
  for(const [stage,packageName] of Object.entries(IMAGES)) {
    let registry=await Registry.connect(packageName), found=await registry.manifest(version);
    if(found===null) {
      const annotations={'org.opencontainers.image.source':SOURCE,'org.opencontainers.image.version':version,'org.opencontainers.image.revision':revision};
      run('docker',['buildx','build','.', '--target',stage,'--platform','linux/amd64,linux/arm64','--push','--tag',packageName+':'+version,...Object.entries(annotations).flatMap(([k,v])=>['--label',k+'='+v,'--annotation','index:'+k+'='+v])]);
      registry=await Registry.connect(packageName);found=await registry.manifest(version);
    }
    if(!found) throw new Error('Image publication did not complete.');
    checkIdentity(found[0],version,revision);images[stage]=packageName+':'+version+'@'+found[1];
  }
  const temporary=mkdtempSync(join(tmpdir(),'canaveral-release-'));const metadata=join(dist,'release.json');
  try {
    const output=join(temporary,'bundle'), result=bundle(version,revision,images,output);
    for(const stage of ['orchestrator','dashboard','kubevirt']) run('kubectl',['kustomize',join(output,stage)]);
    const registry=await Registry.connect(PACKAGE);let artifact=await registry.manifest('deploy-'+version);
    const sourceRevision=tag+'@sha1:'+revision;
    if(!artifact) {
      run('flux',['push','artifact','oci://'+PACKAGE+':deploy-'+version,'--path',output,'--source',SOURCE,'--revision',sourceRevision,'--reproducible','--annotations','org.opencontainers.image.version='+version]);
      artifact=await registry.manifest('deploy-'+version);
    }
    if(!artifact) throw new Error('Deployment publication did not complete.');
    checkIdentity(artifact[0],version,sourceRevision,true);
    result.deployment={url:'oci://'+PACKAGE,tag:'deploy-'+version,digest:artifact[1]};
    writeFileSync(metadata,JSON.stringify(result,null,2)+'\n');
  } finally {rmSync(temporary,{recursive:true,force:true});}
  run('gh',['release','upload',tag,metadata,'--clobber']);run('gh',['release','edit',tag,'--draft=false']);
  console.log('Published Canaveral '+version+' at '+revision);
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(()=>{console.error('Release publication failed; inspect saved metadata and registry state before retrying.');process.exitCode=1;});
