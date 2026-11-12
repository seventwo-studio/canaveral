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

test('console evidence retains boot milestones and redacts network and host identity', async () => {
  const {consoleEvidence} = await import('./evidence.ts');
  const raw = 'Linux version 6.12\nBoot ready\n192.168.1.3 2001:db8::1 ::1 fe80::abcd%en0\n/Users/alice/vm/console /private/tmp/vm\nhostname=secret-mac username=alice\nalice@secret-mac.local\nSecretMac alice\n';
  const clean = consoleEvidence(raw, ['SecretMac', 'alice']);
  for (const value of ['192.168', '2001:db8', '::1', 'fe80', '/Users', '/private', 'alice', 'secret-mac', 'SecretMac']) assert(!clean.includes(value), clean);
  assert(clean.includes('Linux version 6.12\nBoot ready'));
});
