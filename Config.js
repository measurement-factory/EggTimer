const fs = require('fs');
const assert = require('assert');

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
        this._necessaryApprovals = conf.necessary_approvals;
        this._sufficientApprovals = conf.sufficient_approvals;
        assert(this._sufficientApprovals > 1);
        this._votingDelayMax = conf.voting_delay_max; // in hours
        this._votingDelayMin = conf.voting_delay_min; // in hours
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
    necessaryApprovals() { return this._necessaryApprovals; }
    sufficientApprovals() { return this._sufficientApprovals; }
    votingDelayMax() { return this._votingDelayMax; }
    votingDelayMin() { return this._votingDelayMin; }
    loggerType() { return this._loggerType; }
    loggerPath() { return this._loggerPath; }
    loggerPeriod() { return this._loggerPeriod; }
    loggerCount() { return this._loggerCount; }

    // fast-forward merge failed
    mergeFailedLabel() { return "S-merge-failed"; }
    // some of required staging checks failed
    stagingChecksFailedLabel() { return "S-staging-checks-failed"; }
    // fast-forward merge succeeded
    mergedLabel() { return "S-merged"; }
    // merge started (tag and staging branch successfully adjusted)
    mergingLabel() { return "S-merging"; }
    // Merge succeeded up to fast-forward step. For testing purpose.
    mergeReadyLabel() { return "S-merge-ready"; }
    // PR message does not satisfy to requirements (e.g., lines
    // should have <= 72 characters)
    invalidMessageLabel() { return "S-invalid-message"; }
}

const configFile = process.argv.length > 2 ? process.argv[2] : './config.json';
const Config = new ConfigOptions(configFile);

module.exports = Config;
