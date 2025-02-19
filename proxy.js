const net = require('net');
const fs = require('fs');
const path = require('path');
const express = require('express');
const winston = require('winston');

// Configuration
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
const POOLS = config.pools;
const PROXY_PORT = config.proxyPort || 3333;
const METRICS_PORT = config.metricsPort || 3000;

// Logger setup
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'proxy.log' })
  ]
});

// Stratum Protocol Validator
class StratumValidator {
  static isValidMessage(msg) {
    try {
      const obj = JSON.parse(msg);
      return this.validateStructure(obj);
    } catch (e) {
      return false;
    }
  }

  static validateStructure(obj) {
    if (!obj.id && obj.id !== 0) return false;
    if (!obj.method && !obj.result && !obj.error) return false;
    
    return obj.method ? this.validateRequest(obj) : this.validateResponse(obj);
  }

  static validateRequest(obj) {
    const validMethods = new Set([
      'mining.subscribe', 'mining.authorize', 'mining.configure',
      'mining.submit', 'mining.extranonce.subscribe'
    ]);

    if (!validMethods.has(obj.method)) return false;
    if (!Array.isArray(obj.params)) return false;

    switch(obj.method) {
      case 'mining.subscribe':
        return obj.params.length >= 2;
      case 'mining.authorize':
        return obj.params.length >= 2 && 
               this.validateWorkerName(obj.params[0]) &&
               typeof obj.params[1] === 'string';
      case 'mining.submit':
        return this.validateSubmitParams(obj.params);
      case 'mining.configure':
        return this.validateDifficulty(obj.params[1]);
    }
    return true;
  }

  static validateResponse(obj) {
    if (obj.error && !Array.isArray(obj.error)) return false;
    return obj.result !== undefined;
  }

  static validateDifficulty(diff) {
    return Number.isInteger(diff) && diff > 0;
  }

  static validateExtranonce(nonce) {
    return typeof nonce === 'string' && 
           nonce.length % 2 === 0 && 
           /^[0-9a-fA-F]+$/.test(nonce);
  }

  static validateWorkerName(name) {
    return typeof name === 'string' && 
           name.length <= 64 && 
           /^[\x20-\x7E]+$/.test(name);
  }

  static validateSubmitParams(params) {
    return params.length >= 5 &&
           this.validateWorkerName(params[0]) &&
           typeof params[1] === 'string' &&
           this.validateHex(params[2]) &&
           this.validateHex(params[3]) &&
           this.validateHex(params[4]);
  }

  static validateHex(str) {
    return typeof str === 'string' && 
           /^[0-9a-fA-F]+$/.test(str);
  }
}

// Mining Proxy Core
class MiningProxy {
  constructor() {
    this.bufferMap = new Map();
    this.initHealthChecks();
    this.metricsServer = this.initMetrics();
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  initHealthChecks() {
    setInterval(() => {
      POOLS.forEach(pool => {
        const testSocket = net.connect(pool, () => testSocket.end());
        testSocket.on('error', () => {
          logger.warn(`Pool ${pool.host} marked unhealthy`);
          pool.healthy = false;
        });
      });
    }, 30000);
  }

  initMetrics() {
    const app = express();
    app.get('/metrics', (req, res) => {
      res.json({
        connections: this.server.connections,
        pools: POOLS.map(p => ({
          host: p.host,
          healthy: p.healthy,
          connections: p.connections || 0
        }))
      });
    });
    return app.listen(METRICS_PORT);
  }

  handleConnection(minerSocket) {
    const pool = this.getHealthyPool();
    if (!pool) return minerSocket.end('No pools available');

    const poolSocket = net.connect(pool);
    pool.connections = (pool.connections || 0) + 1;

    this.setupPipe(minerSocket, poolSocket);
    this.setupErrorHandling(minerSocket, poolSocket, pool);
  }

  setupPipe(src, dest) {
    src.on('data', data => this.processData(data, src, dest));
    dest.on('data', data => this.processData(data, dest, src));
  }

  processData(data, src, dest) {
    const buffer = this.bufferMap.get(src) || '';
    const messages = (buffer + data.toString()).split('\n');
    
    messages.slice(0, -1).forEach(msg => {
      if (!StratumValidator.isValidMessage(msg)) {
        logger.error(`Invalid message from ${src === dest ? 'pool' : 'miner'}: ${msg}`);
        src.destroy();
        return;
      }
      dest.write(msg + '\n');
    });

    this.bufferMap.set(src, messages[messages.length - 1]);
  }

  setupErrorHandling(miner, pool, poolConfig) {
    const cleanup = () => {
      poolConfig.connections--;
      miner.destroy();
      pool.destroy();
    };

    miner.on('error', cleanup);
    pool.on('error', cleanup);
    miner.on('close', cleanup);
    pool.on('close', cleanup);
  }

  getHealthyPool() {
    return POOLS.find(p => p.healthy) || POOLS[0];
  }

  start() {
    this.server.listen(PROXY_PORT, () => {
      logger.info(`Proxy listening on ${PROXY_PORT}`);
      logger.info(`Metrics available on port ${METRICS_PORT}`);
    });
  }
}

// Start the proxy
new MiningProxy().start();
