const fs = require('fs');
const http = require('http');
const createHandler = require('github-webhook-handler');
const nodeGithub = require('github');
const assert = require('assert');
const endOfLine = require('os').EOL;
const bunyan = require('bunyan');

// FF merge failed
const MergeFailedLabel = "S-merge-failed";
// Some of required auto checks failed
const AutoChecksFailedLabel = "S-autochecks-failed";
// FF merge succeeded
const MergedLabel = "S-merged";
// Merge started (tag and auto branch successfully adjusted)
const MergingLabel = "S-merging";
// Merge succeeded up to FF step. For testing purpose.
const MergeReadyLabel = "S-merge-ready";

const MergingTag = "T-merging-PR";
const TagRegex = /(refs\/tags\/.*-PR)(\d+)$/;
const MsPerDay = 86400 * 1000;

class ConfigOptions {
    constructor(fname) {
        const conf = JSON.parse(fs.readFileSync(fname));
        this._githubUser = conf.github_username;
        this._githubToken = conf.github_token;
        this._githubWebhookPath = conf.github_webhook_path;
        this._githubWebhookSecret = conf.github_webhook_secret;
        this._repo = conf.repo;
        this._port = conf.port;
        this._owner = conf.owner;
        this._autoBranch = conf.auto_branch;
        this._dryRun = conf.dry_run;
        this._skipMerge = conf.skip_merge;
        this._approvalsNumber = conf.approvals_number;
        assert(this._approvalsNumber > 1);
        this._approvalPeriod = conf.approval_period; // in days
        this._rejectPeriod = conf.reject_period; // in days

        const allOptions = Object.values(this);
        for (let v of allOptions) {
            assert(v !== undefined );
        }
    }

    githubUser() { return this._githubUser; }
    githubToken() { return this._githubToken; }
    githubWebhookPath() { return this._githubWebhookPath; }
    githubWebhookSecret() { return this._githubWebhookSecret; }
    repo() { return this._repo; }
    port() { return this._port; }
    owner() { return this._owner; }
    autoBranch() { return this._autoBranch; }
    dryRun() { return this._dryRun; }
    skipMerge() { return this._skipMerge; }
    approvalsNumber() { return this._approvalsNumber; }
    approvalPeriod() { return this._approvalPeriod; }
    rejectPeriod() { return this._rejectPeriod; }
}

const Config = new ConfigOptions('config.js');
const WebhookHandler = createHandler({ path: Config.githubWebhookPath(), secret: Config.githubWebhookSecret() });
const Github = new nodeGithub({ version: "3.0.0" });
const GithubAuthentication = { type: 'token', username: Config.githubUser(), token: Config.githubToken() };
let Logger;

class RunScheduler {

    constructor() {
        this._prTimeouts = {};
        this.rerun = false;
        this.running = false;
    }

    async startup() {

        Logger = bunyan.createLogger({
        name: 'eggtimer',
        streams: [{
            type: 'rotating-file',
            path: './eggtimer.log',
            period: '1d', // daily rotation
            count: 3 // keep 3 back copies
          }]
        });
        Logger.addStream({name: "eggtimer-out", stream: process.stdout});

        http.createServer((req, res) => {
            WebhookHandler(req, res, () => {
                res.statusCode = 404;
                res.end('no such location');
            });
        }).listen(Config.port());
        Logger.info("startup");
        this.run();
    }

    // prNum (if provided) corresponds to a PR, scheduled this 'run'
    async run(prNum) {
        Logger.info("running...");

        if (prNum !== undefined)
            this._unplan(prNum);

        if (this.running) {
            this.rerun = true;
            return;
        }

        this.running = true;
        do {
            let step = null;
            try {
                this.rerun = false;
                step = new MergeStep();
                await step.run();
            } catch (e) {
                Logger.error(e.stack);
                if (step)
                    step.logStatistics();
                this.rerun = true;
                const period = 10; // 10 min
                Logger.info("next re-try in " + period + " minutes.");
                await sleep(period * 60 * 1000); // 10 min
            }
        } while (this.rerun);
        this.running = false;
    }

