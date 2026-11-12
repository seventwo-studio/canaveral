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
