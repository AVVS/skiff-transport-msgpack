'use strict';

var net = require('net');
var rpc = require('rpc-stream');
var once = require('once');
var MsgPack = require('msgpack-stream');
var reconnect = require('reconnect-net');
var EventEmitter = require('events').EventEmitter;

/**
 * Establishes rpc connection to a hostname:port, requires array of method names
 * which can be executed on the remote server
 *
 * @param  {Array}  remoteMethods - https://github.com/dominictarr/rpc-stream#rpcstreamwrapmethodnames
 * @param  {String} hostname
 * @param  {Number} port
 *
 * @return {EventEmitter}
 *   @param {Object} client - rpc client
 *   @param {Function} disconnect - close the connection
 *   @param {Boolean}  connected - read-only flag identifying the state of connection
 */
function connect(remoteMethods, hostname, port) {
    var r = reconnect().connect(port, hostname);
    var ee = new EventEmitter();

    function onConnect(con) {
        var remote = rpc();
        remote.pipe(MsgPack.createEncodeStream()).pipe(con);
        con.pipe(MsgPack.createDecodeStream()).pipe(remote);

        var client = remote.wrap(remoteMethods);

        ee.connected = true;
        ee.client = client;
        ee.emit('connect', client);
    }

    function onReconnect() {
        ee.emit('reconnect');
    }

    function onDisconnect() {
        ee.connected = false;
        ee.emit('disconnect');
    }

    function disconnect() {
        r.disconnect();
    }

    ee.connected = false;

    ee.disconnect = disconnect;

    r.on('connect', onConnect);
    r.on('reconnect', onReconnect);
    r.on('disconnect', onDisconnect);

    return ee;
}

/**
 * Establishes local rpc connection listener on the node
 *
 * @param  {Number}   port
 * @param  {String}   hostname
 * @param  {Object}   server   - object with functions that can be called locally.
 * @param  {Function} callback - called when local server has binded the ports or failed to do so
 *
 * @return {Object} - returns rpc server
 */
function listen(port, hostname, server, callback) {
    var netServer;

    // make sure it's called once
    callback = once(callback);

    /**
     * When remote connection is established to the server, pushes
     * connection references to the pool of opened connections.
     * Establishes connection close listener, which would remove connection from
     * the pool when it is closed. Pipes events from client to server and back
     * so that RPC calls would work over the net
     *
     * @param {Object} con
     */
    function onConnection(con) {
        netServer.__connections.push(con);

        var service = rpc(server);
        con.pipe(MsgPack.createDecodeStream()).pipe(service).
        pipe(MsgPack.createEncodeStream()).pipe(con);

        con.once('close', function rpcConnectionClosed() {
            var idx = netServer.__connections.indexOf(con);
            if (idx >= 0) {
                netServer.__connections.splice(idx, 1);
            }
        });
    }

    /**
     * Fires callback and cleans error listener once the connection
     * was established
     */
    function onceListening() {
        netServer.removeListener('error', callback);
        callback();
    }

    netServer = net.createServer(onConnection);
    netServer.__connections = [];
    netServer.listen(port, hostname, onceListening);
    netServer.once('error', callback);

    /**
     * Proxy server close calls
     * @type {Function}
     */
    var serverClose = netServer.close;
    netServer.close = function close(cb) {
        serverClose.call(netServer, cb);
        netServer.__connections.forEach(function closeOpenedConnections(con) {
            con.end();
        });
    };

    return netServer;
}

exports.connect = connect;
exports.listen = listen;
