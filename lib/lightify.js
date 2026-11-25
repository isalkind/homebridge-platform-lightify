'use strict';

/*
 * Minimal client for the OSRAM Lightify gateway's local binary protocol (TCP/4000).
 *
 * Derived from node-lightify 2.1.13 (rainlake). Changes: no dependencies, native Promises,
 * Buffer.alloc/from, proper frame parsing (several frames per TCP chunk), strictly serialized
 * requests, timeouts that actually settle, and MACs kept as hex strings instead of doubles.
 */

const net = require('net');

const CMD = {
  LIST_ALL_NODE: 0x13,
  LIST_ALL_ZONE: 0x1e,
  GET_ZONE_INFO: 0x26,
  BRIGHTNESS: 0x31,
  ONOFF: 0x32,
  TEMP: 0x33,
  COLOR: 0x36,
};

const TYPE = {
  ONOFF_LIGHT: 0x01,
  COLORTEMP_DIMMABLE_LIGHT: 0x02,
  DIMMABLE_LIGHT: 0x04,
  COLOR_LIGHT: 0x08,
  EXT_COLOR_LIGHT: 0x0a,
  PLUG: 0x10,
  SENSOR: 0x20,
  TWO_BTN_SWITCH: 0x40,
  FOUR_BTN_SWITCH: 0x41,
};

const isPlug = (t) => t === TYPE.PLUG;
const isSensor = (t) => t === TYPE.SENSOR;
const isSwitch = (t) => t === TYPE.TWO_BTN_SWITCH || t === TYPE.FOUR_BTN_SWITCH;
const nodeType = (t) => (isPlug(t) ? 16 : t);

function cstring(buf, start, end) {
  let i = start;
  while (i < end && i < buf.length && buf[i] !== 0) i++;
  return buf.toString('utf8', start, i);
}

// target: 16-hex-char MAC string for a node, or a numeric zone id
function targetBuffer(target, len) {
  const body = Buffer.alloc(len);
  if (typeof target === 'string') {
    Buffer.from(target.slice(0, 16), 'hex').copy(body, 0);
  } else {
    body.writeUInt16LE(target, 0);
  }
  return body;
}

let seqCounter = 0;

class Lightify {
  constructor(ip, logger, opts = {}) {
    this.ip = ip;
    this.logger = logger;
    this.port = opts.port || 4000;
    this.connectTimeout = opts.connectTimeout || 5000;
    this.commandTimeout = opts.commandTimeout || 5000;
    this.socket = null;
    this.rx = Buffer.alloc(0);
    this.queue = [];
    this.inflight = null;
    this.disposed = false;
  }

