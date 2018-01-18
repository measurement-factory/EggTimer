const assert = require('assert');
const endOfLine = require('os').EOL;
const Config = require('./Config.js');
const Log = require('./Logger.js');
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');

const MsPerHour = 3600 * 1000;

// Processing a single PR
class MergeContext {

    constructor(pr, tSha) {
        // true when fast-forwarding master into staging_branch fails
        this._pr = pr;
        this._tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
        // gets a value only if ready/ready_and_delayed
        this._votingDelay = null;
    }

    // Returns 'true' if all PR checks passed successfully and merging
    // started,'false' if we can't start the PR due to some failed checks.
    async startProcessing() {
        if (!(await this._checkMergeConditions("checking merge preconditions...")))
            return false;

        // 'slow burner' case
        if (this._votingDelay > 0)
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

        if (!this._prOpen()) {
            this._logError("was unexpectedly closed");
            return await this._cleanupMergeFailed();
        }

        const commitStatus = await this._checkStatuses(this._tagSha);
        if (commitStatus === 'pending') {
            this._log("waiting for more staging checks completing");
            return false;
        } else if (commitStatus === 'failure') {
            this._log("staging checks failed");
            return await this._cleanupMergeFailed();
        }
        assert(commitStatus === 'success');
        this._log("staging checks succeeded");

        const compareStatus = await GH.compareCommits(this._prBaseBranch(), this._mergingTag());
        if (compareStatus === "identical" || compareStatus === "behind") {
            this._log("already merged");
            return await this._cleanupMerged();
        }
        // note that _needRestart() would notice that the tag is "diverged",
        // but we check compareStatus first to avoid useless api requests
        if (compareStatus === "diverged" || await this._needRestart()) {
            this._log("PR branch and it's base branch diverged");
            return await this._cleanupMergeFailed();
        }
        assert(compareStatus === "ahead");

        if (Config.dryRun()) {
            this._warnDryRun("finish processing");
            return false;
        }
        if (Config.skipMerge()) {
            await this._labelMergeReady();
            this._warnDryRun("finish processing", "skip_merge");
            return false;
        }

        if (!(await this._finishMerging()))
            return true;
        this._log("merged successfully");
        return await this._cleanupMerged();
    }

    // Tries to load 'merge tag' for the PR.
    async _loadTag() {
       try {
           this._tagSha = await GH.getReference(this._mergingTag());
       } catch (e) {
           if (e.name === 'ErrorContext' && e.notFound())
               this._log(this._mergingTag() + " not found");
           else
               throw e;
       }
    }

    // Check 'merge tag' state as merge condition.
    // Returns 'true' if the tag does not exist or the caller (i.e., preconditions
    // verifier) should ignore this tag;
    // 'false' if the non-stale tag exists and it's status is 'failure'.
    async _ignoreTag() {
        await this._loadTag();
        if (!this._tagSha)
            return true;

        const commitStatus = await this._checkStatuses(this._tagSha);
        if (commitStatus !== 'failure')
            return true;

        this._log("staging checks failed some time ago");
        if (await this._tagIsFresh()) {
            let msg = "will not re-try: merge commit has not changed since last failed staging checks";
            // the base branch could be changed but resulting with new conflicts,
            // merge commit is not updated then
            if (this._prMergeable() !== true)
                msg += " due to conflicts with " + this._prBaseBranch();
            this._log(msg);
            if (!Config.dryRun())
                await this._labelStagingFailed();
            return false;
        } else {
            this._log("will re-try: merge commit has changed since last failed staging checks");
            if (!Config.dryRun())
                await GH.deleteReference(this._mergingTag());
            return true;
        }
    }

    // whether the tag and GitHub-generated PR 'merge commit' are equal
    async _tagIsFresh() {
        const tagCommit = await GH.getCommit(this._tagSha);
        const prMergeSha = await GH.getReference(this._mergePath());
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

        const pr = await GH.getPR(this._number(), true);
        // refresh PR data
        assert(pr.number === this._pr.number);
        this._pr = pr;

        if (!this._prOpen()) {
            this._log("unexpectedly closed");
            return false;
        }

        const messageValid = this._prMessageValid();
        if (!Config.dryRun())
            await this._labelCheckMessage(messageValid);
        if (!messageValid) {
            this._log("invalid PR message");
            return false;
        }

        if (!this._prMergeable()) {
            this._log("not mergeable yet.");
            return false;
        }

        const commitStatus = await this._checkStatuses(this._prHeadSha());
        if (commitStatus !== 'success') {
            this._log("commit status is " + commitStatus);
            return false;
        }

        if (await this._hasLabel(Config.mergedLabel(), this._number())) {
            this._log("already merged");
            return false;
        }

        const delay = await this._checkApproved();
        // not_approved
        if (delay === null)
            return false;

        if (!(await this._ignoreTag()))
            return false;

        this._votingDelay = delay;
        return true;
    }

