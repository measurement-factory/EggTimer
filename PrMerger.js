const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');

// Gets PR list from GitHub and processes some/all PRs from this list.
class PrMerger {

    constructor() {
        this.total = 0;
        this.errors = 0;
        // the number of milliseconds to be re-run in
        this.rerunIn = null;
    }

    // Gets PR list from GitHub and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async runStep() {
        Logger.info("runStep running");
        if (await this.resumeCurrent())
            return true; // still in-process

        const prList = await GH.getPRList();
        prList.sort((pr1, pr2) => { return new Date(pr1.created_at) - new Date(pr2.created_at); });

        while (prList.length) {
            try {
                const pr = prList.shift();
                let context = new MergeContext(pr);
                this.total++;
                if (await context.startProcessing())
                    return true;
                // the first found will give us the minimal delay
                if (this.rerunIn === null && context.delay())
                    this.rerunIn = context.delay();
            } catch (e) {
                this.errors++;
                if (prList.length)
                    Log.logError(e, "PrMerger.runStep");
                else
                    throw e;
            }
        }
        return false;
    }

    // Looks for the being-in-merge PR and resumes its processing, if found.
    // Returns whether we are still processing the current PR (so that we can
    // not start the next one):
    // 'true': current PR was found and its processing not yet finished.
    // 'false': the PR was found and it's processing was finished (succeeded
    // or failed due to an error).
    async resumeCurrent() {
        const context = await this._current();
        if (!context)
            return false;
        this.total = 1;
        const finished = await context.finishProcessing();
        return !finished;
    }

    // Loads 'being-in-merge' PR, if exists (the PR has tag and staging_branch points to the tag).
    async _current() {
        Logger.info("Looking for current PR...");
        const stagingSha = await GH.getReference(Config.stagingBranch());
        // request all repository tags
        let tags = await GH.getTags();
        // search for a tag, the staging_branch points to,
        // and parse out PR number from the tag name
        const tag = tags.find((t) => { return (t.object.sha === stagingSha) && Util.MatchTag(t.ref); });
        if (tag === undefined) {
            Logger.info("No current PR found.");
            return null;
        }

        const parsed = Util.ParseTag(tag.ref);
        Logger.info("Current PR is " + parsed.prNum);
        assert(parsed.tagName === Util.MergingTag(parsed.prNum));

        let stagingPr = await GH.getPR(parsed.prNum, false);
        if (stagingPr.state !== 'open') {
            Logger.error("PR" + parsed.prNum + " was unexpectedly closed");
            if (!Config.dryRun())
                await GH.deleteReference(parsed.tagName);
            return null;
        }

        return new MergeContext(stagingPr, stagingSha);
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger


module.exports = PrMerger;


