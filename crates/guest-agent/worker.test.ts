import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { Agent, EPOCH, MAIN, Interrupted, identifier, now, serveWorker } from './worker.ts';
import type { Task, RecordValue, Relay, RelayEvent, State } from './worker.ts';
const wait = async (predicate: () => boolean): Promise<void> => {
    const deadline = Date.now() + 4000;
    while (!predicate()) {
        if (Date.now() > deadline)
            throw new Error('Timed out');
        await new Promise(r => setTimeout(r, 10));
    }
};
function fixture(workerOnly = false, autoSchedule = false, relay?: Relay): {
    root: string;
    agent: Agent;
    close: () => Promise<void>;
} {
    const root = mkdtempSync(join(tmpdir(), 'guest-worker-'));
    const agent = new Agent(root, { workerOnly, autoSchedule, ...(relay ? { relay } : {}) });
    agent.state.settings.model = 'fixture';
    return { root, agent, close: async () => {
            await agent.request({ method: 'shutdown' });
            agent.db.close();
            rmSync(root, { recursive: true, force: true });
        } };
}
const action = (agent: Agent, name: string, value: unknown, id = identifier(), extra: Record<string, unknown> = {}): Promise<unknown> => agent.request({ method: 'action', request: { id, action: { [name]: { _0: value, ...extra } } } });
const execute = (a: Agent, name: string, args: unknown, t: Task, invocation?: string, signal = new AbortController().signal): Promise<string> => a.execute(name, args, t, signal, performance.now() / 1000 + 3, invocation);
const call = (name: string, args: RecordValue): RecordValue => ({ type: 'function_call', name, arguments: JSON.stringify(args), call_id: identifier() });
function relay(turns: RelayEvent[][]): Relay {
    let i = 0;
    return { async *stream() {
            yield* turns[i++] ?? [];
        } };
}
function workerCall(a: Agent, name: string, args: unknown, taskID: string, project: string, invocationID = identifier()): Promise<unknown> {
    return a.request({ method: 'workerTool', name, arguments: args, taskID, invocationID, projects: [{ id: project, name: 'Fixture' }] });
}
test('worker-only refuses autonomy and forbidden tools', async () => {
    const f = fixture(true);
    try {
        f.agent.schedule();
        f.agent.proactive();
        assert.equal(f.agent.worker, undefined);
        await assert.rejects(action(f.agent, 'chat', 'Work'), /no autonomous/);
        for (const name of ['hostCommand', 'messaging_send', 'agents_delegate', 'memory_save', 'desktop_key'])
            await assert.rejects(workerCall(f.agent, name, {}, identifier(), identifier()), /Unknown worker/);
    }
    finally {
        await f.close();
    }
});
test('worker files stay in project and reject path/symlink/dangling escapes', async () => {
    const f = fixture(true);
    const p = identifier(), t = identifier();
    try {
        await workerCall(f.agent, 'files_write', { projectID: p, path: 'notes/check.txt', text: 'inside' }, t, p);
        const r = await workerCall(f.agent, 'files_read', { projectID: p, path: 'notes/check.txt' }, t, p) as {
            result: string;
            runtimeVersion: string;
        };
        assert.equal(r.result, 'inside');
        assert.match(r.runtimeVersion, /^[0-9a-f]{64}$/);
        for (const path of ['../../outside', '/tmp/outside'])
            await assert.rejects(workerCall(f.agent, 'files_read', { projectID: p, path }, t, p), /escapes|relative/);
        symlinkSync(f.root, join(f.root, 'Projects', p, 'escape'));
        await assert.rejects(workerCall(f.agent, 'files_write', { projectID: p, path: 'escape/outside', text: 'no' }, t, p), /escapes/);
        symlinkSync(join(f.root, 'nonexistent'), join(f.root, 'Projects', p, 'dangling'));
        await assert.rejects(workerCall(f.agent, 'files_write', { projectID: p, path: 'dangling', text: 'no' }, t, p), /escapes/);
    }
    finally {
        await f.close();
    }
});
test('worker duplicate command has one durable effect, argument mismatch refused', async () => {
    const f = fixture(true);
    const p = identifier(), t = identifier(), i = identifier(), args = { command: 'printf x >> counter.txt; cat counter.txt', projectID: p };
    try {
        const one = await workerCall(f.agent, 'commands_run', args, t, p, i);
        assert.deepEqual(await workerCall(f.agent, 'commands_run', args, t, p, i), one);
        assert.equal(readFileSync(join(f.root, 'Projects', p, 'counter.txt'), 'utf8'), 'x');
        await assert.rejects(workerCall(f.agent, 'commands_run', { command: 'true' }, t, p, i), /different arguments/);
    }
    finally {
        await f.close();
    }
});
test('in-flight duplicate refuses uncertain replay; cancellation stops group and later dispatch', async () => {
    const f = fixture(true);
    const p = identifier(), t = identifier(), i = identifier(), args = { command: 'sleep 30 & wait' };
    try {
        const run = workerCall(f.agent, 'commands_run', args, t, p, i);
        const outcome = assert.rejects(run, Interrupted);
        await wait(() => f.agent.workerCancels.size > 0);
        await assert.rejects(workerCall(f.agent, 'commands_run', args, t, p, i), /Uncertain/);
        await f.agent.request({ method: 'workerCancel', taskID: t });
        await outcome;
        await assert.rejects(workerCall(f.agent, 'commands_run', { command: 'true' }, t, p), Interrupted);
        assert.equal(f.agent.state.journal.at(-1)?.outcome, undefined);
    }
    finally {
        await f.close();
    }
});
test('network/schema failures do not dispatch and history preserves processed IDs', async () => {
    const f = fixture(true);
    try {
        await assert.rejects(workerCall(f.agent, 'commands_run', { command: 'true', network: true }, identifier(), identifier()), /networking/);
        await assert.rejects(workerCall(f.agent, 'commands_run', { command: 'true', extra: true }, identifier(), identifier()), /arguments/);
        f.agent.state.processedRequests = [identifier()];
        f.agent.save();
        assert.deepEqual((await f.agent.request({ method: 'snapshot' }) as State).processedRequests, []);
        assert.deepEqual((await f.agent.request({ method: 'guestHistory' }) as State).processedRequests, f.agent.state.processedRequests);
        assert.equal(f.agent.state.journal.length, 0);
    }
    finally {
        await f.close();
    }
});
test('interrupted receipt survives restart and completed worker files survive restart', async () => {
    const f = fixture(true);
    const p = identifier(), t = identifier(), i = identifier();
    try {
        f.agent.state.journal.push({ id: identifier(), taskID: t, invocationID: i, tool: 'commands_run', arguments: '{"command":"true"}' });
        f.agent.save();
        const second = new Agent(f.root, { workerOnly: true });
        try {
            await assert.rejects(workerCall(second, 'commands_run', { command: 'true' }, t, p, i), /Uncertain/);
        }
        finally {
            second.db.close();
        }
    }
    finally {
        await f.close();
    }
});
test('direct chat model text remains private, one repair, then failure', async () => {
    const f = fixture();
    try {
        const id = identifier();
        const s = await action(f.agent, 'chat', 'Hello', id) as State;
        assert.equal(s.messages[0]?.id, id);
        assert.equal(s.messages[0]?.readAt, undefined);
        const t = f.agent.state.tasks[0]!;
        f.agent.relay = relay([[{ type: 'text', delta: 'Private draft' }, { type: 'completed', output: [] }], [{ type: 'text', delta: 'Private draft' }, { type: 'completed', output: [] }]]);
        await f.agent.run(t);
        assert.equal(t.status, 'failed');
        assert.match(t.result, /without delivering a chat reply/);
        assert.ok(f.agent.state.messages[0]?.readAt);
        assert.equal(f.agent.state.messages.length, 1);
    }
    finally {
        await f.close();
    }
});
test('direct chat requires delivered reply, private text never becomes a message', async () => {
    const f = fixture();
    try {
        await action(f.agent, 'chat', 'Say ready');
        const t = f.agent.state.tasks.at(-1)!;
        f.agent.relay = relay([[{ type: 'text', delta: 'Private' }, { type: 'completed', output: [] }], [{ type: 'completed', output: [call('messaging_typing', { active: true }), call('messaging_send', { text: 'Ready' })] }], [{ type: 'completed', output: [] }]]);
        await f.agent.run(t);
        assert.equal(t.status, 'completed');
        assert.deepEqual(f.agent.state.messages.filter(m => m.role === 'assistant').map(m => m.text), ['Ready']);
        assert.deepEqual(f.agent.state.typing, []);
    }
    finally {
        await f.close();
    }
});
test('memory multi-step inference and incomplete-stream failure', async () => {
    const f = fixture();
    try {
        const t = f.agent.task('Save oat milk');
        f.agent.relay = relay([[{ type: 'completed', output: [call('memory_save', { title: 'Coffee', text: 'Prefer oat milk' })] }], [{ type: 'completed', output: [call('memory_search', { query: 'oat' })] }], [{ type: 'text', delta: 'Remembered' }, { type: 'completed', output: [] }]]);
        await f.agent.run(t);
        assert.equal(t.status, 'completed');
        assert.match(f.agent.state.journal[1]!.outcome!, /oat milk/);
        const other = f.agent.task('Try again');
        f.agent.relay = relay([[{ type: 'text', delta: 'Partial' }]]);
        await f.agent.run(other);
        assert.equal(other.status, 'failed');
        assert.match(other.result, /did not complete/);
    }
    finally {
        await f.close();
    }
});
test('reply/typing durability and recovery after delivery but before tool receipt', async () => {
    const f = fixture();
    try {
        await action(f.agent, 'chat', 'Hi');
        const t = f.agent.state.tasks[0]!;
        f.agent.state.messages[0]!.readAt = now();
        await execute(f.agent, 'messaging_typing', { active: true }, t);
        assert.ok(f.agent.snapshot().typing[0]!.expiresAt > now());
        const first = await execute(f.agent, 'messaging_send', { text: 'Hello' }, t, 'reply-1');
        assert.equal(await execute(f.agent, 'messaging_send', { text: 'Hello' }, t, 'reply-1'), first);
        assert.equal(f.agent.state.messages[1]!.replyToID, f.agent.state.messages[0]!.id);
        delete f.agent.state.journal.at(-1)!.outcome;
        f.agent.save();
        assert.equal(await execute(f.agent, 'messaging_send', { text: 'Hello' }, t, 'reply-1'), first);
        assert.equal(f.agent.state.messages.length, 2);
        await assert.rejects(execute(f.agent, 'messaging_send', { text: 'Different' }, t, 'reply-1'), /reused/);
        assert.deepEqual(f.agent.state.typing, []);
    }
    finally {
        await f.close();
    }
});
test('delegates inherit research limits and cannot send user messages or recursively delegate', async () => {
    const f = fixture();
    try {
        const owner = f.agent.task('Research', undefined, false, true);
        const args = { name: 'One', task: 'Read notes' };
        const id = await execute(f.agent, 'agents_delegate', args, owner, 'child-1');
        assert.equal(await execute(f.agent, 'agents_delegate', args, owner, 'child-1'), id);
        await execute(f.agent, 'agents_delegate', { name: 'Two', task: 'More' }, owner);
        await assert.rejects(execute(f.agent, 'agents_delegate', { name: 'Three', task: 'More' }, owner), /Two delegates/);
        const child = f.agent.findTask(id);
        assert.equal(child.researchOnly, true);
        for (const [name, args] of [['messaging_send', { text: 'Bypass' }], ['messaging_typing', { active: true }], ['agents_delegate', { name: 'Nested', task: 'Bypass' }]] as const)
            await assert.rejects(execute(f.agent, name, args, child), /Only the main/);
        await assert.rejects(execute(f.agent, 'commands_run', { command: 'true' }, child), /Proactive research/);
        assert.equal(f.agent.tools(['memory'], false, false).some(t => t.name === 'messaging_send'), false);
    }
    finally {
        await f.close();
    }
});
test('internal reports wake main once; family cancellation prevents late wake', async () => {
    const f = fixture();
    try {
        const owner = f.agent.task('Work');
        const child = f.agent.findTask(await execute(f.agent, 'agents_delegate', { name: 'Worker', task: 'Work' }, owner));
        const first = await execute(f.agent, 'agents_send', { agentID: MAIN, text: 'Progress' }, child, 'report-1');
        await execute(f.agent, 'agents_send', { agentID: MAIN, text: 'Progress' }, child, 'report-1');
        await execute(f.agent, 'agents_send', { agentID: MAIN, text: 'More' }, child, 'report-2');
        const wakes = f.agent.state.tasks.filter(t => t.mailboxWake);
        assert.equal(wakes.length, 1);
        const inbox = f.agent.readInbox(wakes[0]!);
        assert.equal(inbox.length, 2);
        assert.equal(inbox[0]!.id, first);
        assert.deepEqual(f.agent.readInbox(wakes[0]!), []);
        assert.equal(JSON.parse(await execute(f.agent, 'agents_inbox', { includeRead: true }, owner)).length, 2);
        f.agent.cancelTree(owner.id);
        f.agent.postAgent(child.agentID, MAIN, 'Late report', child, identifier(), 'completion');
        assert.equal(f.agent.state.tasks.filter(t => t.mailboxWake).length, 1);
        assert.ok(f.agent.state.tasks.every(t => t.status === 'canceled'));
    }
    finally {
        await f.close();
    }
});
test('delegate restart reports interruption once, composition leases and approvals expire', async () => {
    const f = fixture();
    try {
        const owner = f.agent.task('Coordinate');
        owner.status = 'waitingForDelegates';
        const child = f.agent.findTask(await execute(f.agent, 'agents_delegate', { name: 'Worker', task: 'Work' }, owner));
        child.status = 'running';
        f.agent.state.typing.push({ taskID: owner.id, agentID: MAIN, expiresAt: now() + 60 });
        f.agent.save();
        const two = new Agent(f.root, { autoSchedule: false });
        assert.equal(two.findTask(child.id).status, 'needsReview');
        assert.equal(two.state.agentMessages.length, 1);
        assert.deepEqual(two.state.typing, []);
        two.db.close();
        const three = new Agent(f.root, { autoSchedule: false });
        assert.equal(three.state.agentMessages.length, 1);
        assert.equal(three.state.tasks.filter(t => t.mailboxWake).length, 1);
        three.db.close();
    }
    finally {
        await f.close();
    }
});
test('plugin validation, research limits, exact preapproval and handoff', async () => {
    const f = fixture();
    try {
        const t = f.agent.task('Test');
        f.agent.state.settings.enabledPlugins = f.agent.state.settings.enabledPlugins.filter(p => p !== 'memory');
        await assert.rejects(execute(f.agent, 'memory_save', { title: 'A', text: 'B' }, t), /disabled/);
        await assert.rejects(execute(f.agent, 'commands_run', { command: 'true', extra: true }, t), /arguments/);
        assert.equal(f.agent.state.journal.length, 0);
        f.agent.state.settings.enabledPlugins.push('memory');
        t.researchOnly = true;
        for (const [name, args] of [['commands_run', { command: 'true' }], ['desktop_screenshot', { targetID: identifier() }], ['schedules_create', { title: 'Later', prompt: 'Do', kind: 'task', nextRunUnix: Date.now() / 1000 }]] as const)
            await assert.rejects(execute(f.agent, name, args, t), /Proactive research/);
        t.researchOnly = false;
        f.agent.state.profile.rules = [{ id: identifier(), tool: 'memory_save', behavior: 'preapproved', approvedArguments: '{"title":"Allowed","text":"Yes"}' }];
        await execute(f.agent, 'memory_save', { title: 'Allowed', text: 'Yes' }, t);
        assert.equal(f.agent.state.approvals.length, 0);
        f.agent.state.profile.rules[0]!.behavior = 'handoff';
        await assert.rejects(execute(f.agent, 'memory_save', { title: 'Other', text: 'No' }, t), /Handed off/);
    }
    finally {
        await f.close();
    }
});
test('changed preapproval needs approval; desktop allow still requires approval', async () => {
    const f = fixture();
    try {
        const t = f.agent.task('Test');
        f.agent.state.profile.rules = [{ id: identifier(), tool: 'memory_save', behavior: 'preapproved', approvedArguments: '{"title":"One","text":"Yes"}' }];
        const run = execute(f.agent, 'memory_save', { title: 'Two', text: 'Yes' }, t);
        await wait(() => f.agent.state.approvals.length > 0);
        assert.equal(f.agent.state.memory.length, 0);
        await action(f.agent, 'approve', f.agent.state.approvals[0]!.id, identifier(), { _1: true });
        await run;
        f.agent.state.profile.rules = [{ id: identifier(), tool: 'desktop_key', behavior: 'allow', approvedArguments: '' }];
        const native = execute(f.agent, 'desktop_key', { targetID: identifier(), frameID: identifier(), key: 'return' }, t);
        const rejection = assert.rejects(native, /Action declined/);
        await wait(() => f.agent.state.approvals.length === 2);
        await action(f.agent, 'approve', f.agent.state.approvals[1]!.id, identifier(), { _1: false });
        await rejection;
    }
    finally {
        await f.close();
    }
});
test('guidance dedup cancels original approval and enqueues one reconciliation', async () => {
    const f = fixture();
    try {
        const t = f.agent.task('Original');
        t.status = 'waitingForApproval';
        f.agent.state.approvals.push({ id: identifier(), taskID: t.id, tool: 'desktop_key', arguments: '{}', createdAt: now() });
        const id = identifier();
        await action(f.agent, 'steerTask', t.id, id, { _1: 'Use another project' });
        await action(f.agent, 'steerTask', t.id, id, { _1: 'Use another project' });
        assert.equal(t.status, 'canceled');
        assert.equal(f.agent.state.approvals[0]!.decision, false);
        assert.equal(f.agent.state.tasks.length, 2);
        assert.match(f.agent.state.tasks[1]!.title, /Reconcile/);
    }
    finally {
        await f.close();
    }
});
test('due reminders coalesce, one-time schedules disable, pause prevents review', async () => {
    const f = fixture();
    try {
        const id = identifier();
        f.agent.saveSchedule({ id, title: 'Check', prompt: 'Remember', kind: 'reminder', nextRunAt: now() - 10000, intervalSeconds: 1800, enabled: true });
        f.agent.proactive();
        f.agent.proactive();
        assert.equal(f.agent.state.messages.length, 1);
        assert.ok(f.agent.state.schedules[0]!.nextRunAt > now());
        f.agent.saveSchedule({ id: identifier(), title: 'One', prompt: 'Once', kind: 'reminder', nextRunAt: now() - 1, enabled: true });
        await action(f.agent, 'pause', true);
        f.agent.proactive();
        assert.equal(f.agent.state.messages.length, 1);
        await action(f.agent, 'pause', false);
        f.agent.proactive();
        assert.equal(f.agent.state.messages.length, 2);
        assert.equal(f.agent.state.schedules[1]!.enabled, false);
        await assert.rejects(action(f.agent, 'saveSchedule', { id: identifier(), title: 'Spam', prompt: 'Do', kind: 'task', nextRunAt: now(), intervalSeconds: 1, enabled: true }), /five minutes/);
    }
    finally {
        await f.close();
    }
});
test('scheduled tasks and responsibilities only enqueue once', async () => {
    const f = fixture();
    try {
        f.agent.saveSchedule({ id: identifier(), title: 'Work', prompt: 'Do work', kind: 'task', nextRunAt: now() - 1, enabled: true });
        f.agent.saveResponsibility({ id: identifier(), title: 'Watch', instructions: 'Review notes', enabled: true });
        f.agent.proactive();
        f.agent.proactive();
        assert.equal(f.agent.state.tasks.filter(t => t.scheduleID).length, 1);
        assert.equal(f.agent.state.tasks.filter(t => t.responsibilityID).length, 1);
        assert.equal(f.agent.state.tasks.find(t => t.responsibilityID)!.researchOnly, true);
    }
    finally {
        await f.close();
    }
});
test('private Unix transport wraps one exchange, rejects unknown methods', async () => {
    const f = fixture(true);
    const path = join(f.root, 'fixture.sock');
    const server = serveWorker(f.agent, path);
    try {
        await new Promise<void>(r => server.once('listening', r));
        const exchange = (request: unknown): Promise<unknown> => new Promise((resolve, reject) => {
            const socket = connect(path);
            let text = '';
            socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
            socket.on('error', reject);
            socket.on('data', chunk => text += chunk);
            socket.on('end', () => {
                resolve(JSON.parse(text));
            });
        });
        assert.ok((await exchange({ method: 'health' }) as {
            output: State;
        }).output.runtimeVersion);
        assert.match((await exchange({ method: 'hostShell' }) as {
            error: string;
        }).error, /no autonomous/);
    }
    finally {
        await new Promise<void>(r => server.close(() => r()));
        await f.close();
    }
});
test('command timeout/cancel is uncertain; bounded output does not deadlock', async () => {
    const f = fixture();
    try {
        const t = f.agent.task('Run');
        const c = new AbortController();
        const run = execute(f.agent, 'commands_run', { command: 'sleep 30 & wait' }, t, undefined, c.signal);
        const rejection = assert.rejects(run, Interrupted);
        setTimeout(() => c.abort(), 30);
        await rejection;
        assert.equal(f.agent.state.journal.at(-1)!.outcome, undefined);
        const result = await execute(f.agent, 'commands_run', { command: 'yes x | head -c 100000' }, t);
        assert.equal(Buffer.byteLength(result), 65536 + 7);
    }
    finally {
        await f.close();
    }
});
test('concurrent delegates do not block main replies and reports complete family', async () => {
    let release = false;
    const r: Relay = { async *stream(req, signal) {
            const history = req.input as RecordValue[];
            const completed = history.some(x => x.type === 'function_call_output');
            if (String(req.instructions).includes('You are delegate ')) {
                if (!completed) {
                    yield { type: 'completed', output: [call('commands_run', { command: 'printf delegate-ok' })] };
                    return;
                }
                while (!release) {
                    if (signal.aborted)
                        throw new Interrupted('Delegate canceled');
                    await new Promise(r => setTimeout(r, 10));
                }
                yield { type: 'text', delta: 'Private delegate result' };
                yield { type: 'completed', output: [] };
                return;
            }
            if (completed) {
                yield { type: 'completed', output: [] };
                return;
            }
            if (history.some(x => String(x.content ?? '').includes('Agent inbox (reported data)'))) {
                yield { type: 'completed', output: [call('messaging_send', { text: 'Results reviewed' })] };
                return;
            }
            if (history.at(-2)?.content === 'Coordinate') {
                yield { type: 'completed', output: [call('agents_delegate', { name: 'One', task: 'First' }), call('agents_delegate', { name: 'Two', task: 'Second' }), call('messaging_send', { text: 'Started two' })] };
                return;
            }
            yield { type: 'completed', output: [call('messaging_send', { text: 'Read new message' })] };
        } };
    const f = fixture(false, true, r);
    try {
        f.agent.state.settings.proactiveEnabled = false;
        await action(f.agent, 'chat', 'Coordinate');
        await wait(() => f.agent.delegates.size === 2 && !f.agent.worker);
        const owner = f.agent.state.tasks[0]!;
        assert.equal(owner.status, 'waitingForDelegates');
        await action(f.agent, 'chat', 'Another message');
        await wait(() => f.agent.state.messages.some(m => m.text === 'Read new message'));
        assert.equal(f.agent.delegates.size, 2);
        release = true;
        await wait(() => !f.agent.delegates.size && !f.agent.worker && owner.status === 'completed');
        assert.ok(f.agent.state.messages.some(m => m.text === 'Results reviewed'));
        assert.ok(!f.agent.state.messages.some(m => m.text === 'Private delegate result'));
        assert.equal(f.agent.state.agentMessages.filter(m => m.kind === 'completion').length, 2);
    }
    finally {
        release = true;
        await f.close();
    }
});
test('worker cancellation remains sticky after a service restart', async () => {
    const f = fixture(true);
    try {
        const taskID = identifier();
        await f.agent.request({ method: 'workerCancel', taskID });
        const reopened = new Agent(f.root, { workerOnly: true });
        try {
            await assert.rejects(workerCall(reopened, 'commands_run', { command: 'printf should-not-run' }, taskID, identifier()), /stopped/);
        }
        finally {
            reopened.db.close();
        }
    }
    finally {
        await f.close();
    }
});
test('canceling a parent stops both independent delegates without restarting the family', async () => {
    const r: Relay = { async *stream(req, signal) {
            const history = req.input as RecordValue[];
            if (String(req.instructions).includes('You are delegate ')) {
                while (!signal.aborted)
                    await new Promise(r => setTimeout(r, 10));
                throw new Interrupted('Delegate canceled');
            }
            if (history.some(x => x.type === 'function_call_output')) {
                yield { type: 'completed', output: [] };
                return;
            }
            yield { type: 'completed', output: [call('agents_delegate', { name: 'One', task: 'First' }), call('agents_delegate', { name: 'Two', task: 'Second' }), call('messaging_send', { text: 'Started' })] };
        } };
    const f = fixture(false, true, r);
    try {
        await action(f.agent, 'chat', 'Coordinate');
        await wait(() => f.agent.delegates.size === 2 && !f.agent.worker);
        const owner = f.agent.state.tasks[0]!;
        await action(f.agent, 'cancelTask', owner.id);
        await wait(() => !f.agent.delegates.size && !f.agent.worker);
        assert.equal(owner.status, 'canceled');
        assert.ok(f.agent.state.tasks.every(t => t.status === 'canceled'));
        assert.ok(f.agent.state.tasks.every(t => !t.mailboxWake));
        assert.deepEqual(f.agent.state.typing, []);
    }
    finally {
        await f.close();
    }
});
