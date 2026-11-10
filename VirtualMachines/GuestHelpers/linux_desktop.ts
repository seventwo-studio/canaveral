/** Guest-only desktop bridge and AT-SPI normalization/action guards. Node 24+. */
import { randomUUID, timingSafeEqual, randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { homedir } from 'node:os';
export const REFERENCE_EPOCH = 978307200;
const now = (): number => Date.now() / 1000 - REFERENCE_EPOCH;
type Primitive = null | boolean | number | string;
export interface Bounds {
    x: number;
    y: number;
    width: number;
    height: number;
}
export interface Details {
    role: string;
    name: string;
    identifier: string;
    states: string[];
    actions: string[];
    bounds: Bounds | null;
    properties: Record<string, Primitive>;
}
export interface Node extends Details {
    id: string;
    parentId: string | null;
    depth: number;
    path: number[];
}
export interface Accessible {
    role(): string;
    name(): string;
    states(): string[];
    attributes(): string[];
    description(): string;
    text?(): {
        characterCount: number;
        getText(start: number, end: number): string;
    };
    value?(): {
        currentValue: number;
        minimumValue: number;
        maximumValue: number;
    };
    action?(): {
        names(): string[];
        invoke(index: number): boolean;
    };
    bounds?(): Bounds;
    childCount(): number;
    child(index: number): Accessible | null;
}
export interface Accessibility {
    desktop(): Accessible;
}
export function describe(accessible: Accessible): Details {
    const role = accessible.role(), name = accessible.name() || '';
    const states = accessible.states().map(s => s.replace('STATE_', '').toLowerCase());
    const properties: Record<string, Primitive> = {};
    for (const attr of accessible.attributes()) {
        const i = attr.indexOf(':');
        if (i >= 0)
            properties[attr.slice(0, i)] = attr.slice(i + 1);
    }
    if (!role.toLowerCase().includes('password') && !states.includes('protected')) {
        try {
            const t = accessible.text?.();
            if (t)
                properties.text = t.getText(0, Math.min(t.characterCount, 4096));
        }
        catch {
        }
        try {
            const v = accessible.value?.();
            if (v) {
                properties.value = v.currentValue;
                properties.minimum = v.minimumValue;
                properties.maximum = v.maximumValue;
            }
        }
        catch {
        }
    }
    properties.description = accessible.description() || '';
    let actions: string[] = [];
    let bounds: Bounds | null = null;
    try {
        actions = [...(accessible.action?.().names() ?? [])];
    }
    catch {
    }
    try {
        const rect = accessible.bounds?.();
        bounds = rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
    }
    catch {
    }
    return { role, name, identifier: String(properties.id ?? properties['accessible-id'] ?? ''), states, actions, bounds, properties };
}
export function captureAccessibility(api: Accessibility, clock: () => number = () => performance.now() / 1000): {
    nodes: Node[];
    truncated: boolean;
    unavailableNodes: number;
} {
    const nodes: Node[] = [];
    let truncated = false, unavailableNodes = 0;
    const deadline = clock() + 3;
    const walk = (accessible: Accessible, path: number[], parentId: string | null = null, depth = 0): void => {
        if (nodes.length >= 1500 || depth > 25 || clock() > deadline) {
            truncated = true;
            return;
        }
        try {
            const details = describe(accessible);
            const id = 'ax-' + (nodes.length + 1);
            nodes.push({ id, parentId, depth, path, ...details });
            const count = accessible.childCount();
            if (count > 1500)
                truncated = true;
            for (let i = 0; i < Math.min(count, 1500); i++) {
                if (clock() > deadline) {
                    truncated = true;
                    break;
                }
                const child = accessible.child(i);
                if (child)
                    walk(child, [...path, i], id, depth + 1);
            }
        }
        catch {
            unavailableNodes++;
        }
    };
    walk(api.desktop(), []);
    return { nodes, truncated, unavailableNodes };
}
/** 42: confirmed refusal before native invocation. 43: invocation began, effects unknown. */
export function performAccessibility(request: unknown, api: Accessibility, clock: () => number = () => performance.now() / 1000): 0 | 42 | 43 {
    let iface: NonNullable<ReturnType<NonNullable<Accessible['action']>>>;
    let matched: number;
    try {
        if (!request || typeof request !== 'object' || Array.isArray(request) || !isDeepStrictEqual(Object.keys(request).sort(), ['action', 'chain', 'expiresAt', 'startedAt']))
            throw new Error('Invalid action context');
        const r = request as {
            chain: Node[];
            action: string;
            startedAt: number;
            expiresAt: number;
        };
        const { startedAt: start, expiresAt: end } = r;
        if (typeof start !== 'number' || typeof end !== 'number' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end - start <= 0 || end - start > 15)
            throw new Error('Invalid action lifetime');
        const fresh = (): void => {
            const t = clock();
            if (t < start || t >= end)
                throw new Error('Expired action context');
        };
        fresh();
        if (!Array.isArray(r.chain) || r.chain.length < 1 || r.chain.length > 31 || typeof r.action !== 'string')
            throw new Error('Invalid action path');
        let target = api.desktop();
        let previous: number[] = [];
        const seen = new Set<string>();
        for (const [i, node] of r.chain.entries()) {
            fresh();
            const path = node.path;
            if (!Array.isArray(path) || path.some(n => !Number.isInteger(n) || n < 0) || (i === 0 ? path.length !== 0 : path.length !== previous.length + 1 || !isDeepStrictEqual(path.slice(0, -1), previous)))
                throw new Error('Incomplete parent path');
            if (typeof node.id !== 'string' || seen.has(node.id) || node.parentId !== (i === 0 ? null : r.chain[i - 1]!.id))
                throw new Error('Ambiguous parent path');
            seen.add(node.id);
            if (i) {
                const child = target.child(path.at(-1)!);
                if (!child)
                    throw new Error('Target missing');
                target = child;
            }
            const expected = { role: node.role, name: node.name, identifier: node.identifier, states: node.states, actions: node.actions, bounds: node.bounds, properties: node.properties };
            if (!isDeepStrictEqual(describe(target), expected))
                throw new Error('Target context changed');
            previous = path;
        }
        if (!r.chain.at(-1)!.actions.includes(r.action))
            throw new Error('Action was not inspected');
        const action = target.action?.();
        if (!action)
            throw new Error('Action unavailable');
        iface = action;
        const matches = iface.names().flatMap((name, i) => name === r.action ? [i] : []);
        if (matches.length !== 1)
            throw new Error('Action unavailable or ambiguous');
        matched = matches[0]!;
        fresh();
    }
    catch {
        return 42;
    }
    try {
        return iface.invoke(matched) ? 0 : 43;
    }
    catch {
        return 43;
    }
}
export interface Frame {
    id: string;
    capturedAt: number;
    width?: number;
    height?: number;
    pngBase64?: string;
}
export interface Desktop {
    capture(): Frame | Promise<Frame>;
    perform(action: Action): void | Promise<void>;
}
export interface Action {
    id?: string;
    frameID?: string;
    human?: boolean;
    kind?: string;
    x?: number;
    y?: number;
    delta?: number;
    key?: string;
    text?: string;
    userControl?: boolean;
    snapshotId?: string;
    nodeId?: string;
    nativeAction?: string;
}
interface Receipt {
    id: string;
    status: 'uncertain' | 'posted' | 'rejected';
    arguments?: string;
}
function canonical(value: unknown): string {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
    return JSON.stringify(value);
}
function uuid(value: unknown): string {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
        throw new Error('Invalid UUID');
    return value.toLowerCase();
}
export function atomicJson(path: string, value: unknown): void {
    const temporary = path + '.' + randomUUID() + '.tmp';
    const fd = openSync(temporary, 'wx', 0o600);
    try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
    try {
        renameSync(temporary, path);
        const parent = openSync(dirname(path), 'r');
        try {
            fsyncSync(parent);
        }
        finally {
            closeSync(parent);
        }
    }
    finally {
        if (existsSync(temporary))
            unlinkSync(temporary);
    }
}
export class Bridge {
    readonly frames = new Map<string, number>();
    readonly receipts: Record<string, Receipt>;
    userControl: boolean;
    private queue: Promise<void> = Promise.resolve();
    readonly desktop: Desktop;
    readonly token: string;
    readonly root: string;
    readonly clock: () => number;
    readonly accessibility: AccessibilityWorker;
    private readonly inspections = new Map<string, {
        snapshot: NativeSnapshot;
        started: number;
    }>();
    constructor(desktop: Desktop, token: string, root: string, clock: () => number = now, accessibility: AccessibilityWorker = new NativeAccessibility()) {
        this.desktop = desktop;
        this.token = token;
        this.root = root;
        this.clock = clock;
        this.accessibility = accessibility;
        mkdirSync(root, { recursive: true, mode: 0o700 });
        chmodSync(root, 0o700);
        this.userControl = existsSync(join(root, 'control.json')) ? (JSON.parse(readFileSync(join(root, 'control.json'), 'utf8')) as {
            userControl: boolean;
        }).userControl : false;
        this.receipts = existsSync(join(root, 'inputs.json')) ? JSON.parse(readFileSync(join(root, 'inputs.json'), 'utf8')) as Record<string, Receipt> : {};
        if (typeof this.userControl !== 'boolean' || !this.receipts || Array.isArray(this.receipts))
            throw new Error('Invalid persisted desktop state');
    }
    request(path: string, action?: Action): Promise<unknown> {
        const result = this.queue.then(() => this.handle(path, action));
        this.queue = result.then(() => {
        }, () => {
        });
        return result;
    }
    private async handle(path: string, action?: Action): Promise<unknown> {
        if (path === '/v1/accessibility/inspect' && action === undefined) {
            const started = performance.now() / 1000;
            const snapshot = validateNativeSnapshot(await this.accessibility.capture());
            for (const [id, value] of this.inspections)
                if (started - value.started >= 15)
                    this.inspections.delete(id);
            while (this.inspections.size >= 16)
                this.inspections.delete(this.inspections.keys().next().value!);
            const snapshotId = randomUUID();
            this.inspections.set(snapshotId, { snapshot: structuredClone(snapshot), started });
            return { snapshotId, capturedAt: Date.now() / 1000, source: 'linux-atspi', coordinateSpace: 'screen-pixels',
                nodes: snapshot.nodes, truncated: snapshot.truncated, unavailableNodes: snapshot.unavailableNodes };
        }
        if (path === '/v1/accessibility/invoke' && action !== undefined)
            return this.invokeAccessibility(action);
        if (path === '/v1/desktop/control' && action !== undefined) {
            if (typeof action.userControl !== 'boolean')
                throw new Error('Invalid control request');
            atomicJson(join(this.root, 'control.json'), { userControl: action.userControl });
            this.userControl = action.userControl;
            this.frames.clear();
            this.inspections.clear();
            return { userControl: this.userControl };
        }
        if (['/v1/desktop', '/v1/desktop/session'].includes(path) && action === undefined) {
            const frame = await this.desktop.capture();
            for (const [key, stamp] of this.frames)
                if (this.clock() - stamp >= 180 || this.clock() < stamp)
                    this.frames.delete(key);
            if (this.frames.size >= 180) {
                const oldest = [...this.frames.entries()].sort((a, b) => a[1] - b[1])[0];
                if (oldest)
                    this.frames.delete(oldest[0]);
            }
            this.frames.set(uuid(frame.id), frame.capturedAt);
            return path.endsWith('/session') ? { frame, userControl: this.userControl } : frame;
        }
        if (path !== '/v1/desktop/action' || !action)
            throw new Error('Unknown endpoint');
        const id = uuid(action.id);
        const args = canonical(action);
        const receipt = this.receipts[id];
        if (receipt) {
            if (receipt.arguments && receipt.arguments !== args)
                throw new Error('Input ID reused with different arguments');
            if (receipt.status !== 'posted')
                throw new Error('Uncertain action will not be replayed; inspect the desktop');
            return structuredClone(receipt);
        }
        if ((action.human === true) !== this.userControl)
            throw new Error('Desktop is controlled by someone else');
        const captured = this.frames.get(uuid(action.frameID));
        if (captured === undefined || this.clock() < captured || this.clock() - captured >= 180)
            throw new Error('Capture a fresh guest frame before acting');
        validateAction(action);
        this.receipts[id] = { id, status: 'uncertain', arguments: args };
        atomicJson(join(this.root, 'inputs.json'), this.receipts);
        // Invalidate every inspected frame before the native call, including on an uncertain failure.
        this.frames.clear();
        this.inspections.clear();
        await this.desktop.perform(action);
        this.receipts[id]!.status = 'posted';
        atomicJson(join(this.root, 'inputs.json'), this.receipts);
        return structuredClone(this.receipts[id]);
    }
    private async invokeAccessibility(action: Action): Promise<Receipt> {
        if (Object.keys(action).some(k => !['id', 'snapshotId', 'nodeId', 'nativeAction', 'human'].includes(k)) ||
            typeof action.nodeId !== 'string' || typeof action.nativeAction !== 'string' ||
            (action.human !== undefined && typeof action.human !== 'boolean'))
            throw new Error('Invalid native action');
        const id = uuid(action.id), snapshotId = uuid(action.snapshotId);
        const args = canonical({ endpoint: '/v1/accessibility/invoke', action });
        const receipt = this.receipts[id];
        if (receipt) {
            if (receipt.arguments !== args)
                throw new Error('Input ID reused with different arguments');
            if (receipt.status === 'rejected')
                throw new Error('Native input was refused; capture a fresh snapshot');
            if (receipt.status !== 'posted')
                throw new Error('Uncertain action will not be replayed; inspect the desktop');
            return structuredClone(receipt);
        }
        if ((action.human === true) !== this.userControl)
            throw new Error('Desktop is controlled by someone else');
        const saved = this.inspections.get(snapshotId);
        if (!saved || performance.now() / 1000 - saved.started >= 15)
            throw new Error('Capture a fresh native snapshot before acting');
        const byId = new Map(saved.snapshot.nodes.map(n => [n.id, n]));
        let node = byId.get(action.nodeId);
        if (!node || !node.actions.includes(action.nativeAction))
            throw new Error('Native target/action was not inspected');
        const chain: Node[] = [], seen = new Set<string>();
        while (node) {
            if (seen.has(node.id) || chain.length >= 31)
                throw new Error('Ambiguous native parent chain');
            seen.add(node.id);
            chain.unshift(node);
            if (node.parentId === null)
                break;
            node = byId.get(node.parentId);
            if (!node)
                throw new Error('Incomplete native parent chain');
        }
        const context: NativeActionContext = { chain, action: action.nativeAction, startedAt: saved.snapshot.startedAt, expiresAt: saved.snapshot.expiresAt };
        this.receipts[id] = { id, status: 'uncertain', arguments: args };
        atomicJson(join(this.root, 'inputs.json'), this.receipts);
        this.frames.clear();
        this.inspections.clear();
        const code = await this.accessibility.perform(context);
        if (code === 42) {
            this.receipts[id]!.status = 'rejected';
            atomicJson(join(this.root, 'inputs.json'), this.receipts);
            throw new Error('Native input was refused; capture a fresh snapshot');
        }
        if (code !== 0)
            throw new Error('Native input outcome is uncertain; inspect before further input');
        this.receipts[id]!.status = 'posted';
        atomicJson(join(this.root, 'inputs.json'), this.receipts);
        return structuredClone(this.receipts[id]!);
    }
}
export function validateAction(action: Action): void {
    switch (action.kind) {
        case 'click':
            if ([action.x, action.y].some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1))
                throw new Error('Invalid normalized coordinates');
            break;
        case 'scroll':
            if (!Number.isInteger(action.delta) || !action.delta || Math.abs(action.delta) > 20)
                throw new Error('Invalid scroll amount');
            break;
        case 'key': {
            if (typeof action.key !== 'string' || !action.key || action.key.length > 80)
                throw new Error('Invalid shortcut');
            const parts = action.key.toLowerCase().split('+');
            if (parts.slice(0, -1).some(p => !['ctrl', 'alt', 'shift', 'super'].includes(p)) || !parts.at(-1))
                throw new Error('Unsupported shortcut modifier');
            break;
        }
        case 'typeText':
            if (typeof action.text !== 'string' || !action.text || action.text.length > 2000)
                throw new Error('Invalid text');
            break;
        default: throw new Error('Unknown desktop action');
    }
}
const run = (path: string, args: string[], maxBuffer = 1024 * 1024): Promise<Buffer> => new Promise((resolve, reject) => execFile(path, args, { encoding: 'buffer', timeout: 10000, maxBuffer, env: { DISPLAY: process.env.DISPLAY ?? ':0', XAUTHORITY: process.env.XAUTHORITY ?? join(homedir(), '.Xauthority'), PATH: '/usr/bin:/bin', HOME: homedir() } }, (error, stdout) => error ? reject(error) : resolve(stdout)));
/** Installed X11 command adapter. Never used without the explicit isolated-guest CLI gate. */
export class X11Desktop implements Desktop {
    constructor() {
        if (process.platform !== 'linux' || process.env.XDG_SESSION_TYPE === 'wayland')
            throw new Error('Linux Xorg required; Wayland control is unavailable');
    }
    private async size(): Promise<[
        number,
        number
    ]> {
        const parts = (await run('/usr/bin/xdotool', ['getdisplaygeometry'])).toString().trim().split(/\s+/).map(Number);
        const w = parts[0]!, h = parts[1]!;
        if (parts.length !== 2 || ![w, h].every(n => Number.isInteger(n) && n > 0 && n <= 8192))
            throw new Error('Unsupported guest display size');
        return [w, h];
    }
    async capture(): Promise<Frame> {
        const [w, h] = await this.size();
        const png = await run('/usr/bin/import', ['-window', 'root', '-resize', '1280x>', 'png:-'], 32 * 1024 * 1024);
        if (!png.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
            throw new Error('X11 capture failed');
        const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
        const scale = Math.min(1, 1280 / w);
        if (width !== Math.max(1, Math.round(w * scale)) || height < 1 || height > h)
            throw new Error('Unexpected capture geometry');
        return { id: randomUUID(), capturedAt: now(), width, height, pngBase64: png.toString('base64') };
    }
    async perform(action: Action): Promise<void> {
        validateAction(action);
        let args: string[];
        switch (action.kind) {
            case 'click': {
                const [w, h] = await this.size();
                args = ['mousemove', '--sync', String(Math.floor(action.x! * (w - 1))), String(Math.floor(action.y! * (h - 1))), 'click', '1'];
                break;
            }
            case 'scroll':
                args = ['click', '--repeat', String(Math.abs(action.delta!)), action.delta! > 0 ? '4' : '5'];
                break;
            case 'key': {
                const aliases: Record<string, string> = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', super: 'super', return: 'Return', tab: 'Tab', escape: 'Escape', delete: 'BackSpace', space: 'space', left: 'Left', right: 'Right', up: 'Up', down: 'Down' };
                const parts = action.key!.toLowerCase().split('+');
                const key = parts.at(-1)!;
                if (!(key in aliases) && !/^[a-z0-9]$/.test(key) && !/^f([1-9]|1[0-2])$/.test(key))
                    throw new Error('Unsupported key');
                args = ['key', '--clearmodifiers', parts.map(p => aliases[p] ?? p).join('+')];
                break;
            }
            case 'typeText':
                if (!/^[\x20-\x7e\n\t]+$/.test(action.text!))
                    throw new Error('Native Unicode keyboard mapping is unavailable');
                args = ['type', '--clearmodifiers', '--delay', '0', '--', action.text!];
                break;
            default: throw new Error('Unknown desktop action');
        }
        await run('/usr/bin/xdotool', args);
    }
}
export function serve(bridge: Bridge): ReturnType<typeof createServer> {
    const server = createServer((req, res) => {
        const reply = (status: number, payload: unknown): void => {
            const data = JSON.stringify(payload);
            res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store', Connection: 'close' });
            res.end(data);
        };
        const expected = Buffer.from('Bearer ' + bridge.token), supplied = Buffer.from(req.headers.authorization ?? '');
        const authCount = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'authorization').length;
        if (authCount !== 1 || expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
            reply(401, { message: 'Guest credential rejected' });
            return;
        }
        if (req.headers.origin !== undefined) {
            reply(403, { message: 'Browser clients are not supported' });
            return;
        }
        if (!['GET', 'POST'].includes(req.method ?? '')) {
            reply(405, { message: 'Unsupported method' });
            return;
        }
        const lengths = req.rawHeaders.filter((_, i) => i % 2 === 0 && req.rawHeaders[i]!.toLowerCase() === 'content-length').length;
        const length = Number(req.headers['content-length'] ?? 0);
        if (req.headers['transfer-encoding'] !== undefined || lengths > 1 || !Number.isSafeInteger(length) || length < 0 || length > 32768) {
            reply(409, { message: 'Ambiguous or oversized request' });
            return;
        }
        let bytes = 0;
        const chunks: Buffer[] = [];
        req.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 32768)
                req.destroy();
            else
                chunks.push(chunk);
        });
        req.on('end', () => {
            void (async () => {
                try {
                    if (bytes !== length)
                        throw new Error('Incomplete request');
                    const value = req.method === 'POST' ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Action : undefined;
                    if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value)))
                        throw new Error('Invalid action');
                    reply(200, await bridge.request(req.url ?? '', value));
                }
                catch {
                    reply(409, { message: 'Guest request failed. Capture again and inspect before retrying input.' });
                }
            })();
        });
    });
    server.requestTimeout = 20000;
    server.headersTimeout = 20000;
    server.timeout = 20000;
    return server;
}
export interface NativeSnapshot {
    nodes: Node[];
    truncated: boolean;
    unavailableNodes: number;
    startedAt: number;
    expiresAt: number;
}
export interface NativeActionContext {
    chain: Node[];
    action: string;
    startedAt: number;
    expiresAt: number;
}
export interface AccessibilityWorker {
    capture(): Promise<NativeSnapshot>;
    perform(context: NativeActionContext): Promise<0 | 42 | 43>;
}
export interface NativeResult {
    code: number | null;
    stdout: Buffer;
}
export type NativeRunner = (mode: 'inspect' | 'action', input?: Buffer) => Promise<NativeResult>;
const NATIVE_MAX_BYTES = 6 * 1048576;
/** One process per operation; native D-Bus stalls cannot block the HTTP event loop or replay input. */
export const runNativeAccessibility: NativeRunner = async (mode, input) => {
    if (process.platform !== 'linux')
        throw new Error('Native AT-SPI requires an isolated Linux guest');
    const executable = process.env.CANAVERAL_ATSPI_HELPER ?? '/sbin/canaveral-guest-agent';
    if (!isAbsolute(executable))
        throw new Error('Configure an absolute native guest helper path');
    const env: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: homedir() };
    for (const key of ['DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'LANG']) {
        if (process.env[key] !== undefined)
            env[key] = process.env[key];
    }
    return await new Promise<NativeResult>((resolveResult) => {
        const child = execFile(executable, [`--atspi-${mode}`, '--guest-confirmed'], {
            encoding: 'buffer', timeout: 5000, killSignal: 'SIGKILL', maxBuffer: NATIVE_MAX_BYTES, env,
        }, (error, stdout) => {
            const code = error === null ? 0 : typeof error.code === 'number' ? error.code :
                ['ENOENT', 'EACCES', 'ENOEXEC'].includes(String(error.code)) ? 42 : null;
            resolveResult({ code, stdout });
        });
        child.stdin?.on('error', () => {
        });
        child.stdin?.end(input);
    });
};
export class NativeAccessibility implements AccessibilityWorker {
    private readonly runner: NativeRunner;
    constructor(runner: NativeRunner = runNativeAccessibility) {
        this.runner = runner;
    }
    async capture(): Promise<NativeSnapshot> {
        const result = await this.runner('inspect');
        if (result.code !== 0 || result.stdout.length > NATIVE_MAX_BYTES)
            throw new Error('Native AT-SPI snapshot unavailable');
        return validateNativeSnapshot(JSON.parse(result.stdout.toString('utf8')));
    }
    async perform(context: NativeActionContext): Promise<0 | 42 | 43> {
        const input = Buffer.from(JSON.stringify(context));
        if (input.length > NATIVE_MAX_BYTES)
            return 42;
        try {
            const result = await this.runner('action', input);
            return result.code === 0 ? 0 : result.code === 42 ? 42 : 43;
        }
        catch {
            return 43;
        }
    }
}
export function validateNativeSnapshot(value: unknown): NativeSnapshot {
    const fail = (): never => {
        throw new Error('Invalid native accessibility snapshot');
    };
    if (!value || typeof value !== 'object')
        fail();
    const s = value as NativeSnapshot;
    if (!Array.isArray(s.nodes) || s.nodes.length < 1 || s.nodes.length > 1500 || typeof s.truncated !== 'boolean' ||
        !Number.isSafeInteger(s.unavailableNodes) || s.unavailableNodes < 0 || typeof s.startedAt !== 'number' || typeof s.expiresAt !== 'number' ||
        !Number.isFinite(s.startedAt) || !Number.isFinite(s.expiresAt) || s.startedAt < 0 || s.expiresAt <= s.startedAt || s.expiresAt - s.startedAt > 15)
        fail();
    const seen = new Map<string, Node>();
    for (const [i, n] of s.nodes.entries()) {
        if (!n || typeof n !== 'object' || typeof n.id !== 'string' || !n.id || seen.has(n.id) ||
            !Array.isArray(n.path) || n.path.length > 25 || n.path.some(p => !Number.isSafeInteger(p) || p < 0 || p > 2147483647) ||
            !Number.isInteger(n.depth) || n.depth !== n.path.length ||
            !['role', 'name', 'identifier'].every(k => typeof (n as unknown as Record<string, unknown>)[k] === 'string') ||
            !Array.isArray(n.actions) || n.actions.length > 128 || n.actions.some(a => typeof a !== 'string') ||
            !Array.isArray(n.states) || n.states.some(a => typeof a !== 'string') ||
            !n.properties || typeof n.properties !== 'object' || Array.isArray(n.properties) ||
            Object.values(n.properties).some(v => v !== null && !['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)))
            fail();
        if (n.bounds !== null && (!n.bounds || !['x', 'y', 'width', 'height'].every(k => Number.isSafeInteger((n.bounds as unknown as Record<string, unknown>)[k]))))
            fail();
        if (i === 0) {
            if (n.parentId !== null || n.path.length !== 0)
                fail();
        }
        else {
            const parent = typeof n.parentId === 'string' ? seen.get(n.parentId) : undefined;
            if (!parent || n.path.length !== parent.path.length + 1 || !isDeepStrictEqual(n.path.slice(0, -1), parent.path))
                fail();
        }
        seen.set(n.id, n);
    }
    return s;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.platform !== 'linux' || !process.argv.includes('--guest-confirmed'))
        throw new Error('Run inside an isolated Linux VM with --guest-confirmed');
    const root = join(homedir(), '.local/state/seven-guest');
    mkdirSync(root, { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const credential = join(root, 'credential');
    if (!existsSync(credential)) {
        const fd = openSync(credential, 'wx', 0o600);
        try {
            writeFileSync(fd, randomBytes(32).toString('base64url'));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    const token = readFileSync(credential, 'utf8').trim();
    if (!token)
        throw new Error('Empty guest credential');
    if (process.argv.includes('--show-credential'))
        process.stdout.write(token + '\n');
    else
        serve(new Bridge(new X11Desktop(), token, root)).listen(8767, '127.0.0.1');
}
