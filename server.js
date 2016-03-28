"use strict";

const net = require('net'),
    rfb = require('./lib/rfb'),
    PNG = require('png-js'); // Replace with pixel-getter or similar to support other file types?

function start(info) {
    var server = net.createServer((socket) => {
        const r = new rfb((data) => socket.write(data), () => socket.end(), info);
        r.on("cuttext", t => console.log(t));
        r.on("pointer", p => console.log(p));
        r.on("key", k => console.log(k));
        socket.on("data", (data) => r.process(data));
        socket.on("error", (err) => console.log(err));
    }).on('error', (err) => {
        // handle errors here
        console.log(err);
        //throw err;
    });

    server.listen(5900, () => {
        const address = server.address();
        console.log('opened server on %j', address);
    });
}

function dropalpha(input) {
    // png-js uses 4 bytes per pixel, where the 4th byte is the alpha channel, we don't support that
    const pixels = input.length / 4, 
        out = new Buffer(pixels * 3);
    for (let i = 0; i < pixels; ++i) {
        out[i*3 + 0] = input[i*4 + 0];
        out[i*3 + 1] = input[i*4 + 1];
        out[i*3 + 2] = input[i*4 + 2];
    }
    return out;
}

var p = PNG.load("./test.png");
const info = {
    name: "test.png",
    width: p.width,
    height:p.height
};

p.decode(d => {
    info.buffer = dropalpha(d);
    start(info);
});
