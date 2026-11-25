# homebridge-platform-lightify (0.5.0, modernized fork)

Homebridge plugin for OSRAM Lightify gateways, using the gateway's local protocol (TCP 4000).
The Lightify *cloud* was shut down in 2021; the local protocol does not need it.

Based on rainlake/homebridge-platform-lightify 0.3.7. Changes:

- **0.5.0:** automatic gateway discovery via mDNS; `bridge_ip` is now optional. The last IP found is remembered and
  the search repeats if the gateway moves (DHCP).

0.4.0:

- Fixes the startup hang on Homebridge >= 1.x/2.x (`Class constructor Service cannot be invoked without 'new'`).
- `accessories()` always returns promptly; if the gateway is unreachable it falls back to `lightify-cache.json`
  in the Homebridge storage folder, so HomeKit keeps your devices and they recover when the gateway returns.
- Zero dependencies; Node >= 18.
- Gateway traffic is serialized (one connection at a time) and polling no longer piles up connections.
- State changes made elsewhere are pushed to HomeKit; colour temperature and hue/saturation fixes.

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
