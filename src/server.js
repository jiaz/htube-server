import express from 'express';
import cookieParser from 'cookie-parser';
import http from 'http';

import logger from './logger';
import socket from './socket';

const app = express();
const server = http.createServer(app);

app.use(cookieParser());

socket(server);

server.listen(3000, () => {
  logger.warn('server started...');
});
