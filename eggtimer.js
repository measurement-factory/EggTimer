const fs = require('fs');
const http = require('http');
const createHandler = require('github-webhook-handler');
const nodeGithub = require('github');
const Promise = require("bluebird");
const assert = require('assert');
const endOfLine = require('os').EOL;

const Config = JSON.parse(fs.readFileSync('config.js'));
const WebhookHandler = createHandler({ path: Config.github_webhook_path, secret: Config.github_webhook_secret });
const Github = new nodeGithub({ version: "3.0.0" });
const GithubAuthentication = { type: 'token', username: Config.github_username, token: Config.github_token };

const MergeFailedLabel = "S-merge-failed";
const AutoChecksFailedLabel = "S-autochecks-failed";
const MergedLabel = "S-merged";
const MergingTag = "T-merging-PR";
const TagRegex = /(refs\/tags\/.*-PR)(\d+)$/;

let PRList = [];
let currentContext = null;
let Rerun = false;
let Running = false;


startup();

// events

http.createServer((req, res) => {
    WebhookHandler(req, res, () => {
        res.statusCode = 404;
        res.end('no such location');
    });
}).listen(Config.port);

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
    await getPRList();
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
            Rerun = false;
            await getPRList();
            continue;
        }
        console.log("running step...");
        stepRunning = await runStep();
        currentContext = null;
    }
    Running = false;
}

