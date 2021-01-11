
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const readline = require('readline');
const { JSONRPCServer, JSONRPCClient, JSONRPCServerAndClient } = require('json-rpc-2.0');

const { Plugin } = require('../plugin.js');
const { bootstrap } = require('./plugin_node_safe/proxyOmegga.js');


// TODO: check if version is compatible (v1 -> v2) from file
// TODO: write jsonrpc wrappers in a few languages, implement a few simple plugins
// TODO: languages: [ python, rust, go ]

const MAIN_FILE = 'omegga_plugin';
const DOC_FILE = 'doc.json';

class RpcPlugin extends Plugin {
  #child = null;
  #rpc = null;
  #errInterface = null;
  #outInterface = null;

  // all RPC plugins require a main (binary) file and a doc file
  static canLoad(pluginPath) {
    return fs.existsSync(path.join(pluginPath, MAIN_FILE)) &&
      fs.existsSync(path.join(pluginPath, DOC_FILE));
  }

  // websocket rpc plugin type
  static getFormat() { return 'jsonrpc_stdio'; }

  // documentation is based on doc.json file
  getDocumentation() { return this.documentation; }

  constructor(pluginPath, omegga) {
    super(pluginPath, omegga);

    this.messageCounter = 0;

    // TODO: validate documentation
    this.documentation = Plugin.readJSON(path.join(pluginPath, DOC_FILE));
    this.pluginFile = path.join(pluginPath, MAIN_FILE);

    this.eventPassthrough = this.eventPassthrough.bind(this);
    this.commands = [];

    this.initRPC();
  }

  isLoaded() { return !!this.#child && !this.#child.exitCode; }

  // determing if a command is registered
  isCommand(cmd) {
    return this.commands.includes(cmd);
  }

  // spawn the plugin as a child process
  load() {
    let frozen = true, timed = false;
    const name = this.getName();
    this.commands = [];

    // can't load the plugin if the child is still running
    if (typeof this.#child !== 'undefined')
      return false;

    return Promise.race([
      (async() => {
        try {
          const config = await this.storage.getConfig();
          this.#child = spawn(this.pluginFile);
          this.#child.stdin.setEncoding('utf8');
          this.#outInterface = readline.createInterface({input: this.#child.stdout, terminal: false});
          this.#errInterface = readline.createInterface({input: this.#child.stderr, terminal: false});
          this.attachListeners();

          // get some initial information to create an omegga proxy
          const initialData = bootstrap(this.omegga);

          // send all of the mock events to the proxy omegga
          for (const ev in initialData) {
            // send some initial information
            this.notify(ev, initialData[ev]);
          }

          // pass events through
          this.omegga.on('*', this.eventPassthrough);

          try {
            // tell the plugin to start
            const result = await this.emit('init', config);

            // plugins can return a result object
            if (typeof result === 'object' && result) {

              // if registeredCommands is in the results, register the provided strings as commands
              const cmds = result.registeredCommands;
              if (cmds && (cmds instanceof Array) && cmds.every(i => typeof i === 'string'))
                this.commands = cmds;
            }
          } catch (e) {
            if (!e.message) return;
            Omegga.error('!>'.red, 'rpc plugin', name.brightRed.underline, 'missing start impl');
          }

          // plugin is not frozen, resolve that it has loaded
          frozen = false;
          if (timed) return;
          this.emitStatus();
          return true;
        } catch(e) {
          if (timed) return;
          Omegga.error('!>'.red, 'error loading stdio rpc plugin', this.getName().brightRed.underline, e);
          await this.kill();
          frozen = false;
          this.emitStatus();
          return false;
        }
      })(),
      new Promise(resolve => {
        // let user know if the child quit while launching
        this.#child.once('exit', () => {
          if (!frozen || timed) return;
          frozen = false;
          this.emitStatus();
          resolve(false);
        });

        // check if the child is frozen (while true)
        setTimeout(() => {
          if (!frozen) return;
          Omegga.error('!>'.red, 'I appear to be unresponsive when starting (maybe I forgot to respond to start)', name.brightRed.underline);
          this.kill();
          timed = true;
          this.emitStatus();
          resolve(false);
        }, 5000);
      })
    ]);
  }

  // kill the child process after requesting it to stop
  unload() {
    if (!this.#child || this.#child.exitCode) {
      this.detachListeners();
      this.emitStatus();
      return Promise.resolve(true);
    }
    let frozen = true, timed = false;
    const name = this.getName();

    return Promise.race([
      (async() => {
        try {

          // let the plugin know it's time to stop, if this error it's probably because the method was not implemented
          try { await this.emit('stop'); } catch (e) {
            // lazy developer - just implement stop please
          }

          await this.kill();

          frozen = false;
          if (timed) return;
          this.emitStatus();
          this.commands = [];
          return true;
        } catch (e) {
          if (timed) return;
          Omegga.error('!>'.red, 'error unloading rpc plugin', name.brightRed.underline, e);
          frozen = false;
          this.emitStatus();
          return false;
        }
      })(),
      // this is wrapped in a promise for the freeze check
      new Promise(resolve => {
        // check if the child is frozen (while true)
        setTimeout(() => {
          if (!frozen) return;
          Omegga.error('!>'.red, 'I appear to be unresponsive when stopping (maybe I forgot to respond to stop)', name.brightRed.underline);
          this.kill();
          timed = true;
          this.emitStatus();
          resolve(true);
        }, 5000);
      }),
    ]);
  }

