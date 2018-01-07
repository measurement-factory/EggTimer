const fs = require('fs');
const http = require('http');
const createHandler = require('github-webhook-handler');
const nodeGitHub = require('github');
const assert = require('assert');
const endOfLine = require('os').EOL;
const bunyan = require('bunyan');

// fast-forward merge failed
const MergeFailedLabel = "S-merge-failed";
// Some of required staging checks failed
const StagingChecksFailedLabel = "S-staging-checks-failed";
// fast-forward merge succeeded
const MergedLabel = "S-merged";
// Merge started (tag and staging branch successfully adjusted)
const MergingLabel = "S-merging";
// Merge succeeded up to fast-forward step. For testing purpose.
const MergeReadyLabel = "S-merge-ready";

function MergingTag(prNum) {
    assert(prNum);
    return "tags/T-merging-PR" + prNum;
}

const TagRegex = /(refs\/)(tags\/.*-PR)(\d+)$/;
const MsPerHour = 3600 * 1000;

class ConfigOptions {
    constructor(fname) {
        const conf = JSON.parse(fs.readFileSync(fname));
        this._githubUser = conf.github_username;
        this._githubToken = conf.github_token;
        this._githubWebhookPath = conf.github_webhook_path;
        this._githubWebhookSecret = conf.github_webhook_secret;
        this._repo = conf.repo;
        this._host = conf.host;
        this._port = conf.port;
        this._owner = conf.owner;
        this._stagingBranch = conf.staging_branch;
        this._dryRun = conf.dry_run;
        this._skipMerge = conf.skip_merge;
        this._approvalsNumber = conf.approvals_number;
        assert(this._approvalsNumber > 1);
        this._approvalPeriod = conf.approval_period; // in hours
        this._rejectPeriod = conf.reject_period; // in hours
        this._loggerType = conf.logger_type;
        this._loggerPath = conf.logger_path;
        this._loggerPeriod = conf.logger_period;
        this._loggerCount = conf.logger_count;

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
    host() { return this._host; }
    port() { return this._port; }
    owner() { return this._owner; }
    stagingBranch() { return "heads/" + this._stagingBranch + "_branch"; }
    dryRun() { return this._dryRun; }
    skipMerge() { return this._skipMerge; }
    approvalsNumber() { return this._approvalsNumber; }
    approvalPeriod() { return this._approvalPeriod; }
    rejectPeriod() { return this._rejectPeriod; }
    loggerType() { return this._loggerType; }
    loggerPath() { return this._loggerPath; }
    loggerPeriod() { return this._loggerPeriod; }
    loggerCount() { return this._loggerCount; }
}

const Config = new ConfigOptions('config.json');

const Logger = bunyan.createLogger({
    name: 'eggtimer',
    streams: [{
        type: Config.loggerType(),
        path: Config.loggerPath(),
        period: Config.loggerPeriod(),
        count: Config.loggerCount()
      }]
    });
Logger.addStream({name: "eggtimer-out", stream: process.stdout});

const WebhookHandler = createHandler({ path: Config.githubWebhookPath(), secret: Config.githubWebhookSecret() });
const GitHub = new nodeGitHub({ version: "3.0.0" });
const GitHubAuthentication = { type: 'token', username: Config.githubUser(), token: Config.githubToken() };

function logError(err, context) {
    assert(context);
    let msg = context + ": " + err.toString();
    if (Object.getPrototypeOf(err) === Object.prototype) {
        if ('stack' in err)
            msg += " " + err.stack.toString();
    }
    Logger.error(msg);
}

class RunScheduler {

    constructor() {
        // Essentially a (key,value) list:
        // key: PR number
        // value: a timer id, returned by setTimeout()
        this._timer = null;
        this._fireDate = null;
        this.rerun = false;
        this.running = false;
    }