    plan(ms, prNum) {
        assert(ms >= 0);
        assert(prNum > 0);
        this._unplan(prNum);
        Logger.info("planning rerun for PR" + prNum + " in " + this._msToTime(ms));
        this._prTimeouts[prNum] = setTimeout(this.run.bind(this), ms, prNum);
    }

    _planned(prNum) {
        return Object.keys(this._prTimeouts).find((num) => { return prNum === num; }) !== undefined;
    }

    _unplan(prNum) {
        if (!this._planned(prNum))
            return;
        Logger.info("unplanning rerun for PR" + prNum);
        // does nothing if timed out already
        clearTimeout(this._prTimeouts[prNum]);
        delete this._prTimeouts[prNum];
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

const Scheduler = new RunScheduler();

// Processing a single PR
class MergeContext {

    constructor(pr, aSha, tSha) {
        // Whether the PR is in-process (auto checks are running)
        // or not (skipped due to failed checks or successfully merged).
        this.inMerge = null;
        // true when FF merge master into auto_branch fails
        this.mergeFailed = false;

        this._pr = pr;
        this._autoSha = (aSha === undefined) ? null : aSha;
        this._tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
    }

    // Advances the PR towards merge.
    async process() {
        try {
            assert(this.tagsConsistent());
            this.inMerge = false;

            if (!this._autoSha)
                await this._loadTag();

            let checkTagResult = null;
            if (this._tagSha)
                checkTagResult = await this._checkTag();

            if (!checkTagResult || checkTagResult === 'start') {
                if (!(await this._checkMergePreconditions())) {
                    return true;
                }
                if (Config.dryRun()) {
                    this._log("skip start merging due to dry_run option");
                    return true;
                }
                await this._startMerging();
                await this._labelMerging();
                // merging started successfully
                this.inMerge = true;
                return true;
            }

            assert(checkTagResult);

            if (checkTagResult === 'continue') {
                if (Config.dryRun()) {
                    this._log("skip finish merging due to dry_run option");
                    return true;
                }

                await this._labelMergeReady();

                if (Config.skipMerge()) {
                    this._log("skip finish merging due to skip_merge option");
                    return true;
                }

                await this._finishMerging();
                await this._cleanupMerged();
                // merging finished successfully
                return true;
            } else if (checkTagResult === 'wait') {
                // still waiting for auto checks
                this.inMerge = true;
                return true;
            } else {
                // skip this PR
                assert(checkTagResult === 'skip');
                return true;
            }
        } catch (err) {
            this._logError(err, "MergeContext.process");
            await this._cleanupUnexpectedError();
            return false;
        }
    }

    // Checks whether the current PR has merge tag.
    async _loadTag() {
       try {
           this._tagSha = await getReference(this.mergingTag());
           return true;
       } catch (e) {
           if (e.notFound()) {
               this._log(this.mergingTag() + " not found");
               return false;
           }
           throw e;
       }
    }

    // Checks whether the current PR has 'merge tag' (i.e., merge in progress).
    // Returns one of:
    // 'start': the tag does not exist or is stale; should start merging from scratch.
    // 'wait': the tag tests are in progress; should wait for their completion.
    // 'continue': the tag tests completed with success; should finish merging.
    // 'skip': the tag tests failed, the tag is no stale; do not process this PR.
    async _checkTag() {
        assert(this._tagSha);

        const contexts = await getProtectedBranchRequiredStatusChecks(this.prBaseBranch());

        const commitStatus = await getStatuses(this._tagSha, contexts);

        if (commitStatus === 'pending') {
            this._log("waiting for more auto_branch statuses completing");
            if (!Config.dryRun())
                this._autoSha = await updateReference(Config.autoBranch(), this._tagSha, true);
            return 'wait';
        } else if ( commitStatus === 'success') {
            this._log("auto_branch checks succeeded");
            this._autoSha = await updateReference(Config.autoBranch(), this._tagSha, true);
            return 'continue';
        } else {
            assert(commitStatus === 'error');
            const tagCommit = await getCommit(this._tagSha);
            const tagPr = await getPR(this.number(), true); // to force Github refresh the PR's 'merge' commit
            assert(tagPr.number === this.number());
            const prMergeSha = await getReference(this.mergePath());
            const prCommit = await getCommit(prMergeSha);

            let ret = 'skip';
            if (tagCommit.treeSha !== prCommit.treeSha) {
                this._log("merge commit has changed since last failed attempt");
                if (!Config.dryRun())
                    await deleteReference(this.mergingTag());
                ret = 'start';
            } else {
                let msg = "merge commit has not changed since last failed attempt";
                // the base branch could be changed but resulting with new conflicts,
                // merge commit is not updated then
                if (tagPr.mergeable !== true)
                    msg += " due to conflicts with " + tagPr.base.ref;
                this._log(msg);
                if (!Config.dryRun())
                    await this._labelAutoFailed();
                ret = 'skip';
            }
            return ret;
        }
    }

    // Checks whether the PR is ready for merge (all PR lamps are 'green').
    // Also forbids merging the already merged PR (marked with label) or
    // if was interrupted by an event ('Scheduler.rerun' is true).
    async _checkMergePreconditions() {
        this._log("checking merge preconditions...");

        const pr = await getPR(this.number(), true);
        this._refresh(pr);

        if (!this.prMergeable()) {
            this._log("not mergeable yet.");
            return false;
        }

        const collaborators = await getCollaborators();
        const pushCollaborators = collaborators.filter((c) => { return c.permissions.push === true; });
        // in ms
        const timeToWait = await getReviews(this.number(), pushCollaborators, this.prAuthor());
        if (timeToWait === null) // not approved or rejected
            return false;
        else if (timeToWait !== 0) { // approved, but waiting
            Scheduler.plan(timeToWait, this.number());
            return false;
        }

        const contexts = await getProtectedBranchRequiredStatusChecks(this.prBaseBranch());

        const statusOk = await getStatuses(this.prHeadSha(), contexts);
        if (!statusOk) {
            this._log("statuses not succeeded.");
            return false;
        }

        if (await this.hasLabel(MergedLabel, this.number())) {
            this._log("already merged");
            return false;
        }

        if (Scheduler.rerun) {
            this._log("rerun");
            return false;
        }

        return true;
    }

    // Creates a 'merge commit' and adjusts auto_branch.
    async _startMerging() {
        this._log("start merging...");
        const baseSha = await getReference(this.prBaseBranchPath());
        const mergeSha = await getReference("pull/" + this.number() + "/merge");
        const mergeCommit = await getCommit(mergeSha);
        const tempCommitSha = await createCommit(mergeCommit.treeSha, this.prMessage(), [baseSha]);
        this._tagSha = await createReference(tempCommitSha, "refs/" + this.mergingTag());
        this._autoSha = await updateReference(Config.autoBranch(), this._tagSha, true);
    }

    // Does 'ff' merge base into auto_branch.
    async _finishMerging() {
        assert(this._autoSha);
        this._log("finish merging...");
        // ensure we do ff merge
        try {
            await updateReference(this.prBaseBranchPath(), this._autoSha, false);
        } catch (e) {
            if (e.unprocessable()) {
                this._log("FF merge failed");
                this.mergeFailed = true;
            }
            throw e;
        }
    }

    // adjusts the successfully merged PR (labels, status, tag)
    async _cleanupMerged() {
        this._log("cleanup...");
        await this._labelMerged();
        await updatePR(this.number(), 'closed');
        await deleteReference(this.mergingTag());
        const baseSha = await getReference(this.prBaseBranchPath());
        await updateReference(Config.autoBranch(), baseSha, true);
    }

    // does not throw
    async _cleanupUnexpectedError() {
        if (this === null)
            return;
        this._log("cleanup on unexpected error...");
        // delete merging tag, if exists
        try {
            await deleteReference(this.mergingTag());
        } catch (e) {
            // For the record: Github returns 422 error if there is no such
            // reference 'refs/:sha', and 404 if there is no such tag 'tags/:tag'.
            if (e.notFound())
                this._log(this.mergingTag() + "tag not found");
            else
                this._logError(e, "cleanupUnexpectedError");
        }

        try {
            await this._labelMergeFailed();
        } catch (e) {
            this._logError(e, "cleanupUnexpectedError");
        }
    }

    _refresh(pr) {
        assert(pr.number === this._pr.number);
        this._pr = pr;
    }

    // Label manipulation methods

    async hasLabel(label) {
        const labels = await getLabels(this.number());
        return ((labels.find((lbl) => { return (lbl.name === label); })) !== undefined);
    }

    async removeLabel(label) {
        try {
            await removeLabel(label, this.number());
        } catch (e) {
            if (e.notFound()) {
                this._log("removeLabel: " + label + " not found");
                return;
            }
            throw e;
        }
    }

    async addLabel(label) {
        let params = commonParams();
        params.number = this.number();
        params.labels = [];
        params.labels.push(label);
        try {
            await addLabels(params);
        } catch (e) {
            // TODO: also extract and check for "already_exists" code:
            // { "message": "Validation Failed", "errors": [ { "resource": "Label", "code": "already_exists", "field": "name" } ] }
            if (e.unprocessable()) {
                Logger.info("addLabel: " + label + " already exists");
                return;
            }
            throw e;
        }
    }

    async _labelMerging() {
        await this.removeLabel(MergeReadyLabel);
        await this.removeLabel(MergeFailedLabel);
        await this.removeLabel(AutoChecksFailedLabel);
        await this.addLabel(MergingLabel);
    }

    async _labelMerged() {
        await this.removeLabel(MergingLabel);
        await this.removeLabel(MergeReadyLabel);
        await this.removeLabel(MergeFailedLabel);
        await this.removeLabel(AutoChecksFailedLabel);
        await this.addLabel(MergedLabel);
    }

    async _labelMergeFailed() {
        await this.removeLabel(MergingLabel);
        await this.removeLabel(MergeReadyLabel);
        await this.addLabel(MergeFailedLabel);
    }

    async _labelAutoFailed() {
        await this.removeLabel(MergingLabel);
        await this.addLabel(AutoChecksFailedLabel);
    }

    async _labelMergeReady() {
        await this.removeLabel(MergingLabel);
        await this.removeLabel(AutoChecksFailedLabel);
        await this.addLabel(MergeReadyLabel);
    }

    // Getters

    number() { return this._pr.number; }

    prHeadSha() { return this._pr.head.sha; }

    prMessage() {
        return this._pr.title + endOfLine + this._pr.body + endOfLine +
            "(PR #" + this._pr.number + ")";
    }

    prAuthor() { return this._pr.user.login; }

    prMergeable() { return this._pr.mergeable; }

    prBaseBranch() { return this._pr.base.ref; }

    prBaseBranchPath() { return "heads/" + this.prBaseBranch(); }

    prOpen() { return this._pr.state === 'open'; }

    mergingTag() { return "tags/" + MergingTag + this._pr.number; }

    tagsConsistent() {
        if (this._autoSha !== null)
            return this._autoSha === this._tagSha;
        return true;
    }

    mergePath() { return "pull/" + this._pr.number + "/merge"; }

    _log(msg) {
        Logger.info("PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit) + "):", msg);
    }

    _logError(err, details) {
        let msg = this.toString() + " ";
        if (details !== undefined)
            msg += details + ": ";
        msg += err.toString();
        if ('stack' in err)
            msg += " " + err.stack.toString();
        Logger.error(msg);
    }

    toString() {
        let str = "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
        if (this._autoSha !== null)
            str += ", auto: " + this._autoSha.substr(0, this._shaLimit);
        if (this._tagSha !== null)
            str += ", tag: " + this._tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
} // MergeContext


// Gets PR list from Github and processes some/all PRs from this list.
class MergeStep {

    constructor() {
        this.prList = [];
        this.total = 0;
        this.errors = 0;
    }

    // Gets PR list from Github and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async run() {
        Logger.info("running merge step...");
        this.prList = await getPRList();
        let mergeContext = await this._current();
        if (!mergeContext)
            mergeContext = await this._next();
        while (mergeContext) {
            this.total++;
            if (!(await mergeContext.process()))
                this.errors++;
            if (mergeContext.inMerge)
                break;
            // Should re-run when ff merge failed(e.g., base changed)
            // and this is the last PR in the list.
            if (mergeContext.mergeFailed && !this.prList.length)
                Scheduler.rerun = true;
            mergeContext = await this._next();
        }
    }

    async _next() {
        if (!this.prList.length)
            return null;
        return new MergeContext(this.prList.shift());
    }

    // Loads 'being-in-merge' PR, if exists (PR with tag corresponding to auto_branch').
    async _current() {
        if (!this.prList.length)
            return null;
        const autoSha = await getReference(Config.autoBranch());
        let tags = null;
        try {
           tags = await getTags();
        } catch (e) {
            if (e.notFound()) {
                Logger.info("No tags found");
                return null;
            }
            throw e;
        }

        let prNum = null;
        tags.find( (tag) => {
            if (tag.object.sha === autoSha) {
                const matched = tag.ref.match(TagRegex);
                if (matched)
                    prNum = matched[2];
            }
        });

        if (prNum === null) {
            Logger.info("No merging PR found.");
            return null;
        }

        let autoPr = null;
        try {
            autoPr = await getPR(prNum, false);
        } catch (e) {
            if (e.notFound()) {
                Logger.info("PR" + prNum + " not found");
                return null;
            }
            throw e;
        }
        let context = new MergeContext(autoPr, autoSha, autoSha);
        const prevLen = this.prList.length;
        // remove the loaded PR from the global list
        this.prList = this.prList.filter((pr) => { return pr.number !== context.number(); });
        assert(prevLen - 1 === this.prList.length);
        return context;
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }

} // MergeStep

// events

WebhookHandler.on('error', (err) => {
   Logger.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    Scheduler.run();
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (ev) => {
    const pr = ev.payload.pull_request;
    Logger.info("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    Scheduler.run();
});

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', (ev) => {
    const e = ev.payload;
    Logger.info("status event:", e.id, e.sha, e.context, e.state);
    Scheduler.run();
});


Scheduler.startup();


// Promisificated node-github wrappers

// An error context for promisificated wrappers.
class ErrorContext {
    constructor(err, method, args) {
        // The underlying rejection may be a bot-specific Promise.reject() or
        // be caused by a Github API error, so 'err' contains either
        // an error string or the entire API error object.
        this._err = err;
        this._method = (method === undefined) ? null : method;
        this._args = (args === undefined) ? null : args;
    }

    // 404 (Not found)
    notFound() {
        if ('code' in this._err)
            return this._err.code === 404;
        // We treat our local(non-API) promise rejections as
        // if the requested resource was 'not found'.
        // TODO: rework if this simple approach does not work.
        return true;
    }

    // 422 (unprocessable entity).
    // E.g., FF merge failure returns this error.
    unprocessable() {
        if ('code' in this._err)
            return this._err.code === 422;
        return false;
    }

    toString() {
        let msg = "";
        if (this._method !== null)
            msg = this._method;
        if (msg.length)
            msg += ", ";
        msg += "Error: " + JSON.stringify(this._err);
        if (this._args !== null)
            msg += ", params: " + JSON.stringify(this._args);
        return msg;
    }
}

// helper methods
function sleep(msec) {
    return new Promise((resolve) => setTimeout(resolve, msec));
}

function logApiResult(method, params, result) {
    Logger.info(method, "OK, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}

// common parameters for all API calls
function commonParams() {
    return {
        owner: Config.owner(),
        repo: Config.repo()
    };
}

function getPRList() {
    const params = commonParams();
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getAll(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getPRList.name, params));
                return;
            }
            const result = res.data.length;
            logApiResult(getPRList.name, params, result);
            resolve(res.data);
        });
    });
}

function getLabels(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.issues.getIssueLabels(params, (err, res) => {
           if (err) {
               reject(new ErrorContext(err, getLabels.name, params));
               return;
           }
           const result = {labels: res.data.length};
           logApiResult(getLabels.name, params, result);
           resolve(res.data);
        });
    });
}

async function getPR(prNum, awaitMergeable) {
    const max = 64 * 1000 + 1; // ~2 min. overall
    for (let d = 1000; d < max; d *= 2) {
        const pr = await requestPR(prNum);
        if (!awaitMergeable || pr.mergeable !== null)
            return pr;
        Logger.info("PR" + prNum + ": Github still caluclates mergeable status. Will retry in " + (d/1000) + " seconds");
        await sleep(d);
    }
    return Promise.reject(new ErrorContext("Github could not calculate mergeable status",
                getPR.name, {pr: prNum}));
}

function requestPR(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.get(params, (err, pr) => {
            if (err) {
                reject(new ErrorContext(err, requestPR.name, params));
                return;
            }
            if (pr.data.state !== 'open') {
                reject(new ErrorContext("PR was unexpectedly closed", requestPR.name, {pr: prNum}));
                return;
            }
            const result = {mergeable: pr.data.mergeable};
            logApiResult(requestPR.name, params, result);
            resolve(pr.data);
       });
   });
}