  // attaches event listeners
  attachListeners() {
    const name = this.getName();

    this.#outInterface.on('line', line => {
      try {
        this.#rpc.receiveAndSend(JSON.parse(line));
      } catch (e) {
        Omegga.error(this.getName().brightRed.underline, '!>'.red, 'error parsing rpc data', e, line);
      }
    });

    // stderr - print out the errors
    this.#errInterface.on('line', err => {
      Omegga.error(name.brightRed.underline, '!>'.red, err);
    });

    this.#child.on('error', () => this.kill());
    this.#child.on('close', () => this.kill());
    this.#child.on('exit', code => {
      Omegga.error('!>'.red, 'rpc plugin', name.brightRed.underline, 'exited with code', code);
      this.kill();
    });
  }

  // removes previously attached event listeners
  detachListeners() {
    this.#outInterface.removeAllListeners('line');
    this.#errInterface.removeAllListeners('line');
    if (this.#child) {
      this.#child.removeAllListeners('exit');
      this.#child.removeAllListeners('close');
      this.#child.removeAllListeners('error');
    }
  }

  // write a string to the child process
  writeln(line) {
    try {
      if (this.#child && !this.#child.exitCode)
        this.#child.stdin.write(line + '\n');
    } catch (e) {
      // the child probably died... oops!
    }
  }

  // forcibly kills the plugin
  async kill() {
    this.#rpc.rejectAllPendingRequests();
    this.detachListeners();
    this.omegga.off('*', this.eventPassthrough);
    if (!this.#child)
      return;

    // create a promise for the exit of the process
    const promise = new Promise(resolve => this.#child.once('exit', resolve));

    // kill the process
    this.#child.kill('SIGINT');

    // ...kill it again just to make sure it's dead
    spawn('kill', ['-9', this.#child.pid]);

    // wait for the process to exit
    await promise;
    this.#child = undefined;
    this.emitStatus();
  }

  eventPassthrough(type, ...args) {
    if (!this.#child) return;
    this.notify(type, args);
  }

  // setup the JSONRPC communication
  initRPC() {
    const server = new JSONRPCServer();
    const client = new JSONRPCClient(req => {
      try {
        this.writeln(JSON.stringify(req));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error);
      }
    });
    const rpc = this.#rpc = new JSONRPCServerAndClient(server, client);

    // plugin log generator function
    const ezLog = (logFn, name, symbol) => line => console[logFn](name.underline, symbol, line);

    const name = this.getName();

    // server can output logs special formatting for stdout
    rpc.addMethod('log', ezLog('log', name, '>>'.green));
    rpc.addMethod('error', ezLog('error', name.brightRed, '!>'.red));
    rpc.addMethod('info', ezLog('info', name, '#>'.blue));
    rpc.addMethod('warn', ezLog('warn', name.brightYellow, ':>'.yellow));
    rpc.addMethod('trace', ezLog('trace', name, 'T>'.grey));

    // plugin store interactions
    rpc.addMethod('store.get', (key) => this.storage.get(key));
    rpc.addMethod('store.set', ([key, value]) => this.storage.set(key, value));
    rpc.addMethod('store.delete', (key) => this.storage.delete(key));
    rpc.addMethod('store.wipe', () => this.storage.wipe());
    rpc.addMethod('store.count', () => this.storage.count());
    rpc.addMethod('store.keys', () => this.storage.keys());

    rpc.addMethod('store.keys', () => this.storage.keys());

    // server can run console commands
    rpc.addMethod('exec', line => this.omegga.writeln(line));
    rpc.addMethod('writeln', line => this.omegga.writeln(line));
    rpc.addMethod('broadcast', line => this.omegga.broadcast(line));
    rpc.addMethod('whisper', ({target, line}) => this.omegga.whisper(target, line));
    rpc.addMethod('getPlayers', () => this.omegga.getPlayers());
    rpc.addMethod('getRoleSetup', () => this.omegga.getRoleSetup());
    rpc.addMethod('getBanList', () => this.omegga.getBanList());
    rpc.addMethod('getSaves', () => this.omegga.getBanList());
    rpc.addMethod('getSavePath', (name) => this.omegga.getSavePath(name));
    rpc.addMethod('clearBricks', ({target, quiet=false}) => this.omegga.clearBricks(target, quiet));
    rpc.addMethod('clearAllBricks', (quiet=false) => this.omegga.clearAllBricks(quiet));
    rpc.addMethod('saveBricks', (name) => this.omegga.saveBricks(name));
    rpc.addMethod('loadBricks', ({name, offX=0, offY=0, offZ=0, quiet=false}) =>
      this.omegga.loadBricks(name, {offX, offY, offZ, quiet}));
    rpc.addMethod('readSaveData', (name) => this.omegga.readSaveData(name));
    rpc.addMethod('getSaveData', () => this.omegga.getSaveData());
    rpc.addMethod('loadSaveData', ({data, offX=0, offY=0, offZ=0, quiet=false}) =>
      this.omegga.loadSaveData(data, {offX, offY, offZ, quiet}));
    rpc.addMethod('changeMap', (name) =>
      this.omegga.changeMap(name));
  }

  // emit a message to the plugin via the jsonrpc client and expect a response
  emit(type, arg) {
    return this.#rpc.request(type, arg);
  }

  // emit a message to the plugin via the jsonrpc client, don't expect a response
  notify(type, arg) {
    try {
      this.#rpc.notify(type, arg);
    } catch (e) {
      // this only happens if the RPC library is hitting some issues - probably redundant
    }
  }
}

module.exports = RpcPlugin;