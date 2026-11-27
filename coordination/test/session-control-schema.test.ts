import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { sessionProtocolSchema } from '../src/contracts.ts';

const schema = sessionProtocolSchema();
// This contract carries its own x-canaveral annotations. UUID is optional JSON Schema
// metadata here; the protocol's parser checks the actual identities.
const validator = new Ajv2020({ strict: false, validateFormats: false });
const root = validator.compile(schema);
const session = String(schema.$id);

const liveStop = { id: 'b268979d-70be-448a-a4f0-24eae2ec736b', generation: '3a526b7d-fce2-424b-b908-e7115ff03915' };
for (const [direction, controls, malformed] of [
  ['videoHost', [{ type: 'start' }, { type: 'start', liveStop }], { type: 'start', liveStop: { id: liveStop.id } }],
  ['videoBroker', [{ type: 'start-committed' }], { type: 'start-committed', liveStop }],
] as const) {
  test(`${direction} handover controls validate at the root and directional entry points`, () => {
    const directional = validator.compile({ $ref: `${session}#/$defs/${direction}` });
    for (const control of controls) {
      assert.equal(directional(control), true, JSON.stringify(directional.errors));
      assert.equal(root(control), true, JSON.stringify(root.errors));
    }
    assert.equal(directional(malformed), false);
    assert.equal(root(malformed), false);
  });
}