// If approved, returns number for milliseconds to wait (>=0),
// zero means no waiting required.
// If not approved (or rejected), returns null.
function getReviews(prNum, pushCollaborators, prAuthor) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getReviews(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReviews.name, params));
                return;
            }

            let approvals = {};
            let approveDate = null;
            for (let review of res.data) {
                // Reviews are returned in chronological order
                const reviewState = review.state.toLowerCase();
                if (reviewState === "approved") {
                    approvals[review.user.login] = true;
                    if (approveDate === null) {
                        const msPassed = new Date() - new Date(review.submitted_at);
                        if (msPassed/MsPerDay < Config.rejectPeriod()) {
                            logApiResult(getReviews.name, params, {approved: "approved(in reject period"});
                            resolve(Config.rejectPeriod() * MsPerDay - msPassed);
                            return;
                        }
                    }
                    approveDate = review.submitted_at;
                }
                else if (reviewState === "changes_requested") {
                    approvals[review.user.login] = false;
                }
            }

            let approvalsNum = 0;
            let rejectedBy = null;
            for (let pushCollaborator of pushCollaborators) {
                 if (prAuthor === pushCollaborator.login) {
                     approvalsNum++;
                     continue;
                 }
                 const voted = Object.keys(approvals).find((key) => { return key === pushCollaborator.login; }) !== undefined;
                 if (voted) {
                    if (approvals[pushCollaborator.login] === true)
                       approvalsNum++;
                    else {
                       rejectedBy = pushCollaborator.login;
                       break;
                    }
                 }
            }

            let msToWait = null;
            let desc = "approved by " + approvalsNum + " core developer(s)";
            if (rejectedBy !== null)
                desc = "rejected by " + rejectedBy;
            else if (approvalsNum === 0) {
                desc = "not approved";
            } else if (approvalsNum < Config.approvalsNumber()) {
                assert(approveDate !== null);
                const date = new Date(approveDate);
                let beforeDate = new Date();
                beforeDate.setDate(beforeDate.getDate() - Config.approvalPeriod());
                if (date <= beforeDate) {
                    msToWait = 0;
                    desc += ", approval period finished";
                } else {
                    msToWait = date - beforeDate;
                    desc += ", in approval period";
                }
            } else {
                // can be submitted immediately
                assert(approvals >= Config.approvalsNumber());
                msToWait = 0;
            }

            logApiResult(getReviews.name, params, {approval: desc});
            resolve(msToWait);
        });
    });
}

