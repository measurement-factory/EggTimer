const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const PrMerger = require('./PrMerger.js');
const Util = require('./Util.js');

const Logger = Log.Logger;

class RepoMerger {

    constructor() {
        this._timer = null;
        this._fireDate = null;
        this._rerun = false;
        this.running = false;
        this._server = null;
    }

    // prNum (if provided) corresponds to a PR, scheduled this 'run'
    async run(server) {
        if (server) {
            this._server = server;
            Log.Logger.info("Listening on " + Config.port() + " ...");
        }

        if (this.running) {
            Logger.info("Already running, planning rerun.");
            this._rerun = true;
            return;
        }

        this.running = true;
        do {
            let step = null;
            try {
                this._rerun = false;
                this.unplan();
                step = new PrMerger();
                await step.runStep();
                if (!this._rerun && step.rerunIn !== null)
                    this.plan(step.rerunIn);
            } catch (e) {
                Log.logError(e, "RepoMerger.run");
                this._rerun = true;

                Logger.info("closing HTTP server");
                this._server.close(this.onServerClosed.bind(this));

                const period = 10; // 10 min
                Logger.info("next re-try in " + period + " minutes.");
                await Util.sleep(period * 60 * 1000); // 10 min
            } finally {
                if (step)
                    step.logStatistics();
            }
        } while (this._rerun);
        this.running = false;
    }

    onServerClosed() {
        Logger.info("re-starting HTTP server...");
        Util.StartServer(this._server, this.onServerRestarted.bind(this));
    }

    onServerRestarted() {
        Log.Logger.info("restarted and listening on " + Config.port() + " ...");
    }

    plan(ms) {
        assert(!this.planned());
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

    unplan() {
        if (this.planned()) {
            clearTimeout(this._timer);
            this._timer = null;
        }
    }

    planned() { return this._timer !== null; }

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

