'use strict';

import bunyan from 'bunyan';
import _ from 'lodash';

const logger = bunyan.createLogger({name: 'htube-server', level: 'trace'});

const logLevels = {
  'verbose': 'trace',
  'debug': 'debug',
  'info': 'info',
  'warn': 'warn',
  'error': 'error',
};

const defaultLogger = {};

function log(level) {
  return (...args) => {
    logger[level].apply(logger, args);
  };
}

_.forEach(logLevels, (v, k) => {
  defaultLogger[k] = log(v);
});

export default defaultLogger;