// returns 'pending' if some of required checks are 'pending'
// returns 'success' if all of required are 'success'
// returns 'error' otherwise
function getStatuses(ref, requiredContexts) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.getStatuses(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getStatuses.name, params));
                return;
            }
            // Statuses are returned in reverse chronological order.
            let checks = {};
            for (let st of res.data) {
                if (!(st.context in checks)) {
                    if (st.state !== 'pending')
                        checks[st.context] = (st.state === 'success');
                }
            }

            let result = null;
            for (let requiredContext of requiredContexts) {
                 if (Object.keys(checks).find((key) => { return key === requiredContext; }) === undefined) {
                    result = 'pending';
                    break;
                 }
            }
            if (!result) {
                if (Object.values(checks).find((c) => { return c === false; }) === undefined)
                    result = 'success';
                else
                    result = 'error';
            }

            logApiResult(getStatuses.name, params, {checks: result});
            resolve(result);
       });
    });
}

function getCommit(sha) {
    let params = commonParams();
    params.sha = sha;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getCommit(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha, treeSha: res.data.tree.sha, message: res.data.message};
            logApiResult(getCommit.name, params, result);
            resolve(result);
        });
  });
}

function createCommit(treeSha, message, parents) {
    let params = commonParams();
    params.tree = treeSha;
    params.message = message;
    params.parents = parents;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.createCommit(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, createCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha};
            logApiResult(createCommit.name, params, result);
            resolve(res.data.sha);
        });
  });
}

