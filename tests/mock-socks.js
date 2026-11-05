// Minimal SOCKS5 server that logs every destination, like a local Tor would receive them.
const net = require('node:net');

function mockSocks(map = {}) {
  const log = [];
  const outboundPorts = new Set();
  const sockets = new Set();
  const server = net.createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => {});
    client.once('data', (hello) => {
      if (hello[0] !== 5) { client.destroy(); return; }
      client.write(Buffer.from([5, 0]));
      client.once('data', (req) => {
        let host, port;
        if (req[3] === 3) { const n = req[4]; host = req.subarray(5, 5 + n).toString(); port = req.readUInt16BE(5 + n); }
        else if (req[3] === 1) { host = [...req.subarray(4, 8)].join('.'); port = req.readUInt16BE(8); }
        else { client.destroy(); return; }
        log.push({ host, port, type: req[3] === 3 ? 'domain' : 'ip' });
        const target = map[host] ?? host;
        const out = net.connect(port, target, () => {
          outboundPorts.add(out.localPort);
          client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
          out.pipe(client); client.pipe(out);
        });
        sockets.add(out);
        out.on('close', () => { sockets.delete(out); client.destroy(); });
        out.on('error', () => { if (client.writable) client.end(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])); });
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    uri: `socks5h://127.0.0.1:${server.address().port}`, log, outboundPorts,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  })));
}
module.exports = { mockSocks };
