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
        this._githubUser = conf.github_username;
        this._githubToken = conf.github_token;
        this._githubWebhookPath = conf.github_webhook_path;
        this._githubWebhookSecret = conf.github_webhook_secret;
        this._repo = conf.repo;
        this._port = conf.port;
        this._owner = conf.owner;
        this._autoBranch = conf.auto_branch;
        this._dryRun = conf.dry_run;
        this._reviewsNumber = conf.reviews_number;

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
    port() { return this._port; }
    owner() { return this._owner; }
    autoBranch() { return this._autoBranch; }
    dryRun() { return this._dryRun; }
    reviewsNumber() { return this._reviewsNumber; }
}

class MergeContext {
    constructor(pr, aSha, tSha) {
        assert(Context === null);
        this._pr = pr;
        this.autoSha = (aSha === undefined) ? null : aSha;
        this.tagSha = (tSha === undefined) ? null : tSha;
        this._shaLimit = 6;
    }

    refreshPR(pr) {
        assert(pr.number === this._pr.number);
        this._pr = pr;
    }

    prNumber() { return this._pr.number; }

    prHeadSha() { return this._pr.head.sha; }

    prMessage() {
        return this._pr.title + endOfLine + this._pr.body + endOfLine +
            "(PR #" + this._pr.number + ")";
    }

    prMergeable() { return this._pr.mergeable; }

    prBaseBranch() { return this._pr.base.ref; }

    mergingTag() { return "tags/" + MergingTag + this._pr.number; }

    tagsConsistent() {
        if (this.autoSha !== null)
            return this.autoSha === this.tagSha;
        return true;
    }

    mergePath() { return "pull/" + this._pr.number + "/merge"; }

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
    constructor(err, method, args) {
        this.err = err;
        this.method = (method === undefined) ? null : method;
        this.args = (args === undefined) ? null : args;
    }

    toString()
    {
        let msg = "";
        if (this.method !== null)
            msg = this.method;
        if (msg.length)
            msg += ", ";
        msg += "Error: " + JSON.stringify(this.err);
        if (this.args !== null)
            msg += ", params: " + JSON.stringify(this.args);
        return msg;
    }
}

const Config = new ConfigOptions('config.js');

const WebhookHandler = createHandler({ path: Config.githubWebhookPath(), secret: Config.githubWebhookSecret() });
const Github = new nodeGithub({ version: "3.0.0" });
const GithubAuthentication = { type: 'token', username: Config.githubUser(), token: Config.githubToken() };


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
    http.createServer((req, res) => {
        WebhookHandler(req, res, () => {
            res.statusCode = 404;
            res.end('no such location');
        });
    }).listen(Config.port());
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
    let stepOk = false;
    do {
        Rerun = false;
        stepOk = await runStep();
    } while (Rerun);
    Running = false;
    if (!stepOk) {
        const min = 10;
        console.error("run: previous step finished unexpectedly. Automatically re-try in " + min + " minutes.");
        setTimeout(run, min * 60 * 1000);
    }
}

// Selects a PR and 'advances' it towards merge. Returns whether
// the selected PR is still in-process or not(is skipped due to an error
// or successfully merged).
async function runStep() {
    let total = 0;
    let errors = 0;
    try {
        console.log("running step...");
        await getPRList();
        while (PRList.length > 0) {
           Context = null;
           await selectPR(); // picks one element from PRList
           total++;
           try {
               if (await processPR())
                   break;
           } catch (err) {
               errors++;
               logError(err, "processPR");
           }
        }
    } catch (e) {
        logError(e, "run step");
        return false;
    } finally {
        console.log("runStep: Total PRs processed: " + total + ", skipped due to errors: " + errors);
    }
    return true;
}

async function processPR() {
    assert(Context && Context.tagsConsistent());
    if (!Context.autoSha)
        await loadPRTag();

    let checkTagResult = null;
    if (Context.tagSha)
        checkTagResult = await checkTag();

    if (!checkTagResult || checkTagResult === 'start') {
        if (!(await checkMergePreconditions()))
            return false;
        if (Config.dryRun()) {
            Context.log("skip start merging due to dry_run option");
            return false;
        }
        if (!(await startMerging()))
            return false;
        // merging started successfully
        return true;
    }

    assert(checkTagResult);

    if (checkTagResult === 'continue') {
        if (Config.dryRun()) {
            Context.log("skip finish merging due to dry_run option");
            return false;
        }
        const merged = await finishMerging();
        await cleanup(merged);
        // merging finished successfully
        return false;
    } else if (checkTagResult === 'wait') {
        // still waiting for auto checks
        return true;
    } else {
        // skip this PR
        assert(checkTagResult === 'skip');
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
       if (e.err.code !== 404)
           throw e;

       Context.log(Context.mergingTag() + " not found");
       return false;
   }
}

// Loads 'being-in-merge' PR (i.e., with tag corresponding to auto_branch'), if exists.
async function autoPR() {
    const autoSha = await getReference(Config.autoBranch());
    let tags = null;
    try {
       tags = await getTags();
    } catch (e) {
        if (e.err.code !== 404)
           throw e;

        Context.log("No tags found");
        return false;
    }

    let prNum = null;
    tags.find( (tag) => {
        if (tag.object.sha === autoSha) {
            const matched = tag.ref.match(TagRegex);
            if (matched)
                prNum = matched[2];
        }
    });

    if (prNum === null) {
        console.log("No merging PR found.");
        return false;
    }

    const autoPr = await getPR(prNum);
    Context = new MergeContext(autoPr, autoSha, autoSha);
    // remove the loaded PR from the global list
    PRList = PRList.filter((pr) => { return pr.number !== Context.prNumber(); });
    return true;
}

