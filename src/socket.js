'use strict';

import _ from 'lodash';
import io from 'socket.io';
import cookie from 'cookie';
import crypto from 'crypto';
import zlib from 'zlib';
import URLSafeBase64 from 'urlsafe-base64';
import socketStream from 'socket.io-stream';
import progress from 'progress-stream';

import logger from './logger';

const clientMap = new WeakMap();
const pendingRequests = {};

const pubKey = "-----BEGIN PUBLIC KEY-----\n"
  +"MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA1LNMsQAHIiX0x9D4gL+M\n"
  +"wxyC+LndNIlvUzEmhzTF/gQwsCo7hOFCTGnwDxww3WemuKQbXAIiQr8OtJGeJ/Dm\n"
  +"O057qCFiQO6uAkxmtX9YOyK3zJfu7MPUnLA02F51JV/Vg7JuKJnT67kJ3gh2g8Yi\n"
  +"dS7Mb1uDXTR0EkhQ6IDfW4P0GENzYL/IOuJO9oVGiBK0CPqu0GBp4FfZFGrzgXwM\n"
  +"n504Povp2kKmw6tyzDzJVeLvNTy8ZkWpI+37WGiXpi4By3wOIbZXkdGjdM1WITuT\n"
  +"fc2dA6q9dHVa3N4kKSSk9M+iB4r3O2Wi+xERlaF3Naxvcvj/hxjGn2fb6VBFpd7/\n"
  +"BQIDAQAB\n"
  +"-----END PUBLIC KEY-----";

let requestId = 0;

class Request {
  constructor() {
    this.id = requestId++;
    this.srcFile = null;
    this.dstFile = null;
    this.fileSize = null;
    this.srcClient = null;
    this.dstClient = null;
  }
}

class UserProfile {
  constructor(firstName, lastName, userGuid, avatar) {
    this.firstName = firstName;
    this.lastName = lastName;
    this.userGuid = userGuid;
    this.avatar = avatar;
  }
}

class Session {
  constructor(ssoData, ssoSig) {
    this.ssoData = ssoData;
    this.ssoSig = ssoSig;

    // verify the cookie
    const decodedSig = URLSafeBase64.decode(ssoSig);
    const verify = crypto.createVerify('RSA-SHA1');
    verify.update(ssoData);
    const verifyResult = verify.verify(pubKey, decodedSig);
    logger.info('signature verify result: ' + verifyResult);
    if (verifyResult == false) {
      throw new Error('Unable to verify sso cookie');
    }
    const unpackedData = zlib.unzipSync(new Buffer(ssoData, 'base64'));
    logger.info('unpacked data: %s', unpackedData);
    const unpackedObject = JSON.parse(unpackedData);

    this.userProfile = new UserProfile(
      unpackedObject.first_name,
      unpackedObject.last_name,
      unpackedObject.objectGUID,
      'http://yearbook.prod.hulu.com/api/person/'+ unpackedObject.username +'/picture.jpg?type=profile');
  }
}

function createSession(cookies) {
  const parsedCookie = cookie.parse(cookies);
  logger.info('cookie %j', parsedCookie);
  logger.info('sso_data: %s, sso_sig: %s', parsedCookie.hulu_sso_data, parsedCookie.hulu_sso_sig);
  const ssoData = parsedCookie.hulu_sso_data;
  const ssoSig = parsedCookie.hulu_sso_sig;
  return new Session(ssoData, ssoSig);
}

class SocketApp {
  constructor(ioServer) {
    this.cmdHandler = {
      'ls': this.lsHandler.bind(this),
      'send': this.sendHandler.bind(this)
    };

    this.ioServer = ioServer;
    ioServer.on('connection', this.onNewConnection.bind(this));
  }

  onNewConnection(clientSocket) {
    logger.info('a user connected!');
    this.hookEvents(clientSocket);
    this.authClient(clientSocket);
  }

