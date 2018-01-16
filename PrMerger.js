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
        // the number of milliseconds to be re-run in,
        // zero means re-run immediately
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
                let context = new MergeContext(prList.shift());
                this.total++;
                if (await context.startProcessing())
                    return true;
                // the first found will give us the minimal delay
                if (this.rerunIn === null && context.delay())
                    this.rerunIn = context.delay();
            } catch (e) {
                this.errors++;
                if (!prList.length)
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
        Logger.info("current running");
        const stagingSha = await GH.getReference(Config.stagingBranch());
        let tags = null;
        // request all repository tags
        tags = await GH.getTags();
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
                const matched = tag.ref.match(Util.TagRegex);
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
        assert(tagName === Util.MergingTag(prNum));

        let stagingPr = await GH.getPR(prNum, false);
        if (stagingPr.state !== 'open') {
            Logger.error("PR" + prNum + " was unexpectedly closed");
            if (!Config.dryRun())
                await GH.deleteReference(tagName);
            return null;
        }

        return new MergeContext(stagingPr, stagingSha);
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // PrMerger


module.exports = PrMerger;


