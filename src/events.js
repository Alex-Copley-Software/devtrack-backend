const clients = new Set();

function send(res, event, payload) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('\n');

  const client = { res, userId: req.user?.id || null };
  clients.add(client);
  send(res, 'connected', { ok: true, timestamp: new Date().toISOString() });

  req.on('close', () => {
    clients.delete(client);
  });
}

function broadcast(event, payload) {
  const dead = [];
  for (const client of clients) {
    try {
      send(client.res, event, payload);
    } catch (err) {
      dead.push(client);
    }
  }
  dead.forEach(client => clients.delete(client));
}

setInterval(() => {
  broadcast('ping', { timestamp: new Date().toISOString() });
}, 25000).unref();

module.exports = { addClient, broadcast };
