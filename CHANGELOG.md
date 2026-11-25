# Change Log

All notable changes to this project will be documented in this file.

## 0.5.0 (2026-11-25)

### Notable Changes

- automatic gateway discovery via mDNS; `bridge_ip` is now optional. The last IP found is remembered and
  the search repeats if the gateway moves (DHCP).

## 0.4.0 (unreleased)

### Notable Changes

- Fixes the startup hang on Homebridge >= 1.x/2.x (`Class constructor Service cannot be invoked without 'new'`).
- `accessories()` always returns promptly; if the gateway is unreachable it falls back to `lightify-cache.json`
  in the Homebridge storage folder, so HomeKit keeps your devices and they recover when the gateway returns.
- Zero dependencies; Node >= 18.
- Gateway traffic is serialized (one connection at a time) and polling no longer piles up connections.
- State changes made elsewhere are pushed to HomeKit; colour temperature and hue/saturation fixes.