// Selects a PR and 'advances' it towards merge. Returns whether
// the selected PR is still in-process or not(is skipped due to an error
// or successfully merged).
async function runStep() {
    try {
        let ret = await checkTag();
        if (ret === 'start') {
            const checksOk = await checkMergePreconditions();
            if (!checksOk)
                return false;
            if (Config.dry_run) {
                console.log(contextToStr(), "skip start merging due to dry_run option");
                return false;
            }
            return await startMerging();
        } else if (ret === 'continue') {
            if (Config.dry_run) {
                console.log(contextToStr(), "skip finish merging due to dry_run option");
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
        logError(e);
        return false;
    }
}

// Checks whether the current PR has merge tag.
async function loadPRTag() {
   assert(currentContext);
   try {
       currentContext.tagSha = await getReference(mergingTag(currentContext.pr.number));
       return true;
   } catch (e) {
       logError(e, "No tags found:");
       return false;
   }
}

// Loads 'being-in-merge' PR (i.e., with tag corresponding to auto_branch'), if exists.
async function autoPR() {
    const autoSha = await getReference("heads/" + Config.auto_branch);
    let tags = null;
    try {
       tags = await getTags();
    } catch (e) {
        logError(e, "No tags found:");
        return null;
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
        return null;
    }

    let autoPr = await getPR(prNum);
    createContext(autoPr);
    currentContext.autoSha = autoSha;
    currentContext.tagSha = autoSha;
    // remove the loaded PR from the global list
    PRList = PRList.filter((pr) => { return pr.number !== currentContext.pr.number; });
    return prNum;
}

// Checks whether the current PR has 'merge tag' (i.e., merge in progress).
// Returns one of:
// 'start': the tag does not exist or is stale; should start merging from scratch.
// 'wait': the tag tests are in progress; should wait for their completion.
// 'continue': the tag tests completed with success; should finish merging.
// 'skip': the tag tests failed, the tag is no stale; do not process this PR.
async function checkTag() {
    assert(PRList.length > 0);

    const prNum = await autoPR();
    if (prNum === null) {
       createContext(PRList.shift());
       if (!(await loadPRTag()))
           return 'start';
    }

    assert(currentContext.tagSha);

    let commitStatus = await getStatuses(currentContext.tagSha);

    if (commitStatus === 'pending') {
        console.log("PR" + prNum + ": waiting for more auto_branch statuses completing");
        if (!Config.dry_run)
            currentContext.autoSha = await updateReference("heads/" + Config.auto_branch, currentContext.tagSha, true);
        return 'wait';
    } else if ( commitStatus === 'success') {
        console.log("PR" + prNum + " auto_branch checks succeeded");
        currentContext.autoSha = await updateReference("heads/" + Config.auto_branch, currentContext.tagSha, true);
        return 'continue';
    } else {
       assert(commitStatus === 'error');
       const tagCommit = await getCommit(currentContext.tagSha);
       const tagPr = await getPR(prNum); // to force Github refresh the PR's 'merge' commit
       assert(tagPr.number === prNum);
       const prMergeSha = await getReference("pull/" + prNum + "/merge");
       const prCommit = await getCommit(prMergeSha);

       let ret = 'skip';
       if (tagCommit.treeSha !== prCommit.treeSha) {
           console.log("PR" + prNum + ": merge commit has changed since last failed attempt");
           if (!Config.dry_run)
               await deleteReference(mergingTag(prNum));
           ret = 'start';
       } else {
           console.log("PR" + prNum + ": merge commit has not changed since last failed attempt");
           if (!Config.dry_run)
               await addLabel(AutoChecksFailedLabel);
           ret = 'skip';
       }
       if (!Config.dry_run) {
           // reset auto_branch to master's HEAD
           const masterSha = await getReference("heads/master");
           await updateReference("heads/" + Config.auto_branch, masterSha, true);
       }
       return ret;
    }
}

// Checks whether the PR is ready for merge (all PR lamps are 'green').
// Also forbids merging the already merged PR (marked with label) or
// if was interrupted by an event ('Rerun' is true).
async function checkMergePreconditions() {
    assert(currentContext);
    try {

        const pr = await getPR(currentContext.pr.number);
        if (!pr.mergeable) {
            console.log(contextToStr(), "not mergeable yet.");
            return false;
        }

        const approved = await getReviews(currentContext.pr.number);
        if (!approved) {
            console.log(contextToStr(), "not approved yet.");
            return false;
        }

        const statusOk = await getStatuses(currentContext.pr.head.sha);
        if (!statusOk) {
            console.log(contextToStr(), "statuses not succeeded.");
            return false;
        }

        const labels = await getLabels(currentContext.pr.number);
        if (markedAsMerged(labels)) {
            console.log(contextToStr(), "already merged");
            return false;
        }

        if (Rerun) {
            console.log(contextToStr(), "rerun");
            return false;
        }
    } catch (err) {
        logError(err, "will not merge because:");
        return false;
    }

    return true;
}

// Creates a 'merge commit' and adjusts auto_branch.
async function startMerging() {
    assert(currentContext);
    console.log(contextToStr(), "start merging");
    try
    {
        const masterSha = await getReference("heads/master");

        const mergeSha = await getReference("pull/" + currentContext.pr.number.toString() + "/merge");

        const mergeCommit = await getCommit(mergeSha);

        const message = currentContext.pr.title + endOfLine + currentContext.pr.body +
                        endOfLine + "(PR #" + currentContext.pr.number.toString() + ")";
        const tempCommitSha = await createCommit(mergeCommit.treeSha, message, [masterSha]);

        currentContext.tagSha = await createReference(tempCommitSha, "refs/" + mergingTag(currentContext.pr.number));

        currentContext.autoSha = await updateReference("heads/" + Config.auto_branch, currentContext.tagSha, true);
        return true;
    } catch (err) {
        logError(err, "Could not start merging auto_branch into master. Details:");
        return false;
    }
}

// Does 'ff' merge master into auto_branch.
async function finishMerging() {
    assert(currentContext);
    assert(currentContext.autoSha);
    console.log(contextToStr(), "finish merging");
    try {
        // ensure we do ff merge
        await updateReference("heads/master", currentContext.autoSha, false);
        return true;
    } catch (err) {
        logError(err, "Could not merge auto_branch into master. Details:");
        return false;
    }
}

async function cleanupOnSuccess() {
   try {
       await updatePR(currentContext.pr.number, 'closed');
       const allLabels = await addLabel(MergedLabel);
       await deleteReference(mergingTag(currentContext.pr.number));
       await cleanupLabels(allLabels);
       const masterSha = await getReference("heads/master");
       await updateReference("heads/" + Config.auto_branch, masterSha, true);
   } catch (err) {
       logError(err, "Could not cleanup on success. Details:");
   }
}

async function cleanupOnError() {
   try {
       await deleteReference(mergingTag(currentContext.pr.number));
       const allLabels = getLabels(currentContext.pr.number);
       if (!allLabels.find((label) => { return (label.name === MergeFailedLabel); })) {
           await addLabel(MergeFailedLabel);
       }
       const masterSha = await getReference("heads/master");
       await updateReference("heads/" + Config.auto_branch, masterSha, true);
   } catch (err) {
       logError(err, "Could not cleanup on error. Details:");
   }
}


// helper methods

function createContext(pr) {
    assert(currentContext === null);
    currentContext = {};
    currentContext.pr = pr;
    currentContext.autoSha = null;
    currentContext.tagSha = null;
}

function mergingTag(prNum) {
    return "tags/" + MergingTag + prNum;
}

function commonParams() {
    return {
        owner: Config.owner,
        repo: Config.repo
    };
}

function checkValues(obj, num) {
    if (obj === undefined || Object.keys(obj).length < num)
        return false;
    return (Object.values(obj).find((val) => { return val === false; })) === undefined;
}

function fullyApproved(reviews) {
    return checkValues(reviews, Config.reviews_number);
}

function allChecksSuccessful(checks) {
    return checkValues(checks, Config.checks_number);
}

function markedAsMerged(labels) {
    return (labels.find((label) => {
           return (label.name === MergedLabel); })) !== undefined;
}

function rejectArg(msg, method = null, params = null) {
    return {errMsg: msg, method: method, args: params};
}

function rejectStr(context)
{
    let msg = context.errMsg;
    if (context.method !== null)
        msg += ", " + context.method;
    if (context.args !== null)
        msg += ", " + JSON.stringify(context.args);
    return msg;
}

function contextToStr()
{
    const n = 6; // limit displaying sha length
    let str = "PR" + currentContext.pr.number + "(head: " + currentContext.pr.head.sha.substr(0, n);
    if (currentContext.autoSha !== null)
        str += ", auto: " + currentContext.autoSha.substr(0, n);
    if (currentContext.tagSha !== null)
        str += ", tag: " + currentContext.tagSha.substr(0, n);
    return str + ")";
}

function logError(err, msg) {
    if ('errMsg' in err)
        console.error(contextToStr(), msg, rejectStr(err));
    else
        console.error(err);
}

function logResolved(method, params, result) {
    console.log(method, "succeeded, params:", JSON.stringify(params), "result:", JSON.stringify(result));
}


// Promisificated node-github wrappers

function getPRList() {
    PRList = [];
    let params = commonParams();
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getAll(params, (err, res) => {
            if (err) {
                reject(rejectArg(err, getPRList.name, params));
                return;
            }
            const result = res.data.length;
            logResolved(getPRList.name, params, result);
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
               reject(rejectArg(err, getLabels.name, params));
               return;
           }
           const result = {labels: res.data.length};
           logResolved(getLabels.name, params, result);
           resolve(res.data);
        });
    });
}