function getReference(ref) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(getReference.name, params, result);
            resolve(res.data.object.sha);
        });
    });
}

function getTags() {
    let params = commonParams();
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getTags(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getTags.name, params));
                return;
            }
            logApiResult(getTags.name, params, {tags: res.data.length});
            resolve(res.data);
        });
    });
}

function createReference(sha, ref) {
    let params = commonParams();
    params.sha = sha;
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.createReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, createReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(createReference.name, params, result);
            resolve(res.data.object.sha);
        });
    });
}

function updateReference(ref, sha, force) {
    let params = commonParams();
    params.ref = ref;
    params.sha = sha;
    params.force = force; // default (ensure we do ff merge).
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.updateReference(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, updateReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logApiResult(updateReference.name, params, result);
            resolve(res.data.object.sha);
       });
    });
}

function deleteReference(ref) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.deleteReference(params, (err) => {
            if (err) {
                reject(new ErrorContext(err, deleteReference.name, params));
                return;
            }
            const result = {deleted: true};
            logApiResult(deleteReference.name, params, result);
            resolve(result);
       });
    });
}

function updatePR(prNum, state) {
   let params = commonParams();
   params.state = state;
   params.number = prNum;
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.pullRequests.update(params, (err, res) => {
        if (err) {
            reject(new ErrorContext(err, updatePR.name, params));
            return;
        }
        const result = {state: res.data.state};
        logApiResult(updatePR.name, params, result);
        resolve(result);
     });
  });
}

