const fs = require('fs');
const http = require('http');
const createHandler = require('github-webhook-handler');
const nodeGithub = require('github');
const assert = require('assert');
const endOfLine = require('os').EOL;

const MergeFailedLabel = "S-merge-failed";
const AutoChecksFailedLabel = "S-autochecks-failed";
const MergedLabel = "S-merged";
const MergingTag = "T-merging-PR";
const TagRegex = /(refs\/tags\/.*-PR)(\d+)$/;

let PRList = [];
let Context = null;
let Rerun = false;
let Running = false;

class ConfigOptions {
    constructor(fname) {
        const conf = JSON.parse(fs.readFileSync(fname));
        this.githubUser = conf.github_username;
        this.githubToken = conf.github_token;
        this.githubWebhookPath = conf.github_webhook_path;
        this.githubWebhookSecret = conf.github_webhook_secret;
        this.repo = conf.repo;
        this.port = conf.port;
        this.owner = conf.owner;
        this.autoBranch = conf.auto_branch;
        this.dryRun = conf.dry_run;
        this.checksNumber = conf.checks_number;
        this.reviewsNumber = conf.reviews_number;

        const allOptions = Object.values(this);
        for (let v of allOptions) {
            assert(v !==undefined );
        }
    }
}

class MergeContext {
    constructor(pr, aSha, tSha) {
        assert(Context === null);
        this._pr = pr;
        this.autoSha = (aSha === undefined) ? null : aSha;
        this.tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
    }

    prNumber() { return this._pr.number; }

    prHeadSha() { return this._pr.head.sha; }

    prMessage() {
       return this._pr.title + endOfLine + this._pr.body + endOfLine +
           "(PR #" + this._pr.number + ")";
    }

    mergingTag() {
        return "tags/" + MergingTag + this._pr.number;
    }

    mergePath() {
       return "pull/" + this._pr.number + "/merge";
    }

    log(msg) {
        console.log("PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit) + "):", msg);
    }

    toString() {
        let str = "PR" + this._pr.number + "(head: " + this._pr.head.sha.substr(0, this._shaLimit);
        if (this.autoSha !== null)
            str += ", auto: " + this.autoSha.substr(0, this._shaLimit);
        if (this.tagSha !== null)
            str += ", tag: " + this.tagSha.substr(0, this._shaLimit);
        return str + ")";
    }
}

class RejectMsg {
    constructor(msg, method, args) {
        this.errMsg = msg;
        this.method = (method === undefined) ? null : method;
        this.args = (args === undefined) ? null : args;
    }

    toString()
    {
        let msg = this.errMsg;
        if (this.method !== null)
            msg += ", " + this.method;
        if (this.args !== null)
            msg += ", " + JSON.stringify(this.args);
        return msg;
    }
}

const Config = new ConfigOptions('config.js');

const WebhookHandler = createHandler({ path: Config.githubWebhookPath, secret: Config.githubWebhookSecret });
const Github = new nodeGithub({ version: "3.0.0" });
const GithubAuthentication = { type: 'token', username: Config.githubUser, token: Config.githubToken };



startup();

// events

