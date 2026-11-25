'use strict';

const fs = require('fs');
const path = require('path');
const lightify = require('./lib/lightify');

let Service, Characteristic, HapStatusError, HAPStatus;

const PLUGIN_NAME = 'homebridge-platform-lightify';
const PLATFORM_NAME = 'Lightify';

// If startup discovery takes longer than this we fall back to the cached device list, so
// Homebridge is never held up by an unreachable gateway.
const STARTUP_BUDGET_MS = 12000;
// Consecutive failed polls before HomeKit is told the devices are not responding.
const FAILURES_BEFORE_NO_RESPONSE = 3;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;
  HapStatusError = homebridge.hap.HapStatusError;
  HAPStatus = homebridge.hap.HAPStatus;
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, LightifyPlatform);
};

/* ---------- colour helpers ---------- */

function hsvToRgb(h, s, v) {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r, g, b;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    default: r = v; g = p; b = q; break;
  }
  return { r: Math.round(r * 255), g: Math.round(g * 255), b: Math.round(b * 255) };
}

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const s = max === 0 ? 0 : d / max;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h, s, v: max / 255 };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const kelvinToMired = (k) => (k > 0 ? clamp(Math.round(1000000 / k), 140, 500) : 370);
const miredToKelvin = (m) => Math.round(1000000 / clamp(m, 140, 500));

/* ---------- platform ---------- */

class LightifyPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.byMac = new Map();
    this.chain = Promise.resolve(); // all gateway traffic runs one connection at a time
    this.failures = 0;
    this.stopped = false;
    this.unknownLogged = new Set();

    const seconds = Number(this.config.pollInterval);
    this.pollMs = Math.max(1, Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;

    let storage = process.cwd();
    try { storage = api.user.storagePath(); } catch (e) { /* older/odd hosts */ }
    this.cacheFile = path.join(storage, 'lightify-cache.json');

    if (api && api.on) {
      api.on('shutdown', () => {
        this.stopped = true;
        clearTimeout(this.pollTimer);
      });
    }
  }

  newConnection() {
    return new lightify.Lightify(this.config.bridge_ip, this.log, {
      connectTimeout: 5000,
      commandTimeout: 5000,
    });
  }

  // Run fn(connection) on a fresh connection, strictly after any earlier gateway work finishes.
  run(fn) {
    const task = async () => {
      const connection = this.newConnection();
      try {
        await connection.connect();
        return await fn(connection);
      } finally {
        connection.dispose();
      }
    };
    const result = this.chain.then(task, task);
    this.chain = result.catch(() => {});
    return result;
  }

  async discover(connection) {
    const nodes = (await connection.discover()).result;
    if (!this.config.showGroups) return nodes;

    const zones = (await connection.discoverZone()).result;
    for (const zone of zones) {
      zone.isZone = true;
      zone.mac = `zone:${zone.id}`;
      zone.friendlyMac = `zone-${zone.id}`;
      zone.online = 2;
      zone.status = 0;
      zone.isBrightnessSupported = false;
      zone.isColorSupported = false;
      zone.isTemperatureSupported = false;
      try {
        const info = (await connection.getZoneInfo(zone.id)).result[0];
        for (const mac of (info && info.devices) || []) {
          const d = nodes.find((n) => n.mac === mac);
          if (!d) continue;
          if (d.online && d.status === 1) zone.status = 1;
          if (lightify.isBrightnessSupported(d.type)) {
            zone.isBrightnessSupported = true;
            zone.brightness = d.brightness;
          }
          if (lightify.isColorSupported(d.type)) {
            zone.isColorSupported = true;
            zone.red = d.red; zone.green = d.green; zone.blue = d.blue; zone.alpha = d.alpha;
          }
          if (lightify.isTemperatureSupported(d.type)) {
            zone.isTemperatureSupported = true;
            zone.temperature = d.temperature;
          }
        }
      } catch (err) {
        this.log.debug('Could not read zone %s: %s', zone.name, err.message);
      }
    }
    return nodes.concat(zones);
  }

  readCache() {
    try {
      const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      return Array.isArray(data.devices) ? data.devices : [];
    } catch (e) {
      return [];
    }
  }

  writeCache(devices) {
    try {
      const tmp = `${this.cacheFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ saved: new Date().toISOString(), devices }));
      fs.renameSync(tmp, this.cacheFile);
    } catch (e) {
      this.log.debug('Could not write device cache: %s', e.message);
    }
  }

  // Static platform entry point. Homebridge waits for this callback, so it must always fire.
  accessories(callback) {
    if (!this.config.bridge_ip) {
      this.log.error('"bridge_ip" is not set in the Lightify platform config.');
      return callback([]);
    }

    let finished = false;
    const finish = (devices, fromCache) => {
      if (finished) return;
      finished = true;
      clearTimeout(budget);
      const list = this.buildAccessories(devices, fromCache);
      callback(list);
      this.schedulePoll(this.pollMs);
    };

    const budget = setTimeout(() => {
      this.log.warn('Gateway did not answer within %ds; starting from the cached device list.', STARTUP_BUDGET_MS / 1000);
      finish(this.readCache(), true);
    }, STARTUP_BUDGET_MS);

    this.run((c) => this.discover(c))
      .then((devices) => {
        this.writeCache(devices);
        finish(devices, false);
      })
      .catch((err) => {
        this.log.error('Could not talk to the Lightify gateway at %s:4000 (%s).', this.config.bridge_ip, err.message);
        const cached = this.readCache();
        if (!cached.length) {
          this.log.error('No cached devices either, so no accessories will be created. Fix connectivity and restart Homebridge.');
        }
        finish(cached, true);
      });
  }

  buildAccessories(devices, fromCache) {
    const list = [];
    for (const dev of devices) {
      if (fromCache) dev.online = 0;
      let acc = null;
      if (dev.isZone) {
        if (this.config.showGroups) acc = new LightifyAccessory(this, dev);
      } else if (!this.config.hideNodes) {
        if (lightify.isPlug(dev.type)) acc = new LightifyOutlet(this, dev);
        else if (lightify.isSensor(dev.type)) acc = new LightifySensor(this, dev);
        else if (lightify.isLight(dev.type)) acc = new LightifyAccessory(this, dev);
      }
      if (acc) {
        this.log.info('Lightify %s [%s]', dev.isZone ? 'group' : acc.kind, dev.name);
        this.byMac.set(dev.mac, acc);
        list.push(acc);
      }
    }
    return list;
  }

  /* ----- polling ----- */

  schedulePoll(ms) {
    if (this.stopped) return;
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      this.schedulePoll(this.pollMs);
    }, ms);
  }

  async poll() {
    try {
      const devices = await this.run((c) => this.discover(c));
      if (this.failures >= FAILURES_BEFORE_NO_RESPONSE) this.log.info('Lightify gateway is reachable again.');
      this.failures = 0;
      for (const dev of devices) {
        const acc = this.byMac.get(dev.mac);
        if (acc) acc.updateDevice(dev);
        else if (!this.unknownLogged.has(dev.mac)) {
          this.unknownLogged.add(dev.mac);
          this.log.info('Device "%s" is on the gateway but not exposed; restart Homebridge to pick it up.', dev.name);
        }
      }
    } catch (err) {
      this.failures++;
      if (this.failures === 1 || this.failures === FAILURES_BEFORE_NO_RESPONSE) {
        this.log.warn('Lightify poll failed (%d): %s', this.failures, err.message);
      } else {
        this.log.debug('Lightify poll failed (%d): %s', this.failures, err.message);
      }
    }
  }

  gatewayDown() {
    return this.failures >= FAILURES_BEFORE_NO_RESPONSE;
  }

  // Wrapper for characteristic getters: report "No Response" when the gateway has been unreachable.
  guard(fn) {
    return () => {
      if (this.gatewayDown()) throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
      return fn();
    };
  }
}

/* ---------- accessories ---------- */

function firmwareString(v) {
  v = v >>> 0;
  return `${(v >>> 24) & 0xff}.${(v >>> 16) & 0xff}.${(v >>> 8) & 0xff}.${v & 0xff}`;
}

class BaseAccessory {
  constructor(platform, device, model) {
    this.platform = platform;
    this.log = platform.log;
    this.device = device;
    this.name = device.name || 'Unknown';
    this.model = model;
    this.timers = {};
  }

  get target() { return this.device.isZone ? this.device.id : this.device.mac; }
  get isZone() { return !!this.device.isZone; }

  isOnline() { return this.device.online === 2; }

  informationService() {
    return new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Name, this.name)
      .setCharacteristic(Characteristic.Manufacturer, 'Lightify')
      .setCharacteristic(Characteristic.Model, this.model)
      .setCharacteristic(Characteristic.SerialNumber, String(this.device.friendlyMac || this.device.mac || 'unknown'))
      .setCharacteristic(Characteristic.FirmwareRevision, firmwareString(this.device.firmware_version || 0))
      .setCharacteristic(Characteristic.HardwareRevision, '1.0.0');
  }

  // Coalesce rapid slider updates into one gateway command.
  debounce(key, ms, fn) {
    clearTimeout(this.timers[key]);
    this.timers[key] = setTimeout(() => {
      this.timers[key] = undefined;
      Promise.resolve(fn()).catch((err) => this.log.warn('[%s] command failed: %s', this.name, err.message));
    }, ms);
  }

  pending() { return Object.values(this.timers).some(Boolean); }

  getServices() { return [this.informationService(), this.service]; }
}

class LightifyAccessory extends BaseAccessory {
  constructor(platform, device) {
    super(platform, device, 'Lightify');
    this.kind = 'light';
    const p = platform;

    this.service = new Service.Lightbulb(this.name);
    this.service.getCharacteristic(Characteristic.On)
      .onGet(p.guard(() => this.isOn()))
      .onSet(async (value) => {
        const on = !!value;
        try {
          await p.run((c) => c.nodeOnOff(this.target, on, this.isZone));
          this.device.status = on ? 1 : 0;
        } catch (err) {
          this.log.warn('[%s] on/off failed: %s', this.name, err.message);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });

    this.hasColor = !!(device.isColorSupported || (!device.isZone && lightify.isColorSupported(device.type)));
    this.hasTemp = !this.hasColor && !!(device.isTemperatureSupported || (!device.isZone && lightify.isTemperatureSupported(device.type)));
    this.hasBrightness = !!(device.isBrightnessSupported || (!device.isZone && lightify.isBrightnessSupported(device.type)));

    if (this.hasBrightness) this.setupBrightness();
    if (this.hasColor) this.setupColor();
    if (this.hasTemp) this.setupTemperature();
    this.syncHsv();
  }

  isOn() { return this.isOnline() && !!this.device.status; }

  setupBrightness() {
    const c = this.service.getCharacteristic(Characteristic.Brightness);
    c.onGet(this.platform.guard(() => clamp(this.device.brightness || 0, 0, 100)));
    c.onSet((value) => {
      this.device.brightness = value;
      this.debounce('brightness', 80, () =>
        this.platform.run((conn) => conn.nodeBrightness(this.target, value, 0, this.isZone)));
    });
  }

  syncHsv() {
    if (!this.hasColor || this.pending()) return;
    const hsv = rgbToHsv(this.device.red || 0, this.device.green || 0, this.device.blue || 0);
    // keep the last hue while the bulb is white; grey RGB carries no hue information
    if (hsv.s > 0 || this.hue === undefined) this.hue = hsv.h * 360;
    this.sat = hsv.s * 100;
  }

  setupColor() {
    const hue = this.service.getCharacteristic(Characteristic.Hue);
    const sat = this.service.getCharacteristic(Characteristic.Saturation);
    this.syncHsv();
    hue.onGet(this.platform.guard(() => this.hue || 0));
    sat.onGet(this.platform.guard(() => this.sat || 0));
    const send = () => this.debounce('color', 100, () => {
      const rgb = hsvToRgb((this.hue || 0) / 360, (this.sat || 0) / 100, 1);
      Object.assign(this.device, { red: rgb.r, green: rgb.g, blue: rgb.b });
      const alpha = this.device.alpha === undefined ? 255 : this.device.alpha;
      return this.platform.run((c) => c.nodeColor(this.target, rgb.r, rgb.g, rgb.b, alpha, 0, this.isZone));
    });
    hue.onSet((v) => { this.hue = v; send(); });
    sat.onSet((v) => { this.sat = v; send(); });
  }

  setupTemperature() {
    const c = this.service.getCharacteristic(Characteristic.ColorTemperature);
    c.onGet(this.platform.guard(() => kelvinToMired(this.device.temperature)));
    c.onSet((mired) => {
      const kelvin = miredToKelvin(mired);
      this.device.temperature = kelvin;
      this.debounce('temp', 80, () =>
        this.platform.run((conn) => conn.nodeTemperature(this.target, kelvin, 0, this.isZone)));
    });
  }

  updateDevice(d) {
    const busy = this.pending();
    this.device = d;
    const s = this.service;
    s.updateCharacteristic(Characteristic.On, this.isOn());
    if (busy) return; // don't fight a slider the user is still moving
    if (this.hasBrightness) s.updateCharacteristic(Characteristic.Brightness, clamp(d.brightness || 0, 0, 100));
    if (this.hasColor) {
      this.syncHsv();
      s.updateCharacteristic(Characteristic.Hue, this.hue || 0);
      s.updateCharacteristic(Characteristic.Saturation, this.sat || 0);
    }
    if (this.hasTemp) s.updateCharacteristic(Characteristic.ColorTemperature, kelvinToMired(d.temperature));
  }
}

class LightifyOutlet extends BaseAccessory {
  constructor(platform, device) {
    super(platform, device, 'Lightify Outlet');
    this.kind = 'plug';
    this.service = new Service.Outlet(this.name);
    this.service.getCharacteristic(Characteristic.OutletInUse).onGet(() => true);
    this.service.getCharacteristic(Characteristic.On)
      .onGet(platform.guard(() => this.isOnline() && !!this.device.status))
      .onSet(async (value) => {
        const on = !!value;
        try {
          await platform.run((c) => c.nodeOnOff(this.target, on, false));
          this.device.status = on ? 1 : 0;
        } catch (err) {
          this.log.warn('[%s] on/off failed: %s', this.name, err.message);
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
      });
  }

  updateDevice(d) {
    this.device = d;
    this.service.updateCharacteristic(Characteristic.On, this.isOnline() && !!d.status);
  }
}

class LightifySensor extends BaseAccessory {
  constructor(platform, device) {
    super(platform, device, 'Lightify Sensor');
    this.kind = 'sensor';
    this.service = new Service.ContactSensor(this.name);
    this.service.getCharacteristic(Characteristic.ContactSensorState)
      .onGet(platform.guard(() => this.state()));
  }

  state() { return this.isOnline() && this.device.green === 1 ? 1 : 0; }

  updateDevice(d) {
    this.device = d;
    this.service.updateCharacteristic(Characteristic.ContactSensorState, this.state());
  }
}