  lsHandler(socket, cmd, args, cb) {
    let clientNames = [];
    _.forEach(this.ioServer.sockets.sockets, function(socket, id) {
      clientNames.push(socket.session.userProfile);
      cb(null, clientNames);
    });
    // this.ioServer.sockets.sockets.forEach((socket) => {
    //   clientNames.push(socket.session.userProfile);
    // });
    // cb(null, clientNames);
  }

  sendHandler(socket, cmd, args, cb) {
    let [user, file, fileSize] = args;
    let userSocket = null;
    this.ioServer.sockets.sockets.forEach((socket) => {
      if (clientMap.get(socket) === user) {
        userSocket = socket;
      }
    });
    if (userSocket === null) {
      cb(null, 'no such user.');
    } else {
      let req = new Request();
      req.srcFile = file;
      req.fileSize = fileSize;
      req.srcClient = socket;
      req.dstClient = userSocket;
      pendingRequests[req.id] = req;
      userSocket.emit('request_file', {file, id: req.id});
      cb(null, 'request sent.');
    }
  }

  processCommand(socket, cmd, args, callback) {
    let handler = this.cmdHandler[cmd];
    if (handler) {
      handler(socket, cmd, args, callback);
    } else {
      callback(null, 'unknown cmd.');
    }
  }

  authClient(socket) {
    let cookie = socket.request.headers.cookie;
    console.log('auth client cookies');
    console.log(socket.request.headers);
    if (!cookie) {
      socket.emit('auth_required');
    } else {
      let session = createSession(cookie);
      socket.session = session;
      socket.emit('hello', {
        message: 'welcome to hfserver.',
        session: session
      });
    }
  }

  hookEvents(clientSocket) {
    let clientSocketStream;
    clientSocketStream = socketStream(clientSocket);
    clientSocketStream.on('file_data', (readStream, data) => {
      logger.info('piping data...');
      let req = pendingRequests[data.id];
      let pgStream = progress({
        length: req.fileSize,
        time: 1000
      });
      let writeStream = socketStream.createStream();
      socketStream(req.dstClient).emit('receive_file',
        writeStream,
        {file: req.dstFile, id: req.id}
      );
      pgStream.on('progress', p => {
        logger.info('progress: ' + JSON.stringify(pgStream.progress()));
        req.dstClient.emit('progress', {percentage: p.percentage});
        req.srcClient.emit('progress', {percentage: p.percentage});
      });
      readStream.pipe(pgStream).pipe(writeStream);
    });

    clientSocket.on('disconnect', function () {
      logger.info('user disconnected.');
    });

    clientSocket.on('cmd', (data) => {
      logger.info(`get a cmd: ${data.cmd} [${data.seqId}] with args ${data.args}`);
      this.processCommand(clientSocket, data.cmd, data.args, (err, res) => {
        clientSocket.emit('ready', {seqId: data.seqId, error: err, response: res});
      });
    });

    clientSocket.on('accept', (data) => {
      logger.info('accepted, save to: ' + data.file);
      let id = data.id;
      let req = pendingRequests[id];
      req.dstFile = data.file;
      req.srcClient.emit('send_file', {file: req.srcFile, id: id});
    });

    clientSocket.on('receive_done', (data) => {
      let req = pendingRequests[data.id];
      req.dstClient.emit('ready', {message: 'transfer finished!'});
      req.srcClient.emit('ready', {message: 'transfer finished!'});
      delete pendingRequests[data.id];
    });

    clientSocket.on('deny', (data) => {
      logger.info('denied.');
      clientSocket.emit('ready', {message: 'request denied.'});
      pendingRequests[data.id].srcClient.emit('ready', {message: 'request denied.'});
      delete pendingRequests[data.id];
    });
  }
}

function createSocketApp(server) {
  const ioServer = io(server);
  return new SocketApp(ioServer);
}

export default createSocketApp;
