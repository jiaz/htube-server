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
    this.guid = null;
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

  getUserId() {
    return this.userProfile.userGuid;
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
      'cmd_ls': this.listUserHandler.bind(this),
      'cmd_send_file': this.sendFileHandler.bind(this),
      'cmd_receive_file': this.receiveFileHandler.bind(this)
    };

    this.ioServer = ioServer;
    ioServer.on('connection', this.onNewConnection.bind(this));
  }

  onNewConnection(clientSocket) {
    logger.info('a user connected!');
    this.hookEvents(clientSocket);
    this.authClient(clientSocket);
    if (clientSocket.session) {
      clientMap.set(clientSocket, clientSocket.session.getUserId());
    }
  }

  listUserHandler(socket, cmd, args, cb) {
    let clientNames = [];

    _.forEach(this.ioServer.sockets.sockets, function(socket, id) {
      console.log(id);
      if (socket.session) {
        clientNames.push(socket.session.userProfile);
      }
    });

    cb(null, clientNames);
  }

  sendFileHandler(socket, cmd, args, cb) {
    let [receiver, file, fileSize, guid] = args;
    let dstClientSocket = null;
    _.forEach(this.ioServer.sockets.sockets, function(s, id) {
      if (clientMap.get(s) === receiver) {
        dstClientSocket = s;
      }
    });

    if (dstClientSocket === null) {
      cb(null, 'no such user.');
    } else {
      let req = new Request();
      req.srcFile = file;
      req.fileSize = fileSize;
      req.guid = guid;
      req.srcClient = socket;
      req.dstClient = dstClientSocket;
      pendingRequests[guid] = req;
      let sender = clientMap.get(socket);
      dstClientSocket.emit('ev_receive_file', {sender, file, fileSize, guid});
      cb(null, 'file send request is sent.');
    }
  }

  receiveFileHandler(socket, cmd, args, cb) {
    let [sender, guid] = args;
    let srcClientSocket = null;
    _.forEach(this.ioServer.sockets.sockets, function(socket, id) {
      if (clientMap.get(socket) === sender) {
        srcClientSocket = socket;
      }
    });

    if (srcClientSocket === null) {
      cb(null, 'no such user.');
    } else {
      srcClientSocket.emit('ev_send_file', {guid: guid});
      cb(null, 'confirmed to receive file.');
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

  announceUserLogin(session) {
    this.ioServer.emit('ev_user_connected');
  }

  announceUserLogout(session) {
    this.ioServer.emit('ev_user_disconnected');
  }

  authClient(socket) {
    let cookie = socket.request.headers.cookie;
    if (!cookie) {
      socket.emit('ev_auth_required');
    } else {
      let session = createSession(cookie);
      socket.session = session;
      socket.emit('ev_hello', {
        message: 'welcome to hfserver.',
        session: session
      });
      this.announceUserLogin(session);
    }
  }

  handleFileStreaming(clientSocket) {
    let clientSocketStream = socketStream(clientSocket);

    clientSocketStream.on('ev_ss_send_file', (readStream, params) => {
      logger.info('socket stream sending data...: ' + JSON.stringify(params));
      let req = pendingRequests[params.guid];
      
      let pgStream = progress({length: req.fileSize, time: 500});
      
      let writeStream = socketStream.createStream();
      socketStream(req.dstClient).emit('ev_ss_receive_file', writeStream, params);
      
      req.srcClient.emit('ev_progress_start', {guid: req.guid, isSender: true});
      req.dstClient.emit('ev_progress_start', {guid: req.guid, isSender: false});

      pgStream.on('progress', p => {
        logger.info('progress: ' + JSON.stringify(pgStream.progress()));
        req.srcClient.emit('ev_progress_update', {
                                                  guid: req.guid,
                                                  percentage: p.percentage,
                                                  total_size: p.length,
                                                  current_size: p.transferred,
                                                  transfer_rate: p.speed,
                                                  eta: p.eta,
                                                  isSender: true
                                                });
        req.dstClient.emit('ev_progress_update', {
                                                  guid: req.guid,
                                                  percentage: p.percentage,
                                                  total_size: p.length,
                                                  current_size: p.transferred,
                                                  transfer_rate: p.speed,
                                                  eta: p.eta,
                                                  isSender: false
                                                });
      });

      pgStream.on('end', () => {
        req.dstClient.emit('ev_progress_end', {guid: req.guid, isSender: true});
        req.srcClient.emit('ev_progress_end', {guid: req.guid, isSender: false});
        delete pendingRequests[req.guid];
      });

      readStream.pipe(pgStream).pipe(writeStream);
    });
  }

  hookEvents(clientSocket) {
    clientSocket.on('disconnect', () => {
      logger.info('user disconnected.');
      this.announceUserLogout(clientSocket.session);
    });

    clientSocket.on('cmd', (data) => {
      logger.info(`get a cmd: ${data.cmd} [${data.seqId}] with args ${data.args}`);
      this.processCommand(clientSocket, data.cmd, data.args, (err, res) => {
        clientSocket.emit('ev_ready', {seqId: data.seqId, error: err, response: res});
      });
    });

    this.handleFileStreaming(clientSocket);
  }
}

function createSocketApp(server) {
  const ioServer = io(server);
  return new SocketApp(ioServer);
}

export default createSocketApp;
