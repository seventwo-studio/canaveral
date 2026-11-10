import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { Bridge, REFERENCE_EPOCH, captureAccessibility, describe, performAccessibility, serve, validateAction, NativeAccessibility, validateNativeSnapshot } from './linux_desktop.ts';
import type { Action, Accessible, Bounds, Frame, Node, NativeSnapshot, NativeActionContext, AccessibilityWorker } from './linux_desktop.ts';
class FixtureDesktop {
    calls = 0;
    fail = false;
    capture(): Frame {
        return { id: randomUUID(), capturedAt: Date.now() / 1000 - REFERENCE_EPOCH };
    }
    perform(): void {
        this.calls++;
        if (this.fail)
            throw new Error('Interrupted after input may have posted');
    }
}
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'guest-desktop-'));
    const desktop = new FixtureDesktop();
    const bridge = new Bridge(desktop, 'fixture-token', root);
    return { root, desktop, bridge, close: () => rmSync(root, { recursive: true, force: true }) };
}
const input = (frame: Frame): Action => ({ id: randomUUID(), frameID: frame.id, kind: 'key', key: 'return' });
test('posted input is deduplicated durably and changed arguments are refused', async () => {
    const f = fixture();
    try {
        const frame = await f.bridge.request('/v1/desktop') as Frame;
        const action = input(frame);
        assert.equal((await f.bridge.request('/v1/desktop/action', action) as {
            status: string;
        }).status, 'posted');
        const reopened = new Bridge(f.desktop, 'fixture-token', f.root);
        assert.equal((await reopened.request('/v1/desktop/action', action) as {
            status: string;
        }).status, 'posted');
        assert.equal(f.desktop.calls, 1);
        await assert.rejects(reopened.request('/v1/desktop/action', { ...action, key: 'tab' }), /different arguments/);
    }
    finally {
        f.close();
    }
});
test('uncertain input survives restart and never replays or retains frames', async () => {
    const f = fixture();
    try {
        f.desktop.fail = true;
        const action = input(await f.bridge.request('/v1/desktop') as Frame);
        await assert.rejects(f.bridge.request('/v1/desktop/action', action), /Interrupted/);
        const reopened = new Bridge(f.desktop, 'fixture-token', f.root);
        await assert.rejects(reopened.request('/v1/desktop/action', action), /Uncertain/);
        assert.equal(f.desktop.calls, 1);
        assert.equal(f.bridge.frames.size, 0);
        assert.match(readFileSync(join(f.root, 'inputs.json'), 'utf8'), /uncertain/);
    }
    finally {
        f.close();
    }
});
test('stale, unknown, future and takeover-invalidated frames never invoke input', async () => {
    const f = fixture();
    try {
        const frame = await f.bridge.request('/v1/desktop') as Frame;
        f.bridge.frames.set(frame.id, frame.capturedAt - 181);
        await assert.rejects(f.bridge.request('/v1/desktop/action', input(frame)), /fresh/);
        f.bridge.frames.set(frame.id, frame.capturedAt + 100);
        await assert.rejects(f.bridge.request('/v1/desktop/action', input(frame)), /fresh/);
        await assert.rejects(f.bridge.request('/host/shell', input(frame)), /endpoint/);
        assert.equal(f.desktop.calls, 0);
    }
    finally {
        f.close();
    }
});
test('human takeover persists, blocks automation, explicit return clears frames', async () => {
    const f = fixture();
    try {
        await f.bridge.request('/v1/desktop/control', { userControl: true });
        const reopened = new Bridge(f.desktop, 'fixture-token', f.root);
        const session = await reopened.request('/v1/desktop/session') as {
            frame: Frame;
            userControl: boolean;
        };
        assert.equal(session.userControl, true);
        const action = input(session.frame);
        await assert.rejects(reopened.request('/v1/desktop/action', action), /someone else/);
        assert.equal((await reopened.request('/v1/desktop/action', { ...action, human: true }) as {
            status: string;
        }).status, 'posted');
        const frame = await reopened.request('/v1/desktop') as Frame;
        await reopened.request('/v1/desktop/control', { userControl: false });
        await assert.rejects(reopened.request('/v1/desktop/action', input(frame)), /fresh/);
        assert.equal(new Bridge(f.desktop, 'fixture-token', f.root).userControl, false);
        assert.equal(f.desktop.calls, 1);
    }
    finally {
        f.close();
    }
});
test('viewing preserves recent frames, successful input consumes them', async () => {
    const f = fixture();
    try {
        const frame = await f.bridge.request('/v1/desktop') as Frame;
        await f.bridge.request('/v1/desktop/session');
        await f.bridge.request('/v1/desktop/action', input(frame));
        assert.equal(f.desktop.calls, 1);
        await assert.rejects(f.bridge.request('/v1/desktop/action', input(frame)), /fresh/);
    }
    finally {
        f.close();
    }
});
test('async input and concurrent retry serialize to one effect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'desktop-async-'));
    let calls = 0;
    const desktop = { capture: (): Frame => ({ id: randomUUID(), capturedAt: Date.now() / 1000 - REFERENCE_EPOCH }), perform: async () => {
            calls++;
            await new Promise(r => setTimeout(r, 20));
        } };
    const bridge = new Bridge(desktop, 'fixture', root);
    try {
        const action = input(await bridge.request('/v1/desktop') as Frame);
        const results = await Promise.all([bridge.request('/v1/desktop/action', action), bridge.request('/v1/desktop/action', action)]);
        assert.deepEqual(results[0], results[1]);
        assert.equal(calls, 1);
    }
    finally {
        rmSync(root, { recursive: true, force: true });
    }
});
test('input validation rejects nonfinite coordinates, bad shortcuts and excessive text before journal', async () => {
    const f = fixture();
    try {
        const frame = await f.bridge.request('/v1/desktop') as Frame;
        for (const fields of [{ kind: 'click', x: NaN, y: 0 }, { kind: 'click', x: Infinity, y: 0 }, { kind: 'scroll', delta: 0 }, { kind: 'scroll', delta: 1.5 }, { kind: 'scroll', delta: 21 }, { kind: 'typeText', text: 'x'.repeat(2001) }, { kind: 'key', key: 'bad+return' }, { kind: 'unknown' }])
            await assert.rejects(f.bridge.request('/v1/desktop/action', { ...input(frame), ...fields }));
        assert.equal(f.desktop.calls, 0);
        assert.equal(Object.keys(f.bridge.receipts).length, 0);
        assert.doesNotThrow(() => validateAction({ kind: 'click', x: 0, y: 1 }));
    }
    finally {
        f.close();
    }
});
test('HTTP rejects missing credential and browser Origin, authenticated capture succeeds', async () => {
    const f = fixture();
    const server = serve(f.bridge);
    server.listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
        const address = server.address();
        if (!address || typeof address === 'string')
            throw new Error('No listener');
        const exchange = (headers: Record<string, string>): Promise<{
            status: number;
            body: string;
        }> => new Promise((resolve, reject) => {
            const req = httpRequest({ host: '127.0.0.1', port: address.port, path: '/v1/desktop', headers }, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => resolve({ status: res.statusCode!, body }));
            });
            req.on('error', reject);
            req.end();
        });
        assert.equal((await exchange({})).status, 401);
        assert.equal((await exchange({ Authorization: 'Bearer fixture-token', Origin: 'https://example.test' })).status, 403);
        const valid = await exchange({ Authorization: 'Bearer fixture-token' });
        assert.equal(valid.status, 200);
        assert.ok((JSON.parse(valid.body) as Frame).id);
    }
    finally {
        await new Promise<void>(r => server.close(() => r()));
        f.close();
    }
});
class Ax implements Accessible {
    label: string;
    roleName = 'button';
    children: Ax[];
    attributeList: string[];
    stateList = ['STATE_ENABLED'];
    rect: Bounds = { x: 0, y: 0, width: 10, height: 10 };
    actions = ['click'];
    calls: number[] = [];
    fail = false;
    posted = true;
    lookup: (() => void) | undefined;
    descriptionText = 'Description';
    secretReads = 0;
    constructor(name: string, children: Ax[] = []) {
        this.label = name;
        this.children = children;
        this.attributeList = ['id:' + name];
    }
    role(): string {
        return this.roleName;
    }
    name(): string {
        return this.label;
    }
    states(): string[] {
        return this.stateList;
    }
    attributes(): string[] {
        return this.attributeList;
    }
    description(): string {
        return this.descriptionText;
    }
    bounds(): Bounds {
        return this.rect;
    }
    childCount(): number {
        return this.children.length;
    }
    child(i: number): Ax | null {
        return this.children[i] ?? null;
    }
    text(): {
        characterCount: number;
        getText: () => string;
    } {
        this.secretReads++;
        return { characterCount: 6, getText: () => 'secret' };
    }
    action(): {
        names: () => string[];
        invoke: (index: number) => boolean;
    } {
        this.lookup?.();
        return { names: () => this.actions, invoke: index => {
                this.calls.push(index);
                if (this.fail)
                    throw new Error('Native failure');
                return this.posted;
            } };
    }
}
function axFixture() {
    const button = new Ax('Delete'), other = new Ax('Status');
    const window = new Ax('Documents', [button, other]);
    window.roleName = 'window';
    const root = new Ax('Desktop', [window]);
    root.roleName = 'desktop';
    const api = { desktop: () => root };
    let elapsed = 100;
    const tree = captureAccessibility(api);
    const chain = tree.nodes.filter(n => n.name !== 'Status');
    const request = { chain: structuredClone(chain), action: 'click', startedAt: 100, expiresAt: 115 };
    return { button, other, window, root, api, tree, request, setTime: (n: number) => {
            elapsed = n;
        }, perform: (r: unknown = request) => performAccessibility(r, api, () => elapsed) };
}
test('AT-SPI normalization keeps bounds/path/actions and redacts protected text', () => {
    const f = axFixture();
    assert.equal(f.tree.nodes.length, 4);
    assert.deepEqual(f.tree.nodes[2]!.path, [0, 0]);
    assert.equal(f.tree.nodes[2]!.parentId, f.tree.nodes[1]!.id);
    assert.equal(f.tree.nodes[2]!.properties.text, 'secret');
    f.button.roleName = 'password text';
    f.button.secretReads = 0;
    assert.equal(describe(f.button).properties.text, undefined);
    assert.equal(f.button.secretReads, 0);
    f.button.roleName = 'text';
    f.button.stateList = ['STATE_PROTECTED'];
    assert.equal(describe(f.button).properties.text, undefined);
});
test('unchanged inspected chain invokes once despite sibling change', () => {
    const f = axFixture();
    f.other.label = 'New status';
    assert.equal(f.perform(), 0);
    assert.deepEqual(f.button.calls, [0]);
});
test('parent context changes all refuse identical target', () => {
    for (const mutate of [(n: Ax) => {
            n.label = 'Other';
        }, (n: Ax) => {
            n.roleName = 'dialog';
        }, (n: Ax) => {
            n.attributeList = ['id:replacement'];
        }, (n: Ax) => {
            n.descriptionText = 'Other document';
        }, (n: Ax) => {
            n.stateList = [];
        }, (n: Ax) => {
            n.rect = { x: 1, y: 0, width: 10, height: 10 };
        }]) {
        const f = axFixture();
        mutate(f.window);
        assert.equal(f.perform(), 42);
        assert.deepEqual(f.button.calls, []);
    }
});
test('changed target or ambiguous action refuses before invocation', () => {
    const f = axFixture();
    f.button.label = 'Changed';
    assert.equal(f.perform(), 42);
    f.button.label = 'Delete';
    f.button.actions = ['click', 'click'];
    assert.equal(f.perform(), 42);
    assert.deepEqual(f.button.calls, []);
});
test('expiry during native resolution is rechecked before doAction', () => {
    const f = axFixture();
    let calls = 0;
    f.button.lookup = () => {
        if (++calls === 2)
            f.setTime(115);
    };
    assert.equal(f.perform(), 42);
    assert.equal(calls, 2);
    assert.deepEqual(f.button.calls, []);
});
test('expiry and rollback before resolution never invoke', () => {
    for (const n of [99, 115, 116]) {
        const f = axFixture();
        f.setTime(n);
        assert.equal(f.perform(), 42);
        assert.deepEqual(f.button.calls, []);
    }
});
test('malformed parent paths, cycles and invalid lifetimes are refused', () => {
    for (const kind of ['missing-root', 'negative', 'bool', 'parent', 'cycle', 'nan', 'long', 'extra']) {
        const f = axFixture();
        const r = structuredClone(f.request);
        if (kind === 'missing-root')
            r.chain.shift();
        else if (kind === 'negative')
            r.chain[1]!.path = [-1];
        else if (kind === 'bool')
            (r.chain[1]!.path as unknown[]) = [false];
        else if (kind === 'parent')
            r.chain[2]!.parentId = 'other';
        else if (kind === 'cycle')
            r.chain[2]!.id = r.chain[0]!.id;
        else if (kind === 'nan')
            r.expiresAt = NaN;
        else if (kind === 'long')
            r.expiresAt = 116;
        else
            Object.assign(r, { extra: true });
        assert.equal(f.perform(r), 42, kind);
        assert.deepEqual(f.button.calls, []);
    }
});
test('false or exception after native invocation returns unknown, never confirmed refusal', () => {
    const f = axFixture();
    f.button.posted = false;
    assert.equal(f.perform(), 43);
    f.button.fail = true;
    assert.equal(f.perform(), 43);
    assert.deepEqual(f.button.calls, [0, 0]);
});
test('tree traversal bounds depth/node/time and reports unavailable objects', () => {
    const root = new Ax('root');
    let leaf = root;
    for (let i = 0; i < 40; i++) {
        const next = new Ax(String(i));
        leaf.children = [next];
        leaf = next;
    }
    const deep = captureAccessibility({ desktop: () => root });
    assert.equal(deep.truncated, true);
    assert.equal(deep.nodes.length, 26);
    const broken = new Ax('Broken');
    broken.role = () => {
        throw new Error('Gone');
    };
    const tree = captureAccessibility({ desktop: () => new Ax('root', [broken]) });
    assert.equal(tree.unavailableNodes, 1);
    let clock = 0;
    assert.equal(captureAccessibility({ desktop: () => root }, () => clock++).truncated, true);
});
test('captured accessibility details do not retain mutable native arrays or geometry', () => {
    const f = axFixture();
    const captured = f.tree.nodes.find(n => n.name === 'Delete')!;
    f.button.actions.push('delete');
    f.button.rect.x = 999;
    assert.deepEqual(captured.actions, ['click']);
    assert.equal(captured.bounds!.x, 0);
});
test('default bridge uses production Rust/libatspi worker rather than requiring adapter injection', () => {
    const f = fixture();
    try {
        assert.ok(f.bridge.accessibility instanceof NativeAccessibility);
    }
    finally {
        f.close();
    }
});
function nativeFixture() {
    const f = fixture(), tree = axFixture().tree;
    const snapshot: NativeSnapshot = { ...tree, startedAt: 100, expiresAt: 115 };
    let calls = 0, code: 0 | 42 | 43 = 0, fail = false;
    const contexts: NativeActionContext[] = [];
    const worker: AccessibilityWorker = { capture: async () => structuredClone(snapshot), perform: async (context) => {
            calls++;
            contexts.push(structuredClone(context));
            if (fail)
                throw new Error('Native worker disconnected');
            return code;
        } };
    const bridge = new Bridge(f.desktop, 'fixture-token', f.root, undefined, worker);
    const input = async (): Promise<Action> => {
        const value = await bridge.request('/v1/accessibility/inspect') as {
            snapshotId: string;
        };
        return { id: randomUUID(), snapshotId: value.snapshotId, nodeId: 'ax-3', nativeAction: 'click' };
    };
    return { ...f, bridge, worker, contexts, input, calls: () => calls, setCode: (value: 0 | 42 | 43) => {
            code = value;
        }, setFail: () => {
            fail = true;
        } };
}
test('native endpoint passes original ancestor chain/lifetime and deduplicates confirmed input across restart', async () => {
    const f = nativeFixture();
    try {
        const action = await f.input();
        const posted = await f.bridge.request('/v1/accessibility/invoke', action);
        assert.equal((posted as {
            status: string;
        }).status, 'posted');
        assert.equal(f.calls(), 1);
        assert.deepEqual(f.contexts[0]!.chain.map(n => n.path), [[], [0], [0, 0]]);
        assert.equal(f.contexts[0]!.startedAt, 100);
        assert.equal(f.contexts[0]!.expiresAt, 115);
        const reopened = new Bridge(f.desktop, 'fixture-token', f.root, undefined, f.worker);
        assert.deepEqual(await reopened.request('/v1/accessibility/invoke', action), posted);
        assert.equal(f.calls(), 1);
        await assert.rejects(reopened.request('/v1/accessibility/invoke', { ...action, nativeAction: 'other' }), /different arguments/);
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', { ...action, id: randomUUID() }), /fresh/);
    }
    finally {
        f.close();
    }
});
test('uncertain native invocation is durably refused on replay, including after worker timeout/exception', async () => {
    for (const throwing of [false, true]) {
        const f = nativeFixture();
        try {
            const action = await f.input();
            if (throwing)
                f.setFail();
            else
                f.setCode(43);
            await assert.rejects(f.bridge.request('/v1/accessibility/invoke', action), /uncertain|disconnected/);
            const reopened = new Bridge(f.desktop, 'fixture-token', f.root, undefined, f.worker);
            await assert.rejects(reopened.request('/v1/accessibility/invoke', action), /Uncertain/);
            assert.equal(f.calls(), 1);
        }
        finally {
            f.close();
        }
    }
});
test('native confirmed refusal remains distinct and never reexecutes that input ID', async () => {
    const f = nativeFixture();
    try {
        const action = await f.input();
        f.setCode(42);
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', action), /refused/);
        const reopened = new Bridge(f.desktop, 'fixture-token', f.root, undefined, f.worker);
        await assert.rejects(reopened.request('/v1/accessibility/invoke', action), /refused/);
        assert.equal(f.calls(), 1);
        assert.match(readFileSync(join(f.root, 'inputs.json'), 'utf8'), /rejected/);
    }
    finally {
        f.close();
    }
});
test('native takeover blocks automation and invalidates earlier snapshots', async () => {
    const f = nativeFixture();
    try {
        const stale = await f.input();
        await f.bridge.request('/v1/desktop/control', { userControl: true });
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', stale), /someone else/);
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', { ...stale, human: true }), /fresh/);
        const action = await f.input();
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', action), /someone else/);
        await f.bridge.request('/v1/accessibility/invoke', { ...action, human: true });
        assert.equal(f.calls(), 1);
    }
    finally {
        f.close();
    }
});
test('native uninspected target/action and forged context are refused before dispatch', async () => {
    const f = nativeFixture();
    try {
        const action = await f.input();
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', { ...action, nodeId: 'unknown' }), /not inspected/);
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', { ...action, nativeAction: 'delete' }), /not inspected/);
        await assert.rejects(f.bridge.request('/v1/accessibility/invoke', { ...action, startedAt: 0 } as Action), /Invalid native/);
        assert.equal(f.calls(), 0);
        assert.equal(Object.keys(f.bridge.receipts).length, 0);
    }
    finally {
        f.close();
    }
});
test('native subprocess adapter validates snapshots and preserves definite versus uncertain exit codes', async () => {
    const snapshot: NativeSnapshot = { ...axFixture().tree, startedAt: 100, expiresAt: 115 };
    const requests: {
        mode: string;
        input: Buffer | undefined;
    }[] = [];
    let code: number | null = 0;
    const adapter = new NativeAccessibility(async (mode, input) => {
        requests.push({ mode, input });
        return { code, stdout: Buffer.from(JSON.stringify(snapshot)) };
    });
    assert.deepEqual(await adapter.capture(), snapshot);
    const context: NativeActionContext = { chain: snapshot.nodes.slice(0, 3), action: 'click', startedAt: 100, expiresAt: 115 };
    assert.equal(await adapter.perform(context), 0);
    assert.deepEqual(JSON.parse(requests[1]!.input!.toString()), context);
    code = 42;
    assert.equal(await adapter.perform(context), 42);
    code = 43;
    assert.equal(await adapter.perform(context), 43);
    code = null;
    assert.equal(await adapter.perform(context), 43);
    await assert.rejects(adapter.capture(), /unavailable/);
    const throwing = new NativeAccessibility(async () => {
        throw new Error('Disconnected');
    });
    assert.equal(await throwing.perform(context), 43);
    const before = requests.length;
    assert.equal(await adapter.perform({ ...context, action: 'x'.repeat(6 * 1048576) }), 42);
    assert.equal(requests.length, before);
});
test('malformed native snapshots never become target authority', () => {
    const snapshot: NativeSnapshot = { ...axFixture().tree, startedAt: 100, expiresAt: 115 };
    for (const kind of ['empty', 'duplicate', 'missing-parent', 'bool-path', 'nonfinite', 'long-lifetime']) {
        const bad = structuredClone(snapshot);
        if (kind === 'empty')
            bad.nodes = [];
        else if (kind === 'duplicate')
            bad.nodes[2]!.id = bad.nodes[0]!.id;
        else if (kind === 'missing-parent')
            bad.nodes[2]!.parentId = 'other';
        else if (kind === 'bool-path')
            (bad.nodes[2]!.path as unknown[]) = [false];
        else if (kind === 'nonfinite')
            bad.startedAt = NaN;
        else
            bad.expiresAt = 116;
        assert.throws(() => validateNativeSnapshot(bad), /Invalid native/, kind);
    }
});