function getPR(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
            getMergeablePR(params, resolve, reject);
    });
}

function getMergeablePR(params, resolve, reject) {
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.get(params, (err, pr) => {
        if (err) {
            reject(rejectArg(err, getMergeablePR.name, params));
            return;
        }
        const delay = 1000;
        if (pr.data.mergeable !== null) {
            logResolved(getMergeablePR.name, params, {mergeable: pr.data.mergeable});
            resolve(pr.data);
            return;
        }
        console.log("PR" + params.number + ": Github still calculates mergeable flag, will retry in " + delay + " msec delay");
        setTimeout(getMergeablePR, delay, params, resolve, reject);
    });
}

function getReviews(prNum) {
    let params = commonParams();
    params.number = prNum;
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getReviews(params, (err, res) => {
            if (err) {
                reject(rejectArg(err, getReviews.name, params));
                return;
            }
            let reviews = {};
            for (let review of res.data) {
                // Reviews are returned in chronological order
                if (review.state.toLowerCase() === "approved")
                    reviews[review.user.login] = true;
            }
            const result = fullyApproved(reviews);
            logResolved(getReviews.name, params, {approved: result});
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
                reject(rejectArg(err, getStatuses.name, params));
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
            if (Object.keys(checks).length < Config.checks_number)
                result = 'pending';
            else
                result = allChecksSuccessful(checks) ? 'success' : 'error';
            logResolved(getStatuses.name, params, {checks: result});
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
                reject(rejectArg(err, getCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha, treeSha: res.data.tree.sha, message: res.data.message};
            logResolved(getCommit.name, params, result);
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
                reject(rejectArg(err, createCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha};
            logResolved(createCommit.name, params, result);
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
                reject(rejectArg(err, getReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logResolved(getReference.name, params, result);
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
                reject(rejectArg(err, getTags.name, params));
                return;
            }
            logResolved(getTags.name, params, {tags: res.data.length});
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
                reject(rejectArg(err, createReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logResolved(createReference.name, params, result);
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
                reject(rejectArg(err, updateReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logResolved(updateReference.name, params, result);
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
                reject(rejectArg(err, deleteReference.name, params));
                return;
            }
            const result = {deleted: true};
            logResolved(deleteReference.name, params, result);
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
            reject(rejectArg(err, updatePR.name, params));
            return;
        }
        const result = {state: res.data.state};
        logResolved(updatePR.name, params, result);
        resolve(result);
     });
  });
}

async function addLabel(label) {
    assert(currentContext);
    let params = commonParams();
    params.number = currentContext.pr.number;
    params.labels = [];
    params.labels.push(label);
    return await addLabels(params);
}

async function cleanupLabels(allLabels) {
    let params = commonParams();
    params.number = currentContext.pr.number;

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
            reject(rejectArg(err, addLabels.name, params));
            return;
        }
        const result = {added: true};
        logResolved(addLabels.name, params, result);
        resolve(res.data);
     });
  });
}

function removeLabel(params) {
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.issues.removeLabel(params, (err) => {
         if (err) {
            reject(rejectArg(err, addLabels.name, params));
            return;
         }
         const result = {removed: true};
         logResolved(removeLabel.name, params, result);
         resolve(result);
     });
  });
}