WebhookHandler.on('error', (err) => {
   console.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (ev) => {
    const pr = ev.payload.pull_request;
    console.log("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    run();
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (ev) => {
    const pr = ev.payload.pull_request;
    console.log("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    run();
});

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', (ev) => {
    const e = ev.payload;
    console.log("status event:", e.id, e.sha, e.context, e.state);
    run();
});


// Bot core methods

async function startup() {
    if (!(await getPRList()))
        return;

    http.createServer((req, res) => {
        WebhookHandler(req, res, () => {
            res.statusCode = 404;
            res.end('no such location');
        });
    }).listen(Config.port);

    run();
}

// Requests and process all open PRs.
// Re-loads PR list from Github, if interrupted.
async function run() {
    console.log("running...");
    if (Running) {
        Rerun = true;
        return;
    }
    Running = true;
    let stepRunning = false;
    while (!stepRunning && (PRList.length > 0 || Rerun)) {
        if (Rerun) {
            if (!(await getPRList())) {
                await sleep(1000);
            } else {
                Rerun = false;
            }
            continue;
        }
        stepRunning = await runStep();
        Context = null;
        // If an unexpected error occurred (e.g., connectivity problem),
        // do not re-try immediately. TODO: distinguish such 'unexpected'
        // errors from other situations.
        if (!stepRunning)
            await sleep(1000);
    }
    Running = false;
}

// Selects a PR and 'advances' it towards merge. Returns whether
// the selected PR is still in-process or not(is skipped due to an error
// or successfully merged).
async function runStep() {
    try {
        console.log("running step...");
        let ret = await checkTag();
        if (ret === 'start') {
            const checksOk = await checkMergePreconditions();
            if (!checksOk)
                return false;
            if (Config.dryRun) {
                Context.log("skip start merging due to dry_run option");
                return false;
            }
            return await startMerging();
        } else if (ret === 'continue') {
            if (Config.dryRun) {
                Context.log("skip finish merging due to dry_run option");
                return false;
            }
            if (await finishMerging())
                await cleanupOnSuccess();
            else
                await cleanupOnError();
            return false;
        } else if (ret === 'wait') {
            return true;
        } else {
            assert(ret === 'skip');
            return false;
        }
    } catch (e) {
        logError(e, "run step");
        return false;
    }
}

// Checks whether the current PR has merge tag.
async function loadPRTag() {
   assert(Context);
   try {
       Context.tagSha = await getReference(Context.mergingTag());
       return true;
   } catch (e) {
       logError(e, "No tags found");
       return false;
   }
}

// Loads 'being-in-merge' PR (i.e., with tag corresponding to auto_branch'), if exists.
async function autoPR() {
    const autoSha = await getReference(Config.autoBranch);
    let tags = null;
    try {
       tags = await getTags();
    } catch (e) {
        logError(e, "No tags found");
        return false;
    }

    let prNum = null;
    tags.find( (tag) => {
        if (tag.object.sha === autoSha) {
            let matched = tag.ref.match(TagRegex);
            if (matched)
                prNum = matched[2];
        }
    });

    if (prNum === null) {
        console.log("No merging PR found.");
        return false;
    }

    let autoPr = await getPR(prNum);
    Context = new MergeContext(autoPr, autoSha, autoSha);
    // remove the loaded PR from the global list
    PRList = PRList.filter((pr) => { return pr.number !== Context.prNumber(); });
    return true;
}

// Checks whether the current PR has 'merge tag' (i.e., merge in progress).
// Returns one of:
// 'start': the tag does not exist or is stale; should start merging from scratch.
// 'wait': the tag tests are in progress; should wait for their completion.
// 'continue': the tag tests completed with success; should finish merging.
// 'skip': the tag tests failed, the tag is no stale; do not process this PR.
async function checkTag() {
    assert(PRList.length > 0);

    if (!(await autoPR())) {
       Context = new MergeContext(PRList.shift());
       if (!(await loadPRTag()))
           return 'start';
    }

    assert(Context.tagSha);

    let commitStatus = await getStatuses(Context.tagSha);

    if (commitStatus === 'pending') {
        Context.log("waiting for more auto_branch statuses completing");
        if (!Config.dryRun)
            Context.autoSha = await updateReference(Config.autoBranch, Context.tagSha, true);
        return 'wait';
    } else if ( commitStatus === 'success') {
        Context.log("auto_branch checks succeeded");
        Context.autoSha = await updateReference(Config.autoBranch, Context.tagSha, true);
        return 'continue';
    } else {
        assert(commitStatus === 'error');
        const tagCommit = await getCommit(Context.tagSha);
        const tagPr = await getPR(Context.prNumber()); // to force Github refresh the PR's 'merge' commit
        assert(tagPr.number === Context.prNumber());
        const prMergeSha = await getReference(Context.mergePath());
        const prCommit = await getCommit(prMergeSha);

        let ret = 'skip';
        if (tagCommit.treeSha !== prCommit.treeSha) {
            Context.log("merge commit has changed since last failed attempt");
            if (!Config.dryRun)
                await deleteReference(Context.mergingTag());
            ret = 'start';
        } else {
            Context.log("merge commit has not changed since last failed attempt");
            if (!Config.dryRun)
                await addLabel(AutoChecksFailedLabel);
            ret = 'skip';
        }
        if (!Config.dryRun) {
            // reset auto_branch to master's HEAD
            const masterSha = await getReference("heads/master");
            await updateReference(Config.autoBranch, masterSha, true);
        }
        return ret;
    }
}

// Checks whether the PR is ready for merge (all PR lamps are 'green').
// Also forbids merging the already merged PR (marked with label) or
// if was interrupted by an event ('Rerun' is true).
async function checkMergePreconditions() {
    assert(Context);
    try {
        Context.log("checking merge preconditions...");

        const pr = await getPR(Context.prNumber());
        if (!pr.mergeable) {
            Context.log("not mergeable yet.");
            return false;
        }

        const approved = await getReviews(Context.prNumber());
        if (!approved) {
            Context.log("not approved yet.");
            return false;
        }

        const statusOk = await getStatuses(Context.prHeadSha());
        if (!statusOk) {
            Context.log("statuses not succeeded.");
            return false;
        }

        const labels = await getLabels(Context.prNumber());
        if (markedAsMerged(labels)) {
            Context.log("already merged");
            return false;
        }

        if (Rerun) {
            Context.log("rerun");
            return false;
        }
    } catch (err) {
        logError(err, "Will not merge because");
        return false;
    }

    return true;
}

// Creates a 'merge commit' and adjusts auto_branch.
async function startMerging() {
    assert(Context);
    try
    {
        Context.log("start merging...");

        const masterSha = await getReference("heads/master");

        const mergeSha = await getReference("pull/" + Context.prNumber() + "/merge");

        const mergeCommit = await getCommit(mergeSha);

        const tempCommitSha = await createCommit(mergeCommit.treeSha, Context.prMessage(), [masterSha]);

        Context.tagSha = await createReference(tempCommitSha, "refs/" + Context.mergingTag());

        Context.autoSha = await updateReference(Config.autoBranch, Context.tagSha, true);
        return true;
    } catch (err) {
        logError(err, "Could not start merging auto_branch into master");
        return false;
    }
}

// Does 'ff' merge master into auto_branch.
async function finishMerging() {
    assert(Context);
    assert(Context.autoSha);
    try {
        Context.log("finish merging...");
        // ensure we do ff merge
        await updateReference("heads/master", Context.autoSha, false);
        return true;
    } catch (err) {
        logError(err, "Could not merge auto_branch into master");
        return false;
    }
}

async function cleanupOnSuccess() {
   try {
       Context.log("cleanup on success...");
       await updatePR(Context.prNumber(), 'closed');
       const allLabels = await addLabel(MergedLabel);
       await deleteReference(Context.mergingTag());
       await cleanupLabels(allLabels);
       const masterSha = await getReference("heads/master");
       await updateReference(Config.autoBranch, masterSha, true);
   } catch (err) {
       logError(err, "Could not cleanup on success");
   }
}

async function cleanupOnError() {
   try {
       Context.log("cleanup on error...");
       await deleteReference(Context.mergingTag());
       const allLabels = getLabels(Context.prNumber());
       if (!allLabels.find((label) => { return (label.name === MergeFailedLabel); })) {
           await addLabel(MergeFailedLabel);
       }
       const masterSha = await getReference("heads/master");
       await updateReference(Config.autoBranch, masterSha, true);
   } catch (err) {
       logError(err, "Could not cleanup on error");
   }
}


// helper methods

function sleep(msec) {
    return new Promise((resolve) => setTimeout(resolve, msec));
}

function checkValues(obj, num) {
    if (obj === undefined || Object.keys(obj).length < num)
        return false;
    return (Object.values(obj).find((val) => { return val === false; })) === undefined;
}

function fullyApproved(reviews) {
    return checkValues(reviews, Config.reviewsNumber);
}

function allChecksSuccessful(checks) {
    return checkValues(checks, Config.checksNumber);
}

function markedAsMerged(labels) {
    return (labels.find((label) => {
           return (label.name === MergedLabel); })) !== undefined;
}

function logError(err, details) {
    let msg = "";
    if (Context !== null)
        msg += Context.toString() + " ";
    if (details !== undefined)
        msg += details + ": ";
    msg += err.toString();
    console.error(msg);
}

function logApiResult(method, params, result) {
    console.log(method, "succeeded, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}


// Promisificated node-github wrappers

// common parameters for all API calls
function commonParams() {
    return {
        owner: Config.owner,
        repo: Config.repo
    };
}

async function getPRList() {
    try {
        await requestPRList();
        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

function requestPRList() {
    PRList = [];
    let params = commonParams();
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getAll(params, (err, res) => {
            if (err) {
                reject(new RejectMsg(err, getPRList.name, params));
                return;
            }
            const result = res.data.length;
            logApiResult(getPRList.name, params, result);
            PRList = res.data;
            resolve(true);
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
               reject(new RejectMsg(err, getLabels.name, params));
               return;
           }
           const result = {labels: res.data.length};
           logApiResult(getLabels.name, params, result);
           resolve(res.data);
        });
    });
}

async function getPR(prNum) {
    const max = 64 * 1000 + 1; // ~2 min. overall
    for (let d = 1000; d < max; d *= 2) {
        let pr = await requestPR(prNum);
        if (pr.mergeable !== null)
            return pr;
        console.log("PR" + prNum + ": Github still caluclates mergeable status. Will retry in " + (d/1000) + " seconds");
        await sleep(d);
    }
    return Promise.reject(new RejectMsg("Github could not calculate mergeable status",
                getPR.name, {pr: prNum}));
}

function requestPR(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.get(params, (err, pr) => {
            if (err) {
                reject(new RejectMsg(err, requestPR.name, params));
                return;
            }
            const result = {mergeable: pr.data.mergeable};
            logApiResult(requestPR.name, params, result);
            resolve(pr.data);
       });
   });
}

function getReviews(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getReviews(params, (err, res) => {
            if (err) {
                reject(new RejectMsg(err, getReviews.name, params));
                return;
            }
            let reviews = {};
            for (let review of res.data) {
                // Reviews are returned in chronological order
                if (review.state.toLowerCase() === "approved")
                    reviews[review.user.login] = true;
            }
            const result = fullyApproved(reviews);
            logApiResult(getReviews.name, params, {approved: result});
            resolve(result);
        });
    });
}