    async startup() {
        Logger.info("startup");
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
        this.run();
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
                await step.run();
            } catch (e) {
                logError(e, "RunScheduler.run");
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

// Gets PR list from GitHub and processes some/all PRs from this list.
class MergeStep {

    constructor() {
        this.total = 0;
        this.errors = 0;
    }

    // Gets PR list from GitHub and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async run() {
        if (await this.resumeCurrent())
            return; // still in-process

        const prList = await getPRList();
        prList.sort((pr1, pr2) => { return new Date(pr1.created_at) - new Date(pr2.created_at); });

        while (prList.length) {
            try {
                let context = new MergeContext(prList.shift());
                this.total++;
                const running = await context.run();
                if (running)
                    break;
            } catch (e) {
                this.errors++;
                if (!prList.length)
                    throw e;
            }
        }
    }

    // Looks for the being-in-merge PR and resumes its merging, if found.
    // If such PR was found and its merging not yet finished, returns 'true'.
    // If no such PR was found or its merging was finished, returns 'false'.
    async resumeCurrent() {
        let context = await this._current();
        if (!context)
            return false;

        const commitStatus = await context.checkStatuses(context.tagSha);

        if (commitStatus === 'pending') {
            this._log("waiting for more staging checks completing");
            return true;
        } else if (commitStatus === 'success') {
            this._log("staging checks succeeded");
            // TODO: log whether that staging_branch points to us.
            // return 'continue';
            return await context.run();
        } else {
            assert(commitStatus === 'failure');
            return false;
        }
    }

    // Loads 'being-in-merge' PR, if exists (the PR has tag and staging_branch points to the tag).
    async _current() {
        const stagingSha = await getReference(Config.stagingBranch());
        let tags = null;
        // request all repository tags
        tags = await getTags();
        if (!tags.length) {
            Logger.info("No tags found");
            return null;
        }

        // search for a tag, the staging_branch points to,
        // and parse out PR number from the tag name
        let prNum = null;
        let tagName = null;
        for (let tag of tags) {
            if (tag.object.sha === stagingSha) {
                const matched = tag.ref.match(TagRegex);
                if (matched) {
                    prNum = matched[3];
                    tagName = matched[2] + matched[3];
                    break;
                }
            }
        }

        if (prNum === null) {
            Logger.info("No merging PR found.");
            return null;
        }
        assert(tagName === MergingTag(prNum));

        let stagingPr = null;
        try {
            stagingPr = await getPR(prNum, false);
            if (stagingPr.state !== 'open') {
                Logger.error("PR" + prNum + " was unexpectedly closed");
                if (!Config.dryRun())
                    await deleteReference(tagName);
                return null;
            }
        } catch (e) {
            if (!Config.dryRun())
                await deleteReference(tagName);
            throw e;
        }

        return new MergeContext(stagingPr, stagingSha);
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }

} // MergeStep

const Scheduler = new RunScheduler();
Scheduler.startup();

// Processing a single PR
class MergeContext {

    constructor(pr, tSha) {
        // true when fast-forwarding master into staging_branch fails
        this.ffMergeFailed = false;
        this._pr = pr;
        this.tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
    }

    // Does all required processing for the PR towards merge.
    // Returns 'true' if the PR is still in-process and
    // 'false' when the PR was successfully merged or skipped
    // due to an error (e.g., failed staging checks).
    async run() {
        try {
            if (await this._process()) {
                this._log("Still processing");
                return true;
            }
        } catch (e) {
            this.logError(e, "MergeContext.run");
            // should re-run fast-forwarding failed due to a base change
            if (this.ffMergeFailed)
                Scheduler.rerun = true;
            await this.cleanupUnexpectedError();
            throw e;
        }
        return false;
    }

    async _process() {
        let stillInProcess;
        if (this.tagSha)
            stillInProcess = !(await this._finishProcessing());
        else
            stillInProcess = await this._startProcessing();
        return stillInProcess;
    }

    // Returns 'true' if the PR passed all checks and merging started,
    // 'false' when the PR was skipped due to some failed checks.
    async _startProcessing() {
        if (!(await this._checkMergePreconditions()))
            return false;

        if (Config.dryRun()) {
            this._warnDryRun("start merging");
            return false;
        }
        await this._startMerging();
        await this._labelMerging();
        return true;
    }

    // Returns 'true' when the PR was successfully merged;
    // 'false' if the PR is still in-process(delayed for some reason);
    async _finishProcessing() {
        if (Config.dryRun()) {
            this._warnDryRun("finish merging");
            return true;
        }

        if (Config.skipMerge()) {
            await this._labelMergeReady();
            this._warnDryRun("finish merging", "skip_merge");
            return true;
        }

        await this._finishMerging();
        await this._cleanupMerged();
        return false;
    }

    // Tries to load 'merge tag' for the PR.
    async _loadTag() {
       try {
           this.tagSha = await getReference(this.mergingTag());
       } catch (e) {
           if (e.notFound())
               this._log(this.mergingTag() + " not found");
           else
               throw e;
       }
    }

