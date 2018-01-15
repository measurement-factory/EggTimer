const assert = require('assert');
const http = require('http');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Util = require('./Util.js');
const PrMerger = require('./PrMerger.js');

const Logger = Log.Logger;

class RepoMerger {

    constructor() {
        this._timer = null;
        this._fireDate = null;
        this._rerun = false;
        this._running = false;
        this._handler = null;
        this._server = null;
    }

    _createServer() {
        assert(!this._server);

        this._server = http.createServer((req, res) => {
            assert(this._handler);
            this._handler(req, res, () => {
                res.statusCode = 404;
                res.end('no such location');
            });
        });

        this._server.on('error', (e) => {
                Logger.error("HTTP server error: " + e.code);
            }
        );

        return new Promise((resolve) => {
            const params = {port: Config.port()};
            if (Config.host())
                params.host = Config.host();
            this._server.listen(params, () => {
                Log.Logger.info("HTTP server started and listening on " + Config.port() + " ...");
                resolve(true);
            });
        });
    }

    // prNum (if provided) corresponds to a PR, scheduled this 'run'
    async run(handler) {
        if (handler)
            this._handler = handler;

        if (this._running) {
            Logger.info("Already running, planning rerun.");
            this._rerun = true;
            return;
        }
        this._running = true;

        do {
            let step = null;
            try {
                this._rerun = false;
                this._unplan();
                if (!this._server)
                    await this._createServer();
                step = new PrMerger();
                await step.runStep();
                if (!this._rerun && step.rerunIn !== null)
                    this._plan(step.rerunIn);
            } catch (e) {
                Log.logError(e, "RepoMerger.run");
                this._rerun = true;

                Logger.info("closing HTTP server");
                this._server.close(this._onServerClosed.bind(this));

                const period = 10; // 10 min
                Logger.info("next re-try in " + period + " minutes.");
                await Util.sleep(period * 60 * 1000); // 10 min
            } finally {
                if (step)
                    step.logStatistics();
            }
        } while (this._rerun);
        this._running = false;
    }

    _onServerClosed() {
        Logger.info("HTTP server closed.");
        this._server = null;
    }

    _plan(ms) {
        assert(!this._planned());
        assert(ms >= 0);
        if (ms === 0) {
            this._rerun = true;
            return;
        }
        let date = new Date();
        date.setSeconds(date.getSeconds() + ms/1000);
        this._timer = setTimeout(this.run.bind(this), ms);
        Logger.info("planning rerun in " + this._msToTime(ms));
    }

    _unplan() {
        if (this._planned()) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    _planned() { return this._timer !== null; }

    // duration in ms
    _msToTime(duration) {
        let seconds = parseInt((duration/1000)%60);
        let minutes = parseInt((duration/(1000*60))%60);
        let hours = parseInt((duration/(1000*60*60))%24);
        let days = parseInt((duration/(1000*60*60*24)));

        days = (days < 10) ? "0" + days : days;
        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        return days + "d " + hours + "h " + minutes + "m " + seconds + "s";
    }
}

const Merger = new RepoMerger();

module.exports = Merger;