function addLabels(params) {
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.issues.addLabels(params, (err, res) => {
        if (err) {
            reject(new ErrorContext(err, addLabels.name, params));
            return;
        }
        const result = {added: true};
        logApiResult(addLabels.name, params, result);
        resolve(res.data);
     });
  });
}

function removeLabel(label, prNum) {
    let params = commonParams();
    params.number = prNum;
    params.name = label;
    return new Promise( (resolve, reject) => {
      Github.authenticate(GithubAuthentication);
      Github.issues.removeLabel(params, (err) => {
          if (err) {
             reject(new ErrorContext(err, addLabels.name, params));
             return;
          }
          const result = {removed: true};
          logApiResult(removeLabel.name, params, result);
          resolve(result);
      });
  });
}

function getProtectedBranchRequiredStatusChecks(branch) {
    let params = commonParams();
    params.branch = branch;
    return new Promise( (resolve, reject) => {
      Github.authenticate(GithubAuthentication);
      Github.repos.getProtectedBranchRequiredStatusChecks(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getProtectedBranchRequiredStatusChecks.name, params));
             return;
          }
          const result = {checks: res.data.contexts.length};
          logApiResult(getProtectedBranchRequiredStatusChecks.name, params, result);
          resolve(res.data.contexts);
      });
    });
}

function getCollaborators() {
    const params = commonParams();
    return new Promise( (resolve, reject) => {
      Github.authenticate(GithubAuthentication);
      Github.repos.getCollaborators(params, (err, res) => {
          if (err) {
             reject(new ErrorContext(err, getCollaborators.name, params));
             return;
          }
          const result = {collaborators: res.data.length};
          logApiResult(getCollaborators.name, params, result);
          resolve(res.data);
      });
    });
}

