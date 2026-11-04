"""Curated publisher sources. Resolve a channel once, then pin its artifact."""
import copy
import json
import re
import urllib.parse
import urllib.request

from .model import Error


def catalogue():
    entries=[]
    def add(id,name,publisher,os,arch,media,format,page,resolver=None,**extra):
        entries.append(dict(id=id,name=name,publisher=publisher,os=os,arch=arch,mode='desktop',mediaType=media,format=format,
                            sourcePage=page,resolver=resolver,status='available' if resolver else 'manual',
                            minimum={'cpu':2,'memoryMiB':4096,'diskGiB':64 if os in ('macos','windows') else 32},**extra))
    add('macos-supported','macOS · latest supported restore','Apple','macos','arm64','installer','ipsw',
        'https://developer.apple.com/documentation/virtualization/installing-macos-on-a-virtual-machine','apple',
        note='Resolved by Apple on the selected Apple silicon Mac. macOS installation and guest access have separate runtime requirements.')
    for arch in ('amd64','arm64'):
        for release in ('24.04','26.04'):
            for flavor in ('desktop','server'):
                add(f'ubuntu-{release}-{flavor}-{arch}',f'Ubuntu {release} LTS · {flavor}','Canonical','linux',arch,'installer','iso',
                    f'https://releases.ubuntu.com/{release}/','ubuntu-iso',release=release,flavor=flavor,
                    note='Installation media. Requires an installer console; guest desktop services start after OS installation.')
        add(f'ubuntu-noble-cloud-{arch}','Ubuntu 24.04 LTS · cloud disk','Canonical','linux',arch,'disk','qcow2',
            'https://cloud-images.ubuntu.com/noble/current/','ubuntu-cloud',
            note='Installed cloud disk. Canaveral can provision its Linux desktop, files and shell automatically.')
        add(f'debian-stable-netinst-{arch}','Debian stable · network installer','Debian','linux',arch,'installer','iso',
            'https://www.debian.org/CD/netinst/','debian',note='Small installer; downloads packages during installation.')
        add(f'fedora-workstation-{arch}','Fedora Workstation · stable','Fedora Project','linux',arch,'installer','iso',
            'https://fedoraproject.org/workstation/download/','fedora',note='Latest stable Workstation ISO from the official release feed; prereleases are excluded.')
        add(f'windows-11-iso-{arch}','Windows 11 · installation ISO','Microsoft','windows',arch,'installer','iso',
            'https://www.microsoft.com/en-us/software-download/windows11'+('arm64' if arch=='arm64' else ''),
            note='Choose edition and language on Microsoft’s site, then import the downloaded ISO. Activation and runtime support are separate.')
        add(f'windows-11-evaluation-{arch}','Windows 11 Enterprise · evaluation','Microsoft','windows',arch,'installer','iso',
            'https://www.microsoft.com/en-us/evalcenter/evaluate-windows-11-enterprise',note='Microsoft registration is required. Evaluation is time limited; download from Microsoft, then import.')
    add('windows-development-vm','Windows development VM','Microsoft','windows','amd64','disk','vhdx',
        'https://developer.microsoft.com/en-us/windows/downloads/virtual-machines/',note='The former prebuilt VM download page currently redirects to developer-tool documentation. Import an existing licensed development disk or use official installation media.')
    entries[-1]['status']='unavailable'
    return entries


def entry(id):
    found=next((item for item in catalogue() if item['id']==id),None)
    if not found:raise Error('Unknown base image registry entry.',404)
    return copy.deepcopy(found)


HOSTS={'releases.ubuntu.com','cdimage.ubuntu.com','cloud-images.ubuntu.com','cdimage.debian.org',
       'chuangtzu.ftp.acc.umu.se','fedoraproject.org','dl.fedoraproject.org','download.fedoraproject.org'}


def allowed_url(url):
    parsed=urllib.parse.urlsplit(url)
    host=parsed.hostname or ''
    if parsed.scheme!='https' or parsed.username or parsed.password or parsed.fragment or parsed.port not in (None,443):return False
    return host in HOSTS or host.endswith('.cdn-apple.com') or host=='cdn-apple.com'


class PublisherRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        if not allowed_url(newurl):raise Error('Publisher redirected outside the registry download origins.',400)
        return super().redirect_request(req,fp,code,msg,headers,newurl)


def open_source(url,method='GET'):
    if not allowed_url(url):raise Error('Image source is outside the official registry origins.',400)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),PublisherRedirect)
    try:return opener.open(urllib.request.Request(url,method=method,headers={'User-Agent':'Canaveral-image-registry/1','Accept-Encoding':'identity'}),timeout=25)
    except Error:raise
    except Exception:raise Error('Publisher metadata or download is unavailable. Check the source and retry with a new import ID.',503)


def metadata(url):
    with open_source(url) as response:data=response.read(2097153)
    if len(data)>2097152:raise Error('Publisher metadata exceeds its bounded envelope.',400)
    return data.decode('utf-8')