  debug(...args) {
    if (this.logger && this.logger.debug) this.logger.debug(...args);
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const socket = new net.Socket();
      this.socket = socket;
      socket.setNoDelay(true);

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.destroy();
        reject(new Error(`connect timeout to ${this.ip}:${this.port}`));
      }, this.connectTimeout);

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('error', (err) => {
        this.debug('socket error: %s', err.message);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
        this._failAll(err);
      });
      socket.on('close', () => this._failAll(new Error('connection closed')));

      socket.connect(this.port, this.ip, () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  dispose() {
    this.disposed = true;
    this._failAll(new Error('disposed'));
    if (this.socket) {
      this.socket.removeAllListeners('data');
      this.socket.on('error', () => {});
      this.socket.destroy();
    }
  }

  _failAll(err) {
    const pending = this.queue.splice(0);
    if (this.inflight) pending.unshift(this.inflight);
    this.inflight = null;
    for (const cmd of pending) {
      if (cmd.timer) clearTimeout(cmd.timer);
      cmd.reject(err);
    }
  }

  _onData(chunk) {
    this.rx = this.rx.length ? Buffer.concat([this.rx, chunk]) : chunk;
    while (this.rx.length >= 2) {
      const total = this.rx.readUInt16LE(0) + 2;
      if (total < 9) {
        // garbage; drop everything rather than loop forever
        this.rx = Buffer.alloc(0);
        return;
      }
      if (this.rx.length < total) return;
      const frame = this.rx.subarray(0, total);
      this.rx = this.rx.subarray(total);
      this._onFrame(frame);
    }
  }

  _onFrame(frame) {
    const seq = frame.readUInt32LE(4);
    this.debug('response seq=%d %s', seq, frame.toString('hex'));
    const cmd = this.inflight;
    if (!cmd || cmd.seq !== seq) return; // stale reply to a request that already timed out
    clearTimeout(cmd.timer);
    this.inflight = null;
    try {
      cmd.resolve(this._parse(cmd, frame));
    } catch (err) {
      cmd.reject(err);
    }
    this._pump();
  }

  _parse(cmd, frame) {
    const fail = frame.readUInt8(8);
    if (fail) {
      const err = new Error(`gateway returned error ${fail} for command 0x${cmd.cmdId.toString(16)}`);
      err.fail = fail;
      throw err;
    }
    const result = [];
    if (cmd.parse) {
      // the gateway reports a wrong count for zone info on newly created zones; always 1 record
      const num = cmd.cmdId === CMD.GET_ZONE_INFO ? 1 : frame.length >= 11 ? frame.readUInt16LE(9) : 0;
      const size = cmd.packageSize || (num ? Math.floor((frame.length - 11) / num) : 0);
      for (let i = 0; i < num; i++) {
        const pos = 11 + i * size;
        if (pos + size > frame.length) break;
        result.push(cmd.parse(frame, pos));
      }
    }
    return { result };
  }

  _send(cmdId, body, flag, parse, packageSize) {
    return new Promise((resolve, reject) => {
      if (this.disposed) return reject(new Error('disposed'));
      this.queue.push({ cmdId, body, flag, parse, packageSize, resolve, reject });
      this._pump();
    });
  }

  _pump() {
    if (this.inflight || !this.queue.length || !this.socket || this.socket.destroyed) return;
    const cmd = this.queue.shift();
    const seq = ++seqCounter >>> 0;
    const buf = Buffer.alloc(8 + cmd.body.length);
    buf.writeUInt16LE(buf.length - 2, 0);
    buf.writeUInt8(cmd.flag, 2); // 0 = node, 2 = zone
    buf.writeUInt8(cmd.cmdId, 3);
    buf.writeUInt32LE(seq, 4);
    cmd.body.copy(buf, 8);
    cmd.seq = seq;
    cmd.timer = setTimeout(() => {
      if (this.inflight !== cmd) return;
      this.inflight = null;
      cmd.reject(new Error(`command 0x${cmd.cmdId.toString(16)} timed out`));
      this._pump();
    }, this.commandTimeout);
    this.inflight = cmd;
    this.debug('send seq=%d %s', seq, buf.toString('hex'));
    this.socket.write(buf);
  }

  discover() {
    return this._send(CMD.LIST_ALL_NODE, Buffer.from([0x01]), 0, (d, pos) => ({
      id: d.readUInt16LE(pos),
      mac: d.toString('hex', pos + 2, pos + 10),
      friendlyMac: d.toString('hex', pos + 2, pos + 10),
      type: d.readUInt8(pos + 10),
      firmware_version: d.readUInt32BE(pos + 11),
      online: d.readUInt8(pos + 15),
      groupid: d.readUInt16LE(pos + 16),
      status: d.readUInt8(pos + 18),
      brightness: d.readUInt8(pos + 19),
      temperature: d.readUInt16LE(pos + 20),
      red: d.readUInt8(pos + 22),
      green: d.readUInt8(pos + 23),
      blue: d.readUInt8(pos + 24),
      alpha: d.readUInt8(pos + 25),
      name: cstring(d, pos + 26, pos + 50),
    }), 50);
  }

  discoverZone() {
    return this._send(CMD.LIST_ALL_ZONE, Buffer.from([0x00]), 0, (d, pos) => ({
      id: d.readUInt16LE(pos),
      name: cstring(d, pos + 2, pos + 18),
    }));
  }

  getZoneInfo(zoneId) {
    const body = Buffer.alloc(2);
    body.writeUInt16LE(zoneId, 0);
    return this._send(CMD.GET_ZONE_INFO, body, 0, (d, pos) => {
      const info = { groupNo: zoneId, name: cstring(d, pos, pos + 15), devices: [] };
      const cnt = d.readUInt8(pos + 16);
      for (let i = 0; i < cnt; i++) {
        const p = pos + 17 + i * 8;
        if (p + 8 > d.length) break;
        info.devices.push(d.toString('hex', p, p + 8));
      }
      return info;
    });
  }

  nodeOnOff(target, on, isZone) {
    const body = targetBuffer(target, 9);
    body.writeUInt8(on ? 1 : 0, 8);
    return this._send(CMD.ONOFF, body, isZone ? 2 : 0);
  }

  nodeBrightness(target, brightness, stepTime, isZone) {
    const body = targetBuffer(target, 11);
    body.writeUInt8(Math.round(brightness), 8);
    body.writeUInt16LE(stepTime || 0, 9);
    return this._send(CMD.BRIGHTNESS, body, isZone ? 2 : 0);
  }

  nodeTemperature(target, kelvin, stepTime, isZone) {
    const body = targetBuffer(target, 12);
    body.writeUInt16LE(Math.round(kelvin), 8);
    body.writeUInt16LE(stepTime || 0, 10);
    return this._send(CMD.TEMP, body, isZone ? 2 : 0);
  }

  nodeColor(target, r, g, b, alpha, stepTime, isZone) {
    const body = targetBuffer(target, 14);
    body.writeUInt8(r, 8);
    body.writeUInt8(g, 9);
    body.writeUInt8(b, 10);
    body.writeUInt8(alpha === undefined ? 255 : alpha, 11);
    body.writeUInt16LE(stepTime || 0, 12);
    return this._send(CMD.COLOR, body, isZone ? 2 : 0);
  }
}

module.exports = {
  Lightify,
  CMD,
  TYPE,
  isPlug,
  isSensor,
  isSwitch,
  isLight: (t) => !isSwitch(t) && !isPlug(t) && !isSensor(t),
  isBrightnessSupported: (t) =>
    nodeType(t) === TYPE.COLORTEMP_DIMMABLE_LIGHT ||
    nodeType(t) === TYPE.DIMMABLE_LIGHT ||
    (!isPlug(t) && nodeType(t) !== TYPE.ONOFF_LIGHT),
  isTemperatureSupported: (t) =>
    nodeType(t) === TYPE.COLORTEMP_DIMMABLE_LIGHT || nodeType(t) === TYPE.EXT_COLOR_LIGHT,
  isColorSupported: (t) => nodeType(t) === TYPE.EXT_COLOR_LIGHT || nodeType(t) === TYPE.COLOR_LIGHT,
};
