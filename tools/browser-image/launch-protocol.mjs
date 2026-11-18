// Each control message is a bounded ASCII line.
export async function* lines(socket) {
  let pending = '';
  for await (const chunk of socket) {
    pending += chunk.toString('ascii');
    let end;
    while ((end = pending.indexOf('\n')) >= 0) {
      if (end > 1024) throw new Error('Oversized launcher message');
      yield pending.slice(0, end);
      pending = pending.slice(end + 1);
    }
    if (pending.length > 1024) throw new Error('Oversized launcher message');
  }
}
