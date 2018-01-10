const assert = require('assert');
const Config = require('./Config.js');
const Log = require('./Logger.js');
const Logger = Log.Logger;
const GH = require('./GitHubUtil.js');
const Merger = require('./Main.js');
const Util = require('./Util.js');
const MergeContext = require('./MergeContext.js');

// Gets PR list from GitHub and processes some/all PRs from this list.
class MergeStep {

    constructor() {
        this.total = 0;
        this.errors = 0;
    }

    // Gets PR list from GitHub and processes them one by one.
    // Returns if either all PRs have been processed(merged or skipped), or
    // there is a PR still-in-merge.
    async runStep() {
        Logger.info("runStep running");
        try {
            if (await this.resumeCurrent())
                return; // still in-process
        } catch (e) {
            Log.logError(e, "Exception");
            this.errors++;
        }

        const prList = await GH.getPRList();
        prList.sort((pr1, pr2) => { return new Date(pr1.created_at) - new Date(pr2.created_at); });

        while (prList.length) {
            try {
                let context = new MergeContext(prList.shift());
                this.total++;
                const running = await context.runContext();
                if (running)
                    break;
                else if (!Merger.planned() && context.timeToWait)
                    Merger.plan(context.timeToWait, context.number());
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

        this.total = 1;

        const commitStatus = await context.checkStatuses(context.tagSha);

        if (commitStatus === 'pending') {
            Logger.info("waiting for more staging checks completing");
            return true;
        } else if (commitStatus === 'success') {
            Logger.info("staging checks succeeded");
            // TODO: log whether that staging_branch points to us.
            // return 'continue';
            return await context.runContext();
        } else {
            assert(commitStatus === 'failure');
            return false;
        }
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

        let stagingPr = null;
        try {
            stagingPr = await GH.getPR(prNum, false);
            if (stagingPr.state !== 'open') {
                Logger.error("PR" + prNum + " was unexpectedly closed");
                if (!Config.dryRun())
                    await GH.deleteReference(tagName);
                return null;
            }
        } catch (e) {
            if (!Config.dryRun())
                await GH.deleteReference(tagName);
            throw e;
        }

        return new MergeContext(stagingPr, stagingSha);
    }

    logStatistics() {
        Logger.info("Merge step finished. Total PRs processed: " + this.total + ", skipped due to errors: " + this.errors);
    }
} // MergeStep


module.exports = MergeStep;