function getStatuses(ref) {
    let params = commonParams();
    params.ref = ref;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.getStatuses(params, (err, res) => {
            if (err) {
                reject(new RejectMsg(err, getStatuses.name, params));
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
            if (Object.keys(checks).length < Config.checksNumber)
                result = 'pending';
            else
                result = allChecksSuccessful(checks) ? 'success' : 'error';
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
                reject(new RejectMsg(err, getCommit.name, params));
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
                reject(new RejectMsg(err, createCommit.name, params));
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
                reject(new RejectMsg(err, getReference.name, params));
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
                reject(new RejectMsg(err, getTags.name, params));
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
                reject(new RejectMsg(err, createReference.name, params));
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
                reject(new RejectMsg(err, updateReference.name, params));
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
                reject(new RejectMsg(err, deleteReference.name, params));
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
            reject(new RejectMsg(err, updatePR.name, params));
            return;
        }
        const result = {state: res.data.state};
        logApiResult(updatePR.name, params, result);
        resolve(result);
     });
  });
}

async function addLabel(label) {
    assert(Context);
    let params = commonParams();
    params.number = Context.prNumber();
    params.labels = [];
    params.labels.push(label);
    return await addLabels(params);
}

async function cleanupLabels(allLabels) {
    let params = commonParams();
    params.number = Context.prNumber();

    if (allLabels.find((label) => { return (label.name === MergeFailedLabel); })) {
        params.name = MergeFailedLabel;
        await removeLabel(params);
    }

    if (allLabels.find((label) => { return (label.name === AutoChecksFailedLabel); })) {
        params.name = AutoChecksFailedLabel;
        await removeLabel(params);
    }
}

function addLabels(params) {
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.issues.addLabels(params, (err, res) => {
        if (err) {
            reject(new RejectMsg(err, addLabels.name, params));
            return;
        }
        const result = {added: true};
        logApiResult(addLabels.name, params, result);
        resolve(res.data);
     });
  });
}

function removeLabel(params) {
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.issues.removeLabel(params, (err) => {
         if (err) {
            reject(new RejectMsg(err, addLabels.name, params));
            return;
         }
         const result = {removed: true};
         logApiResult(removeLabel.name, params, result);
         resolve(result);
     });
  });
}

