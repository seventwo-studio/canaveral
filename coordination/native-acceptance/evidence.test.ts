import {test} from 'node:test';
import assert from 'node:assert/strict';
import {signatureEvidence, processEvidence, journalEvidence} from './evidence.ts';
test('native evidence excludes unrelated argv, signing identity and journal paths', () => {
  const processes = processEvidence('10 1 S 00:03 /Users/private/helper\n11 10 S 00:02 helper\n90 1 S 00:01 --token=FAKE_SECRET', [10]);
  assert.deepEqual(processes.map(p=>p.pid), [10,11]);
  const signature = signatureEvidence('Executable=/Users/private/helper\nIdentifier=dev.canaveral.runner\nAuthority=Private Operator\nTeamIdentifier=PRIVATE_TEAM\nCDHash='+'a'.repeat(40), true);
  assert.equal(signature.identifier, 'dev.canaveral.runner');
  const journal = journalEvidence({config:{path:'/Users/private/config', token:'FAKE_SECRET'}, stopped:true, deadline:123, stopCause:'deadline', direct:{agentSocket:'/Users/private/relay'}});
  assert.equal(journal.stopped,true); assert.equal(journal.deadline,123);
  const all = JSON.stringify({processes, signature, journal});
  for (const privateValue of ['FAKE_SECRET','/Users/','Private Operator','PRIVATE_TEAM','--token']) assert(!all.includes(privateValue));
});

test('console evidence allowlists milestones and discards adversarial payloads', async () => {
  const {consoleEvidence} = await import('./evidence.ts');
  const secrets = ['token=FAKE_SECRET password=supersecret', '/Users/Alice Smith/private/file',
    'DHCP hostname secret-host', 'username alice', '192.168.1.3', '2001:db8::1',
    '::1', '::', 'fe80::abcd%en0', 'alice@secret-host.example'];
  const milestones = ['Linux version 6.12.1 (alice@secret-host) token=FAKE_SECRET',
    '[    0.000000] Linux version 6.12.1-private /Users/Alice Smith',
    'bootstrap refused: password=supersecret', 'guest agent fenced: token=FAKE_SECRET',
    'guest session closed: Err("alice@secret-host"); native fence required'];
  const clean = consoleEvidence([...secrets, ...milestones].join('\n'));
  assert.equal(clean, 'Linux version 6.12.1\nLinux version 6.12.1\nbootstrap refused\nguest agent fenced\nguest session closed; native fence required\n10 lines omitted\n');
  for (const secret of secrets) assert(!clean.includes(secret));
  for (const secret of ['FAKE_SECRET', 'supersecret', 'Alice', 'alice', 'secret-host', '/Users']) assert(!clean.includes(secret));
  assert.equal(consoleEvidence('Boot ready\nLinux version secret-host\n'), '2 lines omitted\n');
});

test('workspace receipts retain outcomes while refusing raw logs, paths and probe targets', async () => {
  const {receiptEvidence}=await import('./evidence.ts');
  const privateValues=['192.168.1.4','2001:db8::1','/Users/private','secret identity'];
  const raw={state:'succeeded',durationMs:12,sha256:'a'.repeat(64),arguments:{argv:privateValues},result:{stdoutBase64:Buffer.from(privateValues.join(' ')).toString('base64')},path:privateValues[2],target:privateValues[0],caught:privateValues[3]};
  const clean=JSON.stringify(receiptEvidence(raw));
  assert(clean.includes('succeeded'));assert(clean.includes('a'.repeat(64)));
  for(const value of [...privateValues,raw.result.stdoutBase64]) assert(!clean.includes(value));
});
