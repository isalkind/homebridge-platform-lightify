'use strict';

/*
 * Find a Lightify gateway on the local network via mDNS (no dependencies).
 *
 * The gateway announces itself as a "_http._tcp" service whose instance name starts with
 * "Lightify-" (documented in noctarius/lightify-binary-protocol). We send a one-shot PTR query
 * from an ephemeral port (so responders answer by unicast, RFC 6762 6.7) and also listen on
 * 5353 for multicast answers when that port is available.
 */

const dgram = require('dgram');

const MDNS_ADDR = '224.0.0.251';
const MDNS_PORT = 5353;
const SERVICE = '_http._tcp.local';

const TYPE = { A: 1, PTR: 12, SRV: 33 };

function encodeName(name) {
  const parts = name.split('.').filter(Boolean);
  const bufs = parts.map((p) => Buffer.concat([Buffer.from([p.length]), Buffer.from(p, 'utf8')]));
  return Buffer.concat([...bufs, Buffer.from([0])]);
}

function buildQuery(name = SERVICE) {
  const header = Buffer.alloc(12); // id 0, flags 0, qdcount 1
  header.writeUInt16BE(1, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE.PTR, 0);
  tail.writeUInt16BE(1, 2); // class IN
  return Buffer.concat([header, encodeName(name), tail]);
}

// Reads a (possibly compressed) DNS name. Returns [name, offsetAfterName].
function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  let next = -1;
  let hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated name');
    const len = buf[pos];
    if (len === 0) { pos++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated pointer');
      if (next < 0) next = pos + 2;
      pos = ((len & 0x3f) << 8) | buf[pos + 1];
      if (++hops > 20) throw new Error('compression loop');
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated label');
    labels.push(buf.toString('utf8', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return [labels.join('.'), next >= 0 ? next : pos];
}

// Returns { ptr: [{name, target}], srv: [{name, port, target}], a: {hostname: ip} }
function parseResponse(buf) {
  const out = { ptr: [], srv: [], a: {} };
  if (buf.length < 12) return out;
  const flags = buf.readUInt16BE(2);
  if (!(flags & 0x8000)) return out; // a query, not a response
  const qd = buf.readUInt16BE(4);
  const total = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
  let pos = 12;
  try {
    for (let i = 0; i < qd; i++) pos = readName(buf, pos)[1] + 4;
    for (let i = 0; i < total; i++) {
      const [name, p] = readName(buf, pos);
      if (p + 10 > buf.length) break;
      const type = buf.readUInt16BE(p);
      const rdlen = buf.readUInt16BE(p + 8);
      const rd = p + 10;
      if (rd + rdlen > buf.length) break;
      if (type === TYPE.PTR) {
        out.ptr.push({ name, target: readName(buf, rd)[0] });
      } else if (type === TYPE.SRV && rdlen >= 6) {
        out.srv.push({ name, port: buf.readUInt16BE(rd + 4), target: readName(buf, rd + 6)[0] });
      } else if (type === TYPE.A && rdlen === 4) {
        out.a[name.toLowerCase()] = `${buf[rd]}.${buf[rd + 1]}.${buf[rd + 2]}.${buf[rd + 3]}`;
      }
      pos = rd + rdlen;
    }
  } catch (e) {
    // keep whatever parsed before the damage
  }
  return out;
}

const LIGHTIFY = /^lightify-/i;

// Pull a gateway out of one parsed packet, or null. `from` is the sender's address.
function findGateway(parsed, from) {
  const instances = new Set();
  for (const r of parsed.ptr) if (LIGHTIFY.test(r.target)) instances.add(r.target);
  for (const r of parsed.srv) if (LIGHTIFY.test(r.name)) instances.add(r.name);
  if (!instances.size) return null;

  const name = [...instances][0].split('.')[0];
  const srv = parsed.srv.find((s) => LIGHTIFY.test(s.name));
  const aIp = srv && parsed.a[srv.target.toLowerCase()];
  return { name, ip: aIp || from };
}

/**
 * Resolves { ip, name } for the first Lightify gateway that answers, or null on timeout.
 * opts: timeout (ms), address/port (override the multicast target; used by tests), listen (bool).
 */
function discoverGateway(opts = {}) {
  const timeout = opts.timeout || 4000;
  const address = opts.address || MDNS_ADDR;
  const port = opts.port || MDNS_PORT;
  const query = buildQuery();

  return new Promise((resolve) => {
    const sockets = [];
    const timers = [];
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      for (const s of sockets) { try { s.close(); } catch (e) { /* already closed */ } }
      resolve(result);
    };

    const onMessage = (msg, rinfo) => {
      const found = findGateway(parseResponse(msg), rinfo.address);
      if (found) finish(found);
    };

    // Sender socket: ephemeral port, so replies come back unicast.
    const sender = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sockets.push(sender);
    sender.on('message', onMessage);
    sender.on('error', () => finish(null));
    sender.bind(0, () => {
      try { sender.setMulticastTTL(255); } catch (e) { /* not fatal */ }
      const send = () => { if (!done) sender.send(query, port, address, () => {}); };
      send();
      timers.push(setTimeout(send, 800), setTimeout(send, 2000));
    });

    // Optional listener for multicast answers (gateway may reply to the group instead).
    if (opts.listen !== false) {
      const listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(listener);
      listener.on('message', onMessage);
      listener.on('error', () => { try { listener.close(); } catch (e) { /* ignore */ } });
      try {
        listener.bind(MDNS_PORT, () => {
          try { listener.addMembership(MDNS_ADDR); } catch (e) { /* no multicast route: fine */ }
        });
      } catch (e) { /* port unavailable: fine */ }
    }

    timers.push(setTimeout(() => finish(null), timeout));
  });
}

module.exports = { discoverGateway, buildQuery, parseResponse, findGateway, encodeName };