    // Examines 'merge tag' for the PR.
    // Returns 'true' if the tag does not exist or the caller should ignore this tag;
    // 'false': the non-stale tag exists and it is status is 'failure'.
    async _checkTag() {
        await this._loadTag();
        if (!this.tagSha)
            return true;

        const commitStatus = await this.checkStatuses(this.tagSha);
        if (commitStatus !== 'failure')
            return true;

        this._log("staging checks failed");
        const tagCommit = await getCommit(this.tagSha);
        const prMergeSha = await getReference(this.mergePath());
        const prCommit = await getCommit(prMergeSha);

        if (tagCommit.treeSha !== prCommit.treeSha) {
            this._log("will re-try: merge commit has changed since last failed staging checks");
            if (!Config.dryRun())
                await deleteReference(this.mergingTag());
            return true;
        } else {
            let msg = "will not re-try: merge commit has not changed since last failed staging checks";
            // the base branch could be changed but resulting with new conflicts,
            // merge commit is not updated then
            if (this.prMergeable() !== true)
                msg += " due to conflicts with " + this.prBaseBranch();
            this._log(msg);
            if (!Config.dryRun())
                await this._labelStagingFailed();
            return false;
        }
    }

    // Checks whether the PR is ready for merge (all PR lamps are 'green').
    // Also forbids merging the already merged PR (marked with label) or
    // if was interrupted by an event ('Scheduler.rerun' is true).
    async _checkMergePreconditions() {
        this._log("checking merge preconditions...");

        const pr = await getPR(this.number(), true);
        // refresh PR data
        assert(pr.number === this._pr.number);
        this._pr = pr;

        if (!this.prOpen()) {
            this._log("unexpectedly closed");
            return false;
        }

        if (!this.prMergeable()) {
            this._log("not mergeable yet.");
            return false;
        }

        // in ms
        const timeToWait = await this._checkApproved();
        if (timeToWait === null) // not approved or rejected
            return false;
        else if (timeToWait !== 0) { // approved, but waiting
            Scheduler.plan(timeToWait, this.number());
            return false;
        }

        const commitStatus = await this.checkStatuses(this.prHeadSha());
        if (commitStatus !== 'success') {
            this._log("commit status is " + commitStatus);
            return false;
        }

        if (await this.hasLabel(MergedLabel, this.number())) {
            this._log("already merged");
            return false;
        }

        if (!(await this._checkTag()))
            return false;

        if (Scheduler.rerun) {
            this._log("rerun");
            return false;
        }

        return true;
    }

    // Creates a 'merge commit' and adjusts staging_branch.
    async _startMerging() {
        this._log("start merging...");
        const baseSha = await getReference(this.prBaseBranchPath());
        const mergeSha = await getReference("pull/" + this.number() + "/merge");
        const mergeCommit = await getCommit(mergeSha);
        const tempCommitSha = await createCommit(mergeCommit.treeSha, this.prMessage(), [baseSha]);
        this.tagSha = await createReference(tempCommitSha, "refs/" + this.mergingTag());
        await updateReference(Config.stagingBranch(), this.tagSha, true);
    }

    // fast-forwards base into staging_branch
    async _finishMerging() {
        assert(this.tagSha);
        this._log("finish merging...");
        try {
            await updateReference(this.prBaseBranchPath(), this.tagSha, false);
        } catch (e) {
            if (e.unprocessable()) {
                this._log("fast-forwarding failed");
                this.ffMergeFailed = true;
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
    }

    // does not throw
    async cleanupUnexpectedError() {
        if (Config.dryRun()) {
            this._warnDryRun("cleanup on error");
            return;
        }
        this._log("cleanup on unexpected error...");
        // delete merging tag, if exists
        try {
            await deleteReference(this.mergingTag());
        } catch (e) {
            // For the record: GitHub returns 422 error if there is no such
            // reference 'refs/:sha', and 404 if there is no such tag 'tags/:tag'.
            // TODO: once I saw that both errors can be returned, so looks
            // like this GitHub behavior is unstable.
            if (e.notFound())
                this._log(this.mergingTag() + "tag not found");
            else
                this.logError(e, "MergeContext.cleanupUnexpectedError");
        }

        try {
            await this._labelMergeFailed();
        } catch (e) {
            this.logError(e, "MergeContext.cleanupUnexpectedError");
        }
    }

    // If approved, returns number for milliseconds to wait (>=0),
    // where returned zero means that no waiting required.
    // If not approved (or rejected), returns null.
    async _checkApproved() {
        const collaborators = await getCollaborators();
        const pushCollaborators = collaborators.filter(c => c.permissions.push === true);

        let reviews = await getReviews(this.number());

        const prAgeMs = new Date() - new Date(this.createdAt());
        const rejectPeriodMs = Config.rejectPeriod() * MsPerHour;
        if (prAgeMs < rejectPeriodMs) {
            this._log("in reject period");
            return rejectPeriodMs - prAgeMs;
        }

        // An array of [{reviewer, date, status}] elements,
        // where 'reviewer' is a core developer, 'date' the review date and 'status' is either
        // 'approved' or 'changes_requested'.
        let usersVoted = [];
        if (pushCollaborators.find(el => el.login === this.prAuthor()))
            usersVoted.push({reviewer: this.prAuthor(), date: this.createdAt(), state: 'approved'});

        // Reviews are returned in chronological order; the list may contain several
        // reviews from the same reviewer, so the actual 'state' is the most recent one.
        for (let review of reviews) {
            if (!pushCollaborators.find(el => el.login === review.user.login))
                continue;

            const reviewState = review.state.toLowerCase();
            let approval = usersVoted.find(el => el.reviewer === review.user.login);

            if (reviewState === 'approved' || reviewState === 'changes_requested') {
                if (approval !== undefined) {
                    approval.state = reviewState;
                    approval.date = review.submitted_at;
                } else {
                    usersVoted.push({reviewer: review.user.login, date: review.submitted_at, state: reviewState});
                }
            }
        }

        const userRequested = usersVoted.find(el => el.state === 'changes_requested');
        if (userRequested !== undefined) {
            this._log("changes requested by " + userRequested.reviewer);
            return null;
        }

        const usersApproved = usersVoted.filter(u => u.state !== 'changes_requested');

        const defaultMsg = "approved by " + usersApproved.length + " core developer(s)";
        if (usersApproved.length === 0) {
            this._log("not approved");
            return null;
        } else if (usersApproved.length >= Config.approvalsNumber()) {
            this._log(defaultMsg);
            return 0;
        } else {
            assert(usersApproved.length < Config.approvalsNumber());
            const approvalPeriodMs = Config.approvalPeriod() * MsPerHour;
            if (prAgeMs < approvalPeriodMs) {
                this._log(defaultMsg + ", in approval period");
                return approvalPeriodMs - prAgeMs;
            }
            this._log(defaultMsg + ", approval period finished");
            return 0;
        }
    }

    // returns one of:
    // 'pending' if some of required checks are 'pending'
    // 'success' if all of required are 'success'
    // 'error' otherwise
    async checkStatuses(ref) {

        const requiredContexts = await getProtectedBranchRequiredStatusChecks(this.prBaseBranch());
        // https://developer.github.com/v3/repos/statuses/#get-the-combined-status-for-a-specific-ref
        // state is one of 'failure', 'error', 'pending' or 'success'.
        // We treat both 'failure' and 'error' as an 'error'.
        let combinedStatus = await getStatuses(ref);
        if (requiredContexts.length === 0) {
            this.logError("no required contexts found");
            // rely on all available checks then
            return combinedStatus.state;
        }

        // An array of [{context, state}] elements
        let requiredChecks = [];
        // filter out non-required checks
        for (let st of combinedStatus.statuses) {
            if (requiredContexts.find(el => el === st.context))
                requiredChecks.push({context: st.context, state: st.state});
        }

        if (requiredChecks.length < requiredContexts.length || requiredChecks.find(check => check.state === 'pending'))
            return 'pending';

        const prevLen = requiredChecks.length;
        requiredChecks = requiredChecks.filter(check => check.state === 'success');
        return prevLen === requiredChecks.length ? 'success' : 'failure';
    }

    // Label manipulation methods

    async hasLabel(label) {
        const labels = await getLabels(this.number());
        return labels.find(lbl => lbl.name === label) !== undefined;
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
        await this.removeLabel(StagingChecksFailedLabel);
        await this.addLabel(MergingLabel);
    }

    async _labelMerged() {
        await this.removeLabel(MergingLabel);
        await this.removeLabel(MergeReadyLabel);
        await this.removeLabel(MergeFailedLabel);
        await this.removeLabel(StagingChecksFailedLabel);
        await this.addLabel(MergedLabel);
    }

    async _labelMergeFailed() {
        await this.removeLabel(MergingLabel);
        await this.removeLabel(MergeReadyLabel);
        await this.addLabel(MergeFailedLabel);
    }

    async _labelStagingFailed() {
        await this.removeLabel(MergingLabel);
        await this.addLabel(StagingChecksFailedLabel);
    }

    async _labelMergeReady() {
        await this.removeLabel(MergingLabel);
        await this.removeLabel(StagingChecksFailedLabel);
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

    mergingTag() { return MergingTag(this._pr.number); }

    createdAt() { return this._pr.created_at; }

    mergePath() { return "pull/" + this._pr.number + "/merge"; }

    _log(msg) {
        Logger.info("PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit) + "):", msg);
    }

    _warnDryRun(msg, opt) {
        const option = opt === undefined ? "dry_run" : opt;
        this._log("skip " + msg + " due to " + option + " option");
    }

    logError(err, context) {
        assert(context);
        let msg = this.toString() + " " + context;
        logError(err, msg);
    }

    toString() {
        let str = "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
        if (this.tagSha !== null)
            str += ", tag: " + this.tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
} // MergeContext

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

// https://developer.github.com/v3/activity/events/types/#pushevent
WebhookHandler.on('push', (ev) => {
    const e = ev.payload;
    Logger.info("push event:", e.ref);
    Scheduler.run();
});


// Promisificated node-github wrappers

// An error context for promisificated wrappers.
class ErrorContext {
    constructor(err, method, args) {
        // The underlying rejection may be a bot-specific Promise.reject() or
        // be caused by a GitHub API error, so 'err' contains either
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
    // E.g., fast-forward failure returns this error.
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
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.getAll(params, (err, res) => {
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
        GitHub.authenticate(GitHubAuthentication);
        GitHub.issues.getIssueLabels(params, (err, res) => {
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
        Logger.info("PR" + prNum + ": GitHub still caluclates mergeable status. Will retry in " + (d/1000) + " seconds");
        await sleep(d);
    }
    return Promise.reject(new ErrorContext("GitHub could not calculate mergeable status",
                getPR.name, {pr: prNum}));
}

function requestPR(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.get(params, (err, pr) => {
            if (err) {
                reject(new ErrorContext(err, requestPR.name, params));
                return;
            }
            const result = {number: pr.data.number};
            logApiResult(requestPR.name, params, result);
            resolve(pr.data);
       });
   });
}

function getReviews(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.pullRequests.getReviews(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getReviews.name, params));
                return;
            }
            resolve(res.data);
        });
    });
}

function getStatuses(ref) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.repos.getCombinedStatusForRef(params, (err, res) => {
            if (err) {
                reject(new ErrorContext(err, getStatuses.name, params));
                return;
            }
            logApiResult(getStatuses.name, params, {statuses: res.data.statuses.length});
            resolve(res.data);
        });
    });
}

function getCommit(sha) {
    let params = commonParams();
    params.sha = sha;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getCommit(params, (err, res) => {
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
    assert(!Config.dryRun());
    let params = commonParams();
    params.tree = treeSha;
    params.message = message;
    params.parents = parents;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.createCommit(params, (err, res) => {
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
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getReference(params, (err, res) => {
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

// get all available repository tags
function getTags() {
    let params = commonParams();
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.getTags(params, (err, res) => {
            const notFound = (err && err.code === 404);
            if (err && !notFound) {
                reject(new ErrorContext(err, getTags.name, params));
                return;
            }
            const result = notFound ? [] : res.data;
            logApiResult(getTags.name, params, {tags: result.length});
            resolve(result);
        });
    });
}

function createReference(sha, ref) {
    assert(!Config.dryRun());
    let params = commonParams();
    params.sha = sha;
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.createReference(params, (err, res) => {
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
    assert(!Config.dryRun());
    let params = commonParams();
    params.ref = ref;
    params.sha = sha;
    params.force = force; // default (ensure we do ff merge).
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.updateReference(params, (err, res) => {
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
    assert(!Config.dryRun());
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        GitHub.authenticate(GitHubAuthentication);
        GitHub.gitdata.deleteReference(params, (err) => {
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
   assert(!Config.dryRun());
   let params = commonParams();
   params.state = state;
   params.number = prNum;
   return new Promise( (resolve, reject) => {
     GitHub.authenticate(GitHubAuthentication);
     GitHub.pullRequests.update(params, (err, res) => {
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
   assert(!Config.dryRun());
   return new Promise( (resolve, reject) => {
     GitHub.authenticate(GitHubAuthentication);
     GitHub.issues.addLabels(params, (err, res) => {
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
    assert(!Config.dryRun());
    let params = commonParams();
    params.number = prNum;
    params.name = label;
    return new Promise( (resolve, reject) => {
      GitHub.authenticate(GitHubAuthentication);
      GitHub.issues.removeLabel(params, (err) => {
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
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.getProtectedBranchRequiredStatusChecks(params, (err, res) => {
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
      GitHub.authenticate(GitHubAuthentication);
      GitHub.repos.getCollaborators(params, (err, res) => {
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

