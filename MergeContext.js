const assert = require('assert');
const endOfLine = require('os').EOL;
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');

const commonParams = Util.commonParams;
const Logger = Log.Logger;

const MsPerHour = 3600 * 1000;

// Processing a single PR
class MergeContext {

    constructor(pr, tSha) {
        // true when fast-forwarding master into staging_branch fails
        this._pr = pr;
        this.tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
        // gets a value only if ready/ready_and_delayed
        this._approvalDelay = null;
    }

    // Returns 'true' if the PR passed all checks and merging started,
    // 'false' when the PR was skipped due to some failed checks.
    async startProcessing() {
        if (!(await this._checkMergeConditions("checking merge preconditions...")))
            return false;

        // ready but in approval period
        if (this._approvalDelay > 0)
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
    // 'false' if the PR is still in-process (delayed for some reason).
    async finishProcessing() {

        const commitStatus = await this._checkStatuses(this.tagSha);
        if (commitStatus === 'pending') {
            Logger.info("waiting for more staging checks completing");
            return false;
        } else if (commitStatus === 'success') {
            Logger.info("staging checks succeeded");
        } else {
            assert(commitStatus === 'failure');
            Logger.info("staging checks failed");
            if (Config.dryRun()) {
                this._warnDryRun("finish merging");
                return false;
            }
            await this._cleanupMergeFailed();
            return true;
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

        const compareStatus = await GH.compareCommits(this.prBaseBranch(), this.mergingTag());

        if (compareStatus === "identical" || compareStatus === "behind")
            return await this._cleanupMerged();

        if (await this._needRestart()) {
            // compareStatus can be "diverged" here, if the base changed
            await this._cleanupMergeFailed();
            return true;
        }

        assert(compareStatus === "ahead");
        if (!(await this._finishMerging()))
            return true;
        return await this._cleanupMerged();
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

        const commitStatus = await this._checkStatuses(this.tagSha);
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

    // whether the being-in-merge PR state changed so that
    // we should abort merging and start it from scratch
    async _needRestart() {
        if (!(await this._tagIsFresh()))
            return true;
        if (!(await this._checkMergeConditions("checking merge postconditions...")))
            return true;
        return false;
    }

    // Checks whether the PR is ready for merge (all PR lamps are 'green').
    // Also forbids merging the already merged PR (marked with label).
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

        const messageValid = this.prMessageValid();
        if (!Config.dryRun())
            this._labelCheckMessage(messageValid);
        if (!messageValid) {
            this._log("invalid PR message");
            return false;
        }

        if (!this.prMergeable()) {
            this._log("not mergeable yet.");
            return false;
        }

        const commitStatus = await this._checkStatuses(this.prHeadSha());
        if (commitStatus !== 'success') {
            this._log("commit status is " + commitStatus);
            return false;
        }

        if (await this.hasLabel(Config.mergedLabel(), this.number())) {
            this._log("already merged");
            return false;
        }

        const delay = await this._checkApproved();
        // not_approved
        if (delay === null)
            return false;

        if (!(await this._ignoreTag()))
            return false;

        this._approvalDelay = delay;
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
    // returns 'true' on success, 'false' on failure,
    // throws on unexpected error
    async _finishMerging() {
        assert(this.tagSha);
        this._log("finish merging...");
        try {
            await GH.updateReference(this.prBaseBranchPath(), this.tagSha, false);
            return true;
        } catch (e) {
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                this._log("fast-forwarding failed");
                await this._cleanupMergeFailed();
                return false;
            }
            throw e;
        }
    }

    // Adjusts the successfully merged PR (labels, status, tag).
    // Returns 'true' if the PR cleaup was completed, 'false'
    // otherwise.
    async _cleanupMerged() {
        if (Config.dryRun()) {
            this._warnDryRun("cleanup merged");
            return false;
        }
        this._log("merged, cleanup...");
        await this._labelMerged();
        await GH.updatePR(this.number(), 'closed');
        await GH.deleteReference(this.mergingTag());
        return true;
    }

    // does not throw
    async _cleanupMergeFailed() {
        if (Config.dryRun()) {
            this._warnDryRun("cleanup merge failed");
            return;
        }
        this._log("merge failed, cleanup...");
        await this._labelMergeFailed();
        await GH.deleteReference(this.mergingTag());
    }

    // If approved, returns the number for milliseconds to wait for,
    // or '0', meaning 'ready'. If not approved, returns null.
    async _checkApproved() {
        const collaborators = await GH.getCollaborators();
        const pushCollaborators = collaborators.filter(c => c.permissions.push === true);
        const requestedReviewers = this.prRequestedReviewers();

        for (let collaborator of pushCollaborators) {
            if (requestedReviewers.includes(collaborator.login)) {
                this._log("requested core reviewer: " + collaborator.login);
                return null;
            }
        }

        let reviews = await GH.getReviews(this.number());

        const prAgeMs = new Date() - new Date(this.createdAt());
        const votingDelayMinMs = Config.votingDelayMin() * MsPerHour;
        if (prAgeMs < votingDelayMinMs) {
            this._log("in minimal voting period");
            return votingDelayMinMs - prAgeMs;
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
        if (usersApproved.length < Config.necessaryApprovals()) {
            this._log("not approved by necessary " + Config.necessaryApprovals() + " votes");
            return null;
        } else if (usersApproved.length >= Config.sufficientApprovals()) {
            this._log(defaultMsg);
        } else {
            assert(usersApproved.length < Config.sufficientApprovals());
            const votingDelayMaxMs = Config.votingDelayMax() * MsPerHour;
            if (prAgeMs < votingDelayMaxMs) {
                this._log(defaultMsg + ", in maximum voting period");
                return votingDelayMaxMs - prAgeMs;
            }
            this._log(defaultMsg + ", maximum voting period finished");
        }
        return 0;
    }

    // returns one of:
    // 'pending' if some of required checks are 'pending'
    // 'success' if all of required are 'success'
    // 'error' otherwise
    async _checkStatuses(ref) {

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

    async _labelCheckMessage(isValid) {
        const label = Config.invalidMessageLabel();
        if (isValid)
            await this.removeLabel(label);
        else
            await this.addLabel(label);
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

    // the remainder of the approval period(in ms)
    // or 'null'(not in approval period)
    delay() { return this._approvalDelay; }

    number() { return this._pr.number; }

    prHeadSha() { return this._pr.head.sha; }

    prMessage() {
        return this._pr.title + endOfLine + this._pr.body + endOfLine +
            "(PR #" + this._pr.number + ")";
    }

    prMessageValid() {
        const lines = this.prMessage().split('\n');
        for (let line of lines) {
            if (line.length > 72)
                return false;
        }
        return true;
    }

    prRequestedReviewers() {
        let reviewers = [];
        if (this._pr.requested_reviewers) {
            for (let r of this._pr.requested_reviewers)
               reviewers.push(r.login);
        }
        return reviewers;
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

