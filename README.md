# homebridge-platform-lightify

Homebridge plugin for OSRAM Lightify gateways, using the gateway's local protocol (TCP 4000).
The Lightify *cloud* was shut down in 2021; the local protocol does not need it.

Based on rainlake/homebridge-platform-lightify 0.3.7.

Original project appears abandoned. Resurrected for my own purposes with lots of help from AI. Use at your own risk.

See CHANGELOG for changes.

## Config

```json
{
  "platform": "Lightify",
  "name": "Lightify",
  "bridge_ip": "192.168.1.50",   // optional: omit or use "auto" to discover the gateway
  "showGroups": false,
  "hideNodes": false,
  "pollInterval": 5
}
```

## Check the gateway first

```
node scripts/probe.js                  # find the gateway via mDNS, then list devices
node scripts/probe.js 192.168.1.50     # or give the IP (DEBUG=1 for raw protocol)
```

Auto-discovery needs Homebridge and the gateway on the same subnet (mDNS does not cross routers/VLANs unless you run an mDNS
reflector). Otherwise set `bridge_ip`.
