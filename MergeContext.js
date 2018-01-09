const assert = require('assert');
const endOfLine = require('os').EOL;
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Merger = require('./Main.js');
const Util = require('./Util.js');

const commonParams = Util.commonParams;
const Logger = Log.Logger;

const MsPerHour = 3600 * 1000;

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
    async runContext() {
        try {
            if (await this._process()) {
                this._log("Still processing");
                return true;
            }
        } catch (e) {
            this.logError(e, "MergeContext.runContext");
            // should re-run fast-forwarding failed due to a base change
            if (this.ffMergeFailed)
                Merger.rerun = true;
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
        if (!(await this._checkMergeConditions("checking merge preconditions...")))
            return false;

        if (Config.dryRun()) {
            this._warnDryRun("start merging");
            return false;
        }
        await this._startMerging();
        await this._labelMerging();
        return true;
    }

    // Returns 'true' if the PR processing was finished (it was merged or
    // an error occurred so that we need to start it from scratch);
    // 'false' if the PR is still in-process (delayed for some reason);
    async _finishProcessing() {
        if (await this._tagIsFresh()) {
            if (!(await this._checkMergeConditions("checking merge postconditions..."))) {
                await GH.deleteReference(this.mergingTag());
                await this._labelMergeFailed();
                return true;
            }
        }

        if (Config.dryRun()) {
            this._warnDryRun("finish merging");
            return false;
        }

        if (Config.skipMerge()) {
            await this._labelMergeReady();
            this._warnDryRun("finish merging", "skip_merge");
            return false;
        }

        await this._finishMerging();
        await this._cleanupMerged();
        return true;
    }

    // Tries to load 'merge tag' for the PR.
    async _loadTag() {
       try {
           this.tagSha = await GH.getReference(this.mergingTag());
       } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               this._log(this.mergingTag() + " not found");
           else
               throw e;
       }
    }

    // Check 'merge tag' state as merge condition.
    // Returns 'true' if the tag does not exist or the caller (i.e., preconditions
    // verifier) should ignore this tag;
    // 'false': the non-stale tag exists and it's status is 'failure'.
    async _ignoreTag() {
        await this._loadTag();
        if (!this.tagSha)
            return true;

        const commitStatus = await this.checkStatuses(this.tagSha);
        if (commitStatus !== 'failure')
            return true;

        this._log("staging checks failed some time ago");
        if (await this._tagIsFresh()) {
            let msg = "will not re-try: merge commit has not changed since last failed staging checks";
            // the base branch could be changed but resulting with new conflicts,
            // merge commit is not updated then
            if (this.prMergeable() !== true)
                msg += " due to conflicts with " + this.prBaseBranch();
            this._log(msg);
            if (!Config.dryRun())
                await this._labelStagingFailed();
            return false;
        } else {
            this._log("will re-try: merge commit has changed since last failed staging checks");
            if (!Config.dryRun())
                await GH.deleteReference(this.mergingTag());
            return true;
        }
    }

    // whether the tag and GitHub-generated PR 'merge commit' are equal
    async _tagIsFresh() {
        const tagCommit = await GH.getCommit(this.tagSha);
        const prMergeSha = await GH.getReference(this.mergePath());
        const prCommit = await GH.getCommit(prMergeSha);
        return tagCommit.treeSha === prCommit.treeSha;
    }

    // Checks whether the PR is ready for merge (all PR lamps are 'green').
    // Also forbids merging the already merged PR (marked with label) or
    // if was interrupted by an event ('Merger.rerun' is true).
    async _checkMergeConditions(desc) {
        this._log(desc);

        const pr = await GH.getPR(this.number(), true);
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
            Merger.plan(timeToWait, this.number());
            return false;
        }

        const commitStatus = await this.checkStatuses(this.prHeadSha());
        if (commitStatus !== 'success') {
            this._log("commit status is " + commitStatus);
            return false;
        }

        if (await this.hasLabel(Config.mergedLabel(), this.number())) {
            this._log("already merged");
            return false;
        }

        if (!(await this._ignoreTag()))
            return false;

        if (Merger.rerun) {
            this._log("rerun");
            return false;
        }

        return true;
    }

    // Creates a 'merge commit' and adjusts staging_branch.
    async _startMerging() {
        this._log("start merging...");
        const baseSha = await GH.getReference(this.prBaseBranchPath());
        const mergeSha = await GH.getReference("pull/" + this.number() + "/merge");
        const mergeCommit = await GH.getCommit(mergeSha);
        const tempCommitSha = await GH.createCommit(mergeCommit.treeSha, this.prMessage(), [baseSha]);
        this.tagSha = await GH.createReference(tempCommitSha, "refs/" + this.mergingTag());
        await GH.updateReference(Config.stagingBranch(), this.tagSha, true);
    }

    // fast-forwards base into staging_branch
    async _finishMerging() {
        assert(this.tagSha);
        this._log("finish merging...");
        try {
            await GH.updateReference(this.prBaseBranchPath(), this.tagSha, false);
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
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
        await GH.updatePR(this.number(), 'closed');
        await GH.deleteReference(this.mergingTag());
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
            await GH.deleteReference(this.mergingTag());
        } catch (e) {
            // For the record: GitHub returns 422 error if there is no such
            // reference 'refs/:sha', and 404 if there is no such tag 'tags/:tag'.
            // TODO: once I saw that both errors can be returned, so looks
            // like this GitHub behavior is unstable.
            if (e.name === 'ErrorContext' && e.notFound())
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
        const collaborators = await GH.getCollaborators();
        const pushCollaborators = collaborators.filter(c => c.permissions.push === true);

        let reviews = await GH.getReviews(this.number());

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

        const requiredContexts = await GH.getProtectedBranchRequiredStatusChecks(this.prBaseBranch());
        // https://developer.github.com/v3/repos/statuses/#get-the-combined-status-for-a-specific-ref
        // state is one of 'failure', 'error', 'pending' or 'success'.
        // We treat both 'failure' and 'error' as an 'error'.
        let combinedStatus = await GH.getStatuses(ref);
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
        const labels = await GH.getLabels(this.number());
        return labels.find(lbl => lbl.name === label) !== undefined;
    }

    async removeLabel(label) {
        try {
            await GH.removeLabel(label, this.number());
        } catch (e) {
            if (e.name === 'ErrorContext' && e.notFound()) {
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
            await GH.addLabels(params);
        } catch (e) {
            // TODO: also extract and check for "already_exists" code:
            // { "message": "Validation Failed", "errors": [ { "resource": "Label", "code": "already_exists", "field": "name" } ] }
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                Logger.info("addLabel: " + label + " already exists");
                return;
            }
            throw e;
        }
    }

    async _labelMerging() {
        await this.removeLabel(Config.mergeReadyLabel());
        await this.removeLabel(Config.mergeFailedLabel());
        await this.removeLabel(Config.stagingChecksFailedLabel());
        await this.addLabel(Config.mergingLabel());
    }

    async _labelMerged() {
        await this.removeLabel(Config.mergingLabel());
        await this.removeLabel(Config.mergeReadyLabel());
        await this.removeLabel(Config.mergeFailedLabel());
        await this.removeLabel(Config.stagingChecksFailedLabel());
        await this.addLabel(Config.mergedLabel());
    }

    async _labelMergeFailed() {
        await this.removeLabel(Config.mergingLabel());
        await this.removeLabel(Config.mergeReadyLabel());
        await this.addLabel(Config.mergeFailedLabel());
    }

    async _labelStagingFailed() {
        await this.removeLabel(Config.mergingLabel());
        await this.addLabel(Config.stagingChecksFailedLabel());
    }

    async _labelMergeReady() {
        await this.removeLabel(Config.mergingLabel());
        await this.removeLabel(Config.stagingChecksFailedLabel());
        await this.addLabel(Config.mergeReadyLabel());
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

    mergingTag() { return Util.MergingTag(this._pr.number); }

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
        Log.logError(err, msg);
    }

    toString() {
        let str = "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
        if (this.tagSha !== null)
            str += ", tag: " + this.tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
} // MergeContext

module.exports = MergeContext;

