function packet(type, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(5);
  header[0] = type;
  header.writeUInt32BE(payload.length, 1);
  process.stdout.write(Buffer.concat([header, payload]));
}

if (process.env.REMOTECONTROL_FAKE_MSE === '1') {
  packet(1, { type: 'stream', codec: 'h264', codecString: 'avc1.42E032', width: 640, height: 480, fps: 24 });
  packet(2, Buffer.from([1, 0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x06, 0xe2, 0, 0, 0, 1, 0x65, 0x88, 0x84]));
  packet(2, Buffer.from([0, 0, 0, 0, 1, 0x41, 0x9a, 0x20]));
} else {
  packet(1, { type: 'stream', codec: process.argv[2], codecString: 'hvc1.1.6.L150.B0', width: 1280, height: 720, fps: 24 });
  packet(2, Buffer.from([process.env.REMOTECONTROL_FAKE_METADATA_ONLY === '1' ? 0 : 1, 0, 0, 0, 1, 0x26]));
}
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
