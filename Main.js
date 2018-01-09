const http = require('http');
const createHandler = require('github-webhook-handler');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const RepoMerger = require('./RepoMerger.js');

const Logger = Log.Logger;

const WebhookHandler = createHandler({ path: Config.githubWebhookPath(), secret: Config.githubWebhookSecret() });

const server = http.createServer((req, res) => {
    WebhookHandler(req, res, () => {
        res.statusCode = 404;
        res.end('no such location');
    });
});

if (Config.host())
    server.listen({port: Config.port(), host: Config.host()});
else
    server.listen({port: Config.port()});


const Merger = new RepoMerger();

Merger.run();


// events

WebhookHandler.on('error', (err) => {
   Logger.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    Merger.run();
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    Merger.run();
});

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', (ev) => {
    const e = ev.payload;
    Logger.info("status event:", e.id, e.sha, e.context, e.state);
    Merger.run();
});

// https://developer.github.com/v3/activity/events/types/#pushevent
WebhookHandler.on('push', (ev) => {
    const e = ev.payload;
    Logger.info("push event:", e.ref);
    Merger.run();
});

module.exports = Merger;

