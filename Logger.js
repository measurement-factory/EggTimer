const assert = require('assert');
const bunyan = require('bunyan');
const Config = require('./Config.js');

let Logger = null;

Logger = bunyan.createLogger({
    name: 'eggtimer',
    streams: [{
        type: Config.loggerType(),
        path: Config.loggerPath(),
        period: Config.loggerPeriod(),
        count: Config.loggerCount()
      }]
    });
Logger.addStream({name: "eggtimer-out", stream: process.stdout});

function logError(err, context) {
    assert(context);
    let msg = context + ": " + err.message;
    if ('stack' in err)
        msg += " " + err.stack.toString();
    Logger.error(msg);
}

function logApiResult(method, params, result) {
    Logger.info(method, "OK, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}

module.exports = {
    Logger: Logger,
    logError: logError,
    logApiResult: logApiResult
};