    // Creates a 'merge commit' and adjusts staging_branch.
    async _startMerging() {
        this._log("start merging...");
        const baseSha = await GH.getReference(this._prBaseBranchPath());
        const mergeSha = await GH.getReference("pull/" + this._number() + "/merge");
        const mergeCommit = await GH.getCommit(mergeSha);
        const tempCommitSha = await GH.createCommit(mergeCommit.treeSha, this._prMessage(), [baseSha]);
        this._tagSha = await GH.createReference(tempCommitSha, "refs/" + this._mergingTag());
        await GH.updateReference(Config.stagingBranch(), this._tagSha, true);
    }

    // fast-forwards base into staging_branch
    // returns 'true' on success, 'false' on failure,
    // throws on unexpected error
    async _finishMerging() {
        assert(this._tagSha);
        this._log("finish merging...");
        try {
            await GH.updateReference(this._prBaseBranchPath(), this._tagSha, false);
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
        await GH.updatePR(this._number(), 'closed');
        await GH.deleteReference(this._mergingTag());
        return true;
    }

    // Adjusts PR when it's merge was failed(labels and tag).
    // Returns 'true' if the PR cleaup was completed, 'false'
    // otherwise.
    async _cleanupMergeFailed() {
        if (Config.dryRun()) {
            this._warnDryRun("cleanup merge failed");
            return false;
        }
        this._log("merge failed, cleanup...");
        await this._labelMergeFailed();
        await GH.deleteReference(this._mergingTag());
        return true;
    }

    // If approved, returns the number for milliseconds to wait for,
    // or '0', meaning 'ready'. If not approved, returns null.
    async _checkApproved() {
        const collaborators = await GH.getCollaborators();
        const pushCollaborators = collaborators.filter(c => c.permissions.push === true);
        const requestedReviewers = this._prRequestedReviewers();

        for (let collaborator of pushCollaborators) {
            if (requestedReviewers.includes(collaborator.login)) {
                this._log("requested core reviewer: " + collaborator.login);
                return null;
            }
        }

        let reviews = await GH.getReviews(this._number());

        const prAgeMs = new Date() - new Date(this._createdAt());
        const votingDelayMinMs = Config.votingDelayMin() * MsPerHour;
        if (prAgeMs < votingDelayMinMs) {
            this._log("in minimal voting period");
            return votingDelayMinMs - prAgeMs;
        }

        // An array of [{reviewer, date, state}] elements,
        // where 'reviewer' is a core developer, 'date' the review date and 'state' is either
        // 'approved' or 'changes_requested'.
        let usersVoted = [];
        // add the author if needed
        if (pushCollaborators.find(el => el.login === this._prAuthor()))
            usersVoted.push({reviewer: this._prAuthor(), date: this._createdAt(), state: 'approved'});

        // Reviews are returned in chronological order; the list may contain several
        // reviews from the same reviewer, so the actual 'state' is the most recent one.
        for (let review of reviews) {
            const reviewState = review.state.toLowerCase();
            if (reviewState !== 'approved' && reviewState !== 'changes_requested')
                continue;
            if (!pushCollaborators.find(el => el.login === review.user.login))
                continue;
            usersVoted = usersVoted.filter(el => el.reviewer !== review.user.login);
            usersVoted.push({reviewer: review.user.login, date: review.submitted_at, state: reviewState});
        }

        const userRequested = usersVoted.find(el => el.state === 'changes_requested');
        if (userRequested !== undefined) {
            this._log("changes requested by " + userRequested.reviewer);
            return null;
        }
        const usersApproved = usersVoted.filter(u => u.state !== 'changes_requested');
        this.log("approved by " + usersApproved.length + " core developer(s)");

        if (usersApproved.length < Config.necessaryApprovals()) {
            this._log("not approved by necessary " + Config.necessaryApprovals() + " votes");
            return null;
        }
        const votingDelayMaxMs = Config.votingDelayMax() * MsPerHour;
        if (usersApproved.length >= Config.sufficientApprovals() || prAgeMs >= votingDelayMaxMs)
            return 0;
        this._log("in maximum voting period");
        return votingDelayMaxMs - prAgeMs;
    }

    // returns one of:
    // 'pending' if some of required checks are 'pending'
    // 'success' if all of required are 'success'
    // 'error' otherwise
    async _checkStatuses(ref) {

        const requiredContexts = await GH.getProtectedBranchRequiredStatusChecks(this._prBaseBranch());
        // https://developer.github.com/v3/repos/statuses/#get-the-combined-status-for-a-specific-ref
        // state is one of 'failure', 'error', 'pending' or 'success'.
        // We treat both 'failure' and 'error' as an 'error'.
        let combinedStatus = await GH.getStatuses(ref);
        if (requiredContexts.length === 0) {
            this._logError("no required contexts found");
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

    async _hasLabel(label) {
        const labels = await GH.getLabels(this._number());
        return labels.find(lbl => lbl.name === label) !== undefined;
    }

    async _removeLabel(label) {
        try {
            await GH.removeLabel(label, this._number());
        } catch (e) {
            if (e.name === 'ErrorContext' && e.notFound()) {
                this._log("removeLabel: " + label + " not found");
                return;
            }
            throw e;
        }
    }

    async _addLabel(label) {
        let params = Util.commonParams();
        params.number = this._number();
        params.labels = [];
        params.labels.push(label);
        try {
            await GH.addLabels(params);
        } catch (e) {
            // TODO: also extract and check for "already_exists" code:
            // { "message": "Validation Failed", "errors": [ { "resource": "Label", "code": "already_exists", "field": "name" } ] }
            if (e.name === 'ErrorContext' && e.unprocessable()) {
                this._log("addLabel: " + label + " already exists");
                return;
            }
            throw e;
        }
    }

    async _labelCheckMessage(isValid) {
        const label = Config.invalidMessageLabel();
        if (isValid)
            await this._removeLabel(label);
        else
            await this._addLabel(label);
    }

    async _labelMerging() {
        await this._removeLabel(Config.mergeReadyLabel());
        await this._removeLabel(Config.mergeFailedLabel());
        await this._removeLabel(Config.stagingChecksFailedLabel());
        await this._addLabel(Config.mergingLabel());
    }

    async _labelMerged() {
        await this._removeLabel(Config.mergingLabel());
        await this._removeLabel(Config.mergeReadyLabel());
        await this._removeLabel(Config.mergeFailedLabel());
        await this._removeLabel(Config.stagingChecksFailedLabel());
        await this._addLabel(Config.mergedLabel());
    }

    async _labelMergeFailed() {
        await this._removeLabel(Config.mergingLabel());
        await this._removeLabel(Config.mergeReadyLabel());
        await this._addLabel(Config.mergeFailedLabel());
    }

    async _labelStagingFailed() {
        await this._removeLabel(Config.mergingLabel());
        await this._addLabel(Config.stagingChecksFailedLabel());
    }

    async _labelMergeReady() {
        await this._removeLabel(Config.mergingLabel());
        await this._removeLabel(Config.stagingChecksFailedLabel());
        await this._addLabel(Config.mergeReadyLabel());
    }

    // Getters

    // the remainder of the max voting delay (in ms)
    // or 'null', meaning no approvals yet
    delay() { return this._votingDelay; }

    _number() { return this._pr.number; }

    _prHeadSha() { return this._pr.head.sha; }

    _prMessage() {
        return this._pr.title + endOfLine + this._pr.body + endOfLine +
            "(PR #" + this._pr.number + ")";
    }

    _prMessageValid() {
        const lines = this._prMessage().split('\n');
        for (let line of lines) {
            if (line.length > 72)
                return false;
        }
        return true;
    }

    _prRequestedReviewers() {
        let reviewers = [];
        if (this._pr.requested_reviewers) {
            for (let r of this._pr.requested_reviewers)
               reviewers.push(r.login);
        }
        return reviewers;
    }

    _prAuthor() { return this._pr.user.login; }

    _prMergeable() { return this._pr.mergeable; }

    _prBaseBranch() { return this._pr.base.ref; }

    _prBaseBranchPath() { return "heads/" + this._prBaseBranch(); }

    _prOpen() { return this._pr.state === 'open'; }

    _mergingTag() { return Util.MergingTag(this._pr.number); }

    _createdAt() { return this._pr.created_at; }

    _mergePath() { return "pull/" + this._pr.number + "/merge"; }

    _log(msg) {
        Log.Logger.info("PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit) + "):", msg);
    }

    _warnDryRun(msg, opt) {
        const option = opt === undefined ? "dry_run" : opt;
        this._log("skip " + msg + " due to " + option + " option");
    }

    _logError(err, context) {
        assert(context);
        let msg = this._toString() + " " + context;
        Log.LogError(err, msg);
    }

    _toString() {
        let str = "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
        if (this._tagSha !== null)
            str += ", tag: " + this._tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
} // MergeContext

module.exports = MergeContext;