def checksums(content):
    result={}
    for line in content.splitlines():
        match=re.fullmatch(r'([a-fA-F0-9]{64})\s+\*?([A-Za-z0-9_.+-]+)',line.strip())
        if match:result[match[2]]=match[1].lower()
    return result


def file_version(name):
    match=re.match(r'^(?:ubuntu|debian)-([0-9]+(?:\.[0-9]+)*)-',name)
    return tuple(int(part) for part in match[1].split('.')) if match else ()


def validate_source(source):
    if not isinstance(source,dict) or set(source)!={'url','sha256','bytes','version'} or not allowed_url(source['url']):raise Error('Invalid resolved registry source.',400)
    if source['sha256'] is not None and (not isinstance(source['sha256'],str) or not re.fullmatch('[a-f0-9]{64}',source['sha256'])):raise Error('Invalid publisher checksum.',400)
    if type(source['bytes']) is not int or not 512<=source['bytes']<=2**53:raise Error('Publisher did not supply a valid artifact length.',400)
    if not isinstance(source['version'],str) or not 1<=len(source['version'])<=200:raise Error('Invalid registry source version.',400)
    return source


def validate_entry_source(item,source):
    validate_source(source);host=urllib.parse.urlsplit(source['url']).hostname;path=urllib.parse.urlsplit(source['url']).path
    origins={'ubuntu-iso':{'releases.ubuntu.com','cdimage.ubuntu.com'},'ubuntu-cloud':{'cloud-images.ubuntu.com'},
             'debian':{'cdimage.debian.org'},'fedora':{'dl.fedoraproject.org'}}
    if item['resolver']=='apple':
        if not host.endswith('.cdn-apple.com') or not path.lower().endswith('.ipsw'):raise Error('macOS source must be an Apple restore archive.',400)
    elif host not in origins.get(item['resolver'],set()) or not source['sha256']:
        raise Error('Registry source must match its publisher and include a checksum.',400)
    return source


def resolve(item,runtime=None):
    resolver=item['resolver'];arch=item['arch'];sha=None
    if not resolver:raise Error('This entry requires a publisher download and file import.',409)
    if resolver in ('ubuntu-iso','ubuntu-cloud','debian'):
        if resolver=='ubuntu-cloud':
            root='https://cloud-images.ubuntu.com/noble/current/';pattern=rf'noble-server-cloudimg-{arch}\.img'
        elif resolver=='ubuntu-iso':
            release=re.escape(item['release']);flavor='desktop' if item['flavor']=='desktop' else 'live-server'
            root=(f'https://releases.ubuntu.com/{item["release"]}/' if arch=='amd64' else f'https://cdimage.ubuntu.com/releases/{item["release"]}/release/')
            if arch=='arm64' and item['flavor']=='desktop':root=f'https://cdimage.ubuntu.com/ubuntu/releases/{item["release"]}/release/'
            pattern=rf'ubuntu-{release}(?:\.[0-9]+)*-{flavor}-{arch}\.iso'
        else:
            root=f'https://cdimage.debian.org/debian-cd/current/{arch}/iso-cd/';pattern=rf'debian-[0-9.]+-{arch}-netinst\.iso'
        sums=checksums(metadata(root+'SHA256SUMS'));names=[name for name in sums if re.fullmatch(pattern,name)]
        if not names:raise Error('Publisher currently lists no matching stable image for this architecture.',409)
        name=max(names,key=file_version)
        url=root+name;sha=sums[name];version=name
    elif resolver=='fedora':
        rows=json.loads(metadata('https://fedoraproject.org/releases.json'))
        target={'amd64':'x86_64','arm64':'aarch64'}[arch]
        matches=[r for r in rows if r.get('variant')=='Workstation' and r.get('arch')==target and str(r.get('version','')).isdigit() and r.get('link','').endswith('.iso')]
        if not matches:raise Error('Fedora currently lists no stable Workstation ISO for this architecture.',409)
        chosen=max(matches,key=lambda r:int(r['version']));sha=chosen['sha256'];version=chosen['version']
        # Use Fedora's own origin rather than an arbitrary mirror redirect.
        parsed=urllib.parse.urlsplit(chosen['link']);url=urllib.parse.urlunsplit(('https','dl.fedoraproject.org',parsed.path,'',''))
    elif resolver=='apple':
        if not runtime or runtime.config['provider']!='apple':raise Error('Resolve macOS on an Apple silicon Mac with the Apple runtime.',409)
        from .providers.base import run
        restore=json.loads(run([runtime.config['runner'],'restore-image'],timeout=60));url=restore['url'];version=restore['version']+' ('+restore['build']+')'
    else:raise Error('Unsupported registry resolver.',400)
    with open_source(url,'HEAD') as response:
        try:size=int(response.headers['Content-Length'])
        except (TypeError,ValueError):raise Error('Publisher must supply the image length before capacity is reserved.',409)
    return validate_source(dict(url=url,sha256=sha,bytes=size,version=version))
