const fs = require('fs');
const timestring = require('timestring');
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
        this._mergedRun = conf.merged_run;
        this._necessaryApprovals = conf.necessary_approvals;
        this._sufficientApprovals = conf.sufficient_approvals;
        assert(this._sufficientApprovals > 1);
        this._votingDelayMax = timestring(conf.voting_delay_max, 'ms');
        this._votingDelayMin = timestring(conf.voting_delay_min, 'ms');
        this._loggerParams = conf.logger_params;

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
    stagingBranch() { return "heads/" + this._stagingBranch; }
    dryRun() { return this._dryRun; }
    mergedRun() { return this._mergedRun; }
    necessaryApprovals() { return this._necessaryApprovals; }
    sufficientApprovals() { return this._sufficientApprovals; }
    votingDelayMax() { return this._votingDelayMax; }
    votingDelayMin() { return this._votingDelayMin; }
    loggerParams() { return this._loggerParams; }

    // fast-forward merge failed
    failedOtherLabel() { return "M-failed-other"; }
    // some of required staging checks failed
    failedStagingChecksLabel() { return "M-failed-staging-checks"; }
    // fast-forward merge succeeded
    mergedLabel() { return "M-merged"; }
    // merge started (tag and staging branch successfully adjusted)
    waitingStagingChecksLabel() { return "M-waiting-staging-checks"; }
    // passed staging checks (in staged-run mode)
    passedStagingChecksLabel() { return "M-passed-staging-checks"; }
    // future commit message violates requirements
    failedDescriptionLabel() { return "M-failed-description"; }
}

const configFile = process.argv.length > 2 ? process.argv[2] : './config.json';
const Config = new ConfigOptions(configFile);

module.exports = Config;