async function selectPR() {
    assert(PRList.length > 0);
    if (!(await autoPR()))
       Context = new MergeContext(PRList.shift());
}

// Checks whether the current PR has 'merge tag' (i.e., merge in progress).
// Returns one of:
// 'start': the tag does not exist or is stale; should start merging from scratch.
// 'wait': the tag tests are in progress; should wait for their completion.
// 'continue': the tag tests completed with success; should finish merging.
// 'skip': the tag tests failed, the tag is no stale; do not process this PR.
async function checkTag() {
    assert(Context.tagSha);

    const contexts = await getProtectedBranchRequiredStatusChecks(Context.prBaseBranch());

    const commitStatus = await getStatuses(Context.tagSha, contexts);

    if (commitStatus === 'pending') {
        Context.log("waiting for more auto_branch statuses completing");
        if (!Config.dryRun())
            Context.autoSha = await updateReference(Config.autoBranch(), Context.tagSha, true);
        return 'wait';
    } else if ( commitStatus === 'success') {
        Context.log("auto_branch checks succeeded");
        Context.autoSha = await updateReference(Config.autoBranch(), Context.tagSha, true);
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
            if (!Config.dryRun())
                await deleteReference(Context.mergingTag());
            ret = 'start';
        } else {
            Context.log("merge commit has not changed since last failed attempt");
            if (!Config.dryRun())
                await addLabel(AutoChecksFailedLabel);
            ret = 'skip';
        }
        if (!Config.dryRun()) {
            // reset auto_branch to master's HEAD
            const masterSha = await getReference("heads/master");
            await updateReference(Config.autoBranch(), masterSha, true);
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
        Context.refreshPR(pr);

        if (!Context.prMergeable()) {
            Context.log("not mergeable yet.");
            return false;
        }

        const collaborators = await getCollaborators();
        const pushCollaborators = collaborators.filter((c) => { return c.permissions.push === true; });
        const approved = await getReviews(Context.prNumber(), pushCollaborators);
        if (!approved) {
            Context.log("not approved yet.");
            return false;
        }

        const contexts = await getProtectedBranchRequiredStatusChecks(Context.prBaseBranch());

        const statusOk = await getStatuses(Context.prHeadSha(), contexts);
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

        Context.autoSha = await updateReference(Config.autoBranch(), Context.tagSha, true);
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

async function cleanup(merged) {
    if (merged)
        await cleanupOnSuccess();
    else
        await cleanupOnError();
}

async function cleanupOnSuccess() {
   try {
       Context.log("cleanup on success...");
       await updatePR(Context.prNumber(), 'closed');
       const allLabels = await addLabel(MergedLabel);
       await deleteReference(Context.mergingTag());
       await cleanupLabels(allLabels);
       const masterSha = await getReference("heads/master");
       await updateReference(Config.autoBranch(), masterSha, true);
   } catch (err) {
       logError(err, "Could not cleanup on success");
   }
}

async function cleanupOnError() {
   try {
       Context.log("cleanup on error...");
       await deleteReference(Context.mergingTag());
       const allLabels = await getLabels(Context.prNumber());
       if (!allLabels.find((label) => { return (label.name === MergeFailedLabel); })) {
           await addLabel(MergeFailedLabel);
       }
       const masterSha = await getReference("heads/master");
       await updateReference(Config.autoBranch(), masterSha, true);
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
    if ('stack' in err)
        msg += err.stack.toString();
    console.error(msg);
}

function logApiResult(method, params, result) {
    console.log(method, "OK, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}


// Promisificated node-github wrappers

// common parameters for all API calls
function commonParams() {
    return {
        owner: Config.owner(),
        repo: Config.repo()
    };
}

function getPRList() {
    PRList = [];
    const params = commonParams();
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
        const pr = await requestPR(prNum);
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

function getReviews(prNum, pushCollaborators) {
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

            let approvals = 0;
            for (let pushCollaborator of pushCollaborators) {
                 if (Object.keys(reviews).find((key) => { return key === pushCollaborator.login; })) {
                     approvals++;
                 }
            }

            const result = (approvals >= Config.reviewsNumber());
            logApiResult(getReviews.name, params, {approved: result});
            resolve(result);
        });
    });
}

function getStatuses(ref, requiredContexts) {
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
            for (let requiredContext of requiredContexts) {
                 if (Object.keys(checks).find((key) => { return key === requiredContext; }) === undefined) {
                    result = 'pending';
                    break;
                 }
            }
            if (!result)
                result = checkValues(checks, requiredContexts.length) ? 'success' : 'error';

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

function getProtectedBranchRequiredStatusChecks(branch) {
    let params = commonParams();
    params.branch = branch;
    return new Promise( (resolve, reject) => {
      Github.authenticate(GithubAuthentication);
      Github.repos.getProtectedBranchRequiredStatusChecks(params, (err, res) => {
          if (err) {
             reject(new RejectMsg(err, getProtectedBranchRequiredStatusChecks.name, params));
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
      Github.authenticate(GithubAuthentication);
      Github.repos.getCollaborators(params, (err, res) => {
          if (err) {
             reject(new RejectMsg(err, getCollaborators.name, params));
             return;
          }
          const result = {collaborators: res.data.length};
          logApiResult(getCollaborators.name, params, result);
          resolve(res.data);
      });
    });
}

