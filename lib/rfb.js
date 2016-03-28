"use strict";

const EventEmitter = require('events'),
    util = require('util');

/**
 * Writer callback
 *
 * This callback is invoked to send data to the client
 * @Callback rfb~writer
 * @param {String|Buffer} Data to be written
 */

/**
 * Close callback
 *
 * This is called to close a session
 * @Callback rfb~closer
 */

/**
 * Information about our display
 * @typedef {Object} rfb~Info
 * @property {String} name A name reported to the client, should be ASCII only
 * @property {Number} width Width of the display in pixels
 * @property {Number} height Height of the display in pixels
 * @property {Buffer} buffer The state of our display. This is a 1-D buffer with width*height*3 elements with left-to-right top-to-bottom red geen and blue channels
 */

/**
 * RGB-Info
 * @private
 * @typedef {Object} RGB
 * @property {Number} red
 * @property {Number} green
 * @property {Number} blue
 */

/**
 * @private
 * @param {RGB} maxima
 * @param {RGB} shifts
 * @property {RGB} maxima
 * @property {RGB} shifts
 * @constructor
 */
function Encoder(maxima, shifts) {
    this.maxima = maxima;
    this.shifts = shifts;
}

Encoder.prototype.encode = function (red, green, blue) {
    return ((Math.round(this.maxima.red   / 255) * red)   << this.shifts.red)
      + ((Math.round(this.maxima.green / 255) * green) << this.shifts.green)
      + ((Math.round(this.maxima.blue  / 255) * blue)  << this.shifts.blue);
};

/**
 * @private
 * @param {rfb} rfb
 * @param {rfb~writer} writer
 * @param {rfb~closer} closer
 * @property {Encoder} encoder
 * @property {Number} byteperpixel
 * @property {rfb-writer} write
 * @property {rfb-closer} close
 * @property {rfb} rfb
 * @constructor
 */
function RfbImpl(rfb, writer, closer) {
    this.stateHandler = undefined;
    this.colorWriteFunc = undefined;
    this.encoder = undefined;
    this.byteperpixel = undefined; // Note: The protocol uses bits, we directly go to bytes here

    this.write = writer;
    this.close = closer;

    this.rfb = rfb;

    this.clientMessageHandlers = [
        this.clientSetPixelFormat,
        undefined,
        this.clientSetEncoding,
        this.clientUpdateRequest,
        this.clientKeyEvent,
        this.clientPointerEvent,
        this.clientCutText
    ];
}

RfbImpl.prototype.initHandshake = function () {
    this.stateHandler = this.expectHandshake;
    this.write("RFB 003.008\n");
};

RfbImpl.prototype.expectHandshake = function (data) {
    if (["RFB 003.003\n", "RFB 003.007\n", "RFB 003.008\n"].find(v => { return v === data.toString() } ) === undefined) {
        this.write(new Buffer([0]));
        this.close();
        throw new Error("Invalid client version " + data.toString());
    }

    this.version = data.toString();

    if (this.version !== "RFB 003.003\n") {
        this.informSecurity();
    } else {
        this.informOldSecurity();
    }
};

RfbImpl.prototype.informSecurity = function () {
    this.write(new Buffer([1, 1]));
    this.stateHandler = this.expectNoAuth;
};

RfbImpl.prototype.informOldSecurity = function () {
    this.write(new Buffer([0,0,0,1]));
    //this.write(new Buffer([0,0,0,0]));

    this.stateHandler = this.expectClientInit;
};

RfbImpl.prototype.expectNoAuth = function (data) {
    if (data.length !== 1 || data[0] !== 1) {
        this.close();
        throw new Error("Expected the client to accept auth method 1 (no auth)")
    }
    // AUTH OK
    this.write(new Buffer([0,0,0,0]));

    this.stateHandler = this.expectClientInit;
};

RfbImpl.prototype.expectClientInit = function (data) {
    if (data.length !== 1) {
        this.close();
        throw new Error("Expected a single byte (shared)");
    }

    // if data[0] === 0 the client expects us to disconnect other clients, we don't care

    const maxima = { red: 255, green: 255, blue: 255 },
        shifts = { red: 16, green: 8, blue: 0 };
    this.byteperpixel = 4;

    const serverInit = new Buffer(2+2+16+4+this.rfb.info.name.length);
    serverInit.writeUInt16BE(this.rfb.info.width, 0);
    serverInit.writeUInt16BE(this.rfb.info.height, 2);

    serverInit.writeInt8(this.byteperpixel * 8 /* bits per pixel */, 4);
    serverInit.writeInt8(24 /* depth */, 5);
    serverInit.writeInt8(0 /* litle endian */, 6);
    serverInit.writeInt8(1 /* true color */, 7);
    serverInit.writeUInt16BE(maxima.red, 8);
    serverInit.writeUInt16BE(maxima.green, 10);
    serverInit.writeUInt16BE(maxima.blue, 12);
    serverInit.writeInt8(shifts.red, 14);
    serverInit.writeInt8(shifts.green, 15);
    serverInit.writeInt8(shifts.blue, 16);

    this.encoder = new Encoder(maxima, shifts);
    this.colorWriteFunc = Buffer.prototype.writeInt32LE;

    serverInit.write("\0\0\0" /* padding */, 17);

    serverInit.writeUInt32BE(this.rfb.info.name.length, 20);
    serverInit.write(this.rfb.info.name, 24);

    this.write(serverInit);
    this.stateHandler = this.expectClientRequest;
    this.sendRect(0, 0, this.rfb.info.width, this.rfb.info.height);
};

