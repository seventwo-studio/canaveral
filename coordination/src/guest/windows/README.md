# Windows guest components

`index.ts` exports the TypeScript guest implementation. `WindowsGuestWorker` accepts assignment authorization, optional cleanup authority, a file-root/path binding, trusted terminal executable configuration, an exclusive input-owner predicate, and a durable held-input persistence callback. `request(method, path, body)` is the internal dispatcher. `startWindowsGuestServer({worker, token, port})` is the explicit authenticated loopback HTTP boot entrypoint; it returns the actual port and a cleanup operation. No module starts a listener when imported.

The owner must bind these components to the assigned guest. They never select a guest, credential, enrollment policy or host fallback. HTTP bearer credentials are independent from UIA snapshot IDs, file IDs and terminal session IDs. Current assignment and exclusive UI input ownership must remain valid through acknowledgement. Authorization callbacks must be fast and synchronous.

## Native boot and packaging

`nativeTransport()` is Windows x64 only. It launches the fixed `native.ps1` using Windows PowerShell in an MTA. That script compiles the adjacent `native.cs` with system .NET Framework, UI Automation and drawing assemblies, then runs `NativeBridge.Serve()`. Requests and replies use four-byte big-endian lengths and correlated JSON. Ordinary native calls remain on that retained MTA; ConPTY operations use bounded parent lanes and independent native threads so output can be polled while input blocks. The helper starts lazily, is supervised, and never restarts or replays a request.

Ship `native.ps1` and `native.cs` together beside compiled `native.js`. TypeScript does not copy these assets. Development builds also locate them in `coordination/src/guest/windows`; a compiled-only installation without the assets fails closed. `protocol-fixture.mjs` is a disposable portable test helper and is never chosen by the production constructor.

## Interfaces

- `WindowsRoot` / `FilePin`: pinned relative handles, exact file metadata checks, no-follow/type/volume/single-link checks, bounded reads/listings, retained cleanup on failure.
- `WindowsDownloads` / `WindowsFileWorker`: `/v1/files/list`, `download/{begin,chunk,check,finish,verify}`, `status`, `abort`. UUIDs, paths and cursors stay bound to one generation. Finishing performs a second hash pass; only positive handle release permits `verified`.
- `WindowsStage`: exclusive creation, sequential partial writes, flush and second-pass verification, one-shot same-directory publication. Publication is explicitly `durable: false`. Unknown rename outcomes preserve the complete handle chain.
- `Win32Files.exists(parent,name)`: no-follow relative occupancy, including dangling reparse points. `publishOwned(handle,parent,name,replace=false)`: retained-parent atomic rename returning `published` or `exists`; only native name collision returns `exists`. These are primitives for the SDK's separately owned publication/durability protocol. A positive rename alone proves no namespace durability.
- `WindowsInputJournal`: two existing, checksummed, context-bound slots in a pre-provisioned pinned single-link file. No implicit creation/formatting or recovery from missing evidence. Supply its `save` and `recovered` to `WindowsHeldInput`.
- `WindowsHeldInput`, `WindowsKeys`, `Win32Desktop`: persist blocked old/possible-next union before input; confirm posting, final persistence and authorization before unblocking. Reset sends release events only. Unknown native input requires backend retirement even if release reconciliation succeeds.
- `WindowsInspections`: bounded control-view traversal, protected-content redaction, retained target references, single-use 15-second snapshots, ancestor/property/native-reference revalidation, guarded Invoke with unknown post-dispatch outcomes.
- `ConPTY`, `WindowsTerminalWorker`: `/v1/shell/{open,read,write,resize,close}`, separate input/read/lifecycle lanes, bounded output ring, exact write receipts, owned job cleanup. Process exit alone never confirms native job release.

Display capture is `/v1/display/capture`; held input is `/v1/input/{key,pointer,text,reset}`. Ordinary input requires the latest `frameId` and the next exact positive `sequence`. UIA uses `/v1/accessibility/{inspect,invoke}`. The service also maps supported legacy `/control` actions. Upload admission, display owner handoff and lease/provider integration remain external.

## Acceptance boundaries

Portable tests exercise injected native APIs and actual Node child-process/HTTP framing. They do not compile or execute the PowerShell/C# helper and establish no Windows API, ABI, filesystem, COM, ConPTY, desktop, process-containment or power-loss acceptance. The native implementation needs acceptance in an authorized Windows guest. In particular, sharing/rename compatibility, target-filesystem durability, UIA provider behavior, UIPI/secure desktops, focus/layout races, hung native cleanup and descendant containment remain unverified.

Staging publication and transfer records are volatile within a worker generation. Common upload routes remain unsupported because durable intent/receipt recovery and namespace barriers are not supplied by staging. Held input is enabled only with explicitly supplied durable persistence. These components do not establish VM termination, disk erasure or quota release.
