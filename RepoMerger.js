const assert = require('assert');
const Log = require('./Logger.js');
const MergeStep = require('./PrMerger.js');
const Util = require('./Util.js');

const Logger = Log.Logger;

class RepoMerger {

    constructor() {
        this._timer = null;
        this._fireDate = null;
        this.rerun = false;
        this.running = false;
    }

    // prNum (if provided) corresponds to a PR, scheduled this 'run'
    async run() {
        if (this.running) {
            Logger.info("Already running, planning rerun.");
            this.rerun = true;
            return;
        }

        Logger.info("running...");
        this.running = true;
        do {
            let step = null;
            try {
                this.rerun = false;
                step = new MergeStep();
                await step.runStep();
            } catch (e) {
                Log.logError(e, "RepoMerger.run");
                this.rerun = true;
                const period = 10; // 10 min
                Logger.info("next re-try in " + period + " minutes.");
                await Util.sleep(period * 60 * 1000); // 10 min
            } finally {
                if (step)
                    step.logStatistics();
            }
        } while (this.rerun);
        this.running = false;
    }

    plan(ms, prNum) {
        assert(ms >= 0);
        let date = new Date();
        if (this._fireDate < date) // do cleanup (the timer already fired)
            this._fireDate = null;
        date.setSeconds(date.getSeconds() + ms/1000);
        if (this._fireDate && date >= this._fireDate)
            return;
        if (!this._timer === null)
            clearTimeout(this._timer);
        this._fireDate = date;
        this._timer = setTimeout(this.run.bind(this), ms);
        Logger.info("planning rerun for PR" + prNum + " in " + this._msToTime(ms));
    }

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

module.exports = RepoMerger;