RfbImpl.prototype.expectClientRequest = function (data) {
    const handler = this.clientMessageHandlers[data[0]];
    if (!handler) {
        console.log("Unknown request", data[0]);
        // ignored for now
        return;
    }

    handler.call(this, data);
};

RfbImpl.prototype.clientSetPixelFormat = function (data) {
    if (!data[7]) {
        this.close();
        throw new Error("Palette mode requested, but we only do true color");
    }
    const bigendian = !!data[6];

    if (data[4] === 8) {
        this.colorWriteFunc = Buffer.prototype.writeInt8;
    } else if (data[4] == 16) {
        this.colorWriteFunc = bigendian ? Buffer.prototype.writeInt16BE : Buffer.prototype.writeInt16LE;
    } else if (data[4] == 32) {
        this.colorWriteFunc = bigendian ? Buffer.prototype.writeInt32BE : Buffer.prototype.writeInt32LE;
    } else {
        this.close();
        throw new Error("We only support 32, 16 or 8 bit per pixel");
    }

    this.byteperpixel = data[4];

    this.encoder = new Encoder(
        { red: data.readUInt16BE(8), green: data.readUInt16BE(10), blue: data.readUInt16BE(12) },
        { red: data.readUInt8(14), green: data.readUInt8(15), blue: data.readUInt8(16) }
    );

};
RfbImpl.prototype.clientSetEncoding = function (data) {};

RfbImpl.prototype.clientUpdateRequest = function (data) {
    const incremental = !!data[1],
        x = data.readUInt16BE(2),
        y = data.readUInt16BE(4),
        width = data.readUInt16BE(6),
        height = data.readUInt16BE(8);

    this.sendRect(x, y, width, height);
};

RfbImpl.prototype.sendRect = function (x, y, width, height) {
    const r = new Buffer(4 + 12 + width * height * this.byteperpixel);
    r[0] = 0; // FramebufferUpdate
    r[1] = 0; // Padding
    r.writeUInt16BE(1, 2); // Number of rectangles

    r.writeUInt16BE(x, 4);
    r.writeUInt16BE(y, 6);
    r.writeUInt16BE(width, 8);
    r.writeUInt16BE(height, 10);
    r.writeInt32BE(0, 12); // Raw encoding

    const source = this.rfb.info.buffer;

    for (let i = 0; i < width*height; ++i) {
        this.colorWriteFunc.call(r, this.encoder.encode(source[3*i + 0], source[3*i+1], source[3*i+2]), 16 + ( this.byteperpixel * i) );
    }
    //console.log(r);
    this.write(r);
};

RfbImpl.prototype.clientKeyEvent = function (data) {
    const keycode = data.readInt32BE(4);
    this.rfb.emit("key", {
        released: !data[1],
        keycode: keycode,
        key: (keycode & 0x80) ? undefined : String.fromCharCode(keycode)
    });
};

RfbImpl.prototype.clientPointerEvent = function (data) {
    const buttons = [];
    for (let button = 0; button < 8; ++button) {
        if (data[1] & (1 << button)) {
            buttons.push(button);
        }
    }
    this.rfb.emit("pointer", {
        button: buttons,
        x: data.readUInt16BE(2),
        y: data.readUInt16BE(4)
    });
};

RfbImpl.prototype.clientCutText = function (data) {
    const len = data.readUInt32BE(4);
    this.rfb.emit('cuttext', data.toString('utf8', 8, len + 8));
};

RfbImpl.prototype.serverCutText = function (text) {
    const buf = new Buffe(8 + text.length);
    buf[0] = 3;
    buf.writeUInt32BE(text.length, 4);
    buf.write(text, 8);
    this.write(buf);
};

/**
 * Remote Frame Buffer Protocol
 * @constructor
 * @property {rfb~Info} info Current state, you might try changing the buffer, eventually the client will pick up the changes
 * @param {rfb~writer} writer Callback which can be used to write data
 * @param {rfb~closer} closer Callback which closes the connection
 * @param {rfb~Info} info
 */
function rfb(writer, closer, info) {
    EventEmitter.call(this);

    this.info = info;
    this.impl = new RfbImpl(this, writer, closer);
    this.impl.initHandshake();
}

util.inherits(rfb, EventEmitter);

/**
 * Process network request
 * 
 * This processes data received from network
 * 
 * Known limitation: Currently we expect this to be one complete client request, fragmented TCP packages, or TCP 
 * packages with multiple requests aren't handled correctly
 * 
 * @param {Buffer} data
 */
rfb.prototype.process = function (data) {
    //console.log("Received", data.toString());
    this.impl.stateHandler(data);
};

/**
 * Send Cut Text to Client
 * 
 * This can be used to overwrite the client's clipboard content. The provided text should be ASCII-only
 * 
 * @param {String} text
 */
rfb.prototype.sendCutText = function(text) {
    this.impl.serverCutText(text);
};

module.exports = rfb;