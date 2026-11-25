#!/usr/bin/env node
'use strict';

// Usage: node scripts/probe.js [gateway-ip] [port]   (no IP: search the LAN via mDNS)
// Connects to the Lightify gateway's local protocol and prints what it finds.

const lightify = require('../lib/lightify');

let ip = process.argv[2];
const port = Number(process.argv[3]) || 4000;

const logger = process.env.DEBUG ? { debug: (...a) => console.error('[debug]', ...a) } : undefined;

(async () => {
  if (!ip || ip === 'auto') {
    console.log('searching for a Lightify gateway via mDNS (up to 6 s)...');
    const found = await require('../lib/discover').discoverGateway({ timeout: 6000 });
    if (!found) {
      console.error('no gateway answered. Is it on the same subnet? Try passing its IP.');
      process.exit(1);
    }
    console.log(`found "${found.name}" at ${found.ip}`);
    ip = found.ip;
  }
  const conn = new lightify.Lightify(ip, logger, { port, connectTimeout: 5000, commandTimeout: 5000 });
  const t0 = Date.now();
  await conn.connect();
  console.log(`connected to ${ip}:${port} in ${Date.now() - t0} ms`);

  const nodes = (await conn.discover()).result;
  console.log(`\n${nodes.length} node(s):`);
  for (const n of nodes) {
    console.log(
      `  ${n.name.padEnd(24)} mac=${n.mac} type=0x${n.type.toString(16)} online=${n.online} ` +
      `on=${n.status} bri=${n.brightness} temp=${n.temperature}K rgb=${n.red},${n.green},${n.blue}`
    );
  }

  try {
    const zones = (await conn.discoverZone()).result;
    console.log(`\n${zones.length} zone(s):`);
    for (const z of zones) console.log(`  id=${z.id} ${z.name}`);
  } catch (e) {
    console.log(`\nzone listing failed: ${e.message}`);
  }
  conn.dispose();
})().catch((err) => {
  console.error(`FAILED: ${err.message}`);
  process.exit(1);
});
