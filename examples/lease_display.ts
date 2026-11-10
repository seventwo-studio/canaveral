import { options, failure, privateOutput, ensureNewOutput } from './sdk-options.ts';
try {
  const args = options('Capture Raw RFB pixels as a new private PNG; optional --text requires --action-id. --receipt-id recovers a prior action without taking ownership. No input replay.', ['lease', 'session-request-id', 'member', 'output', 'text', 'action-id', 'receipt-id']);
  if (args) {
    const hasText = typeof args.values.text === 'string', hasAction = typeof args.values['action-id'] === 'string';
    if (hasText !== hasAction || (hasText && args.values['receipt-id'])) throw new Error('Invalid action options');
    await ensureNewOutput(args.required('output'));
    const display = await args.lease().display(args.required('session-request-id'), String(args.values.member ?? 'primary'));
    try {
      let receipt;
      if (hasText) { if (await display.takeControl() !== 'owned') throw new Error('Input unavailable'); receipt = await display.action(args.required('action-id'), 'text', { text: args.values.text }); await display.releaseControl(); }
      else if (args.values['receipt-id']) receipt = await display.receipt(args.required('receipt-id'));
      await privateOutput(args.required('output'), await display.screenshot());
      console.log(JSON.stringify({ width: display.width, height: display.height, screenshot: args.required('output'), ...(receipt ? { action: { id: receipt.id, state: receipt.state } } : {}) }));
      if (receipt && receipt.state !== 'succeeded') process.exitCode = 1;
    } finally { display.close(); }
  }
} catch (error) { failure(error); }
