function packet(type, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([header, payload]));
}

packet(1, { type: 'stream', codec: process.argv[2], codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720, fps: 24 });
packet(2, Buffer.from([1, 0, 0, 0, 1, 0x26]));
let pending = '';
process.stdin.on('data', (chunk) => {
  pending += chunk.toString();
  while (pending.includes('\n')) {
    const index = pending.indexOf('\n');
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    packet(1, { type: 'input-ack', input: JSON.parse(line) });
  }
});
