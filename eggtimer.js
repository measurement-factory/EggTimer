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
const MergedLabel = "S-merged";
const MergingTag = "T-merging-PR";
const TagRegex = /(refs\/tags\/.*-PR)(\d+)$/;

let PRList = [];
let currentContext = null;

// startup
initContext();


// events

WebhookHandler.on('error', (err) => {
  console.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
WebhookHandler.on('pull_request_review', (ev) => {
    const pr = ev.payload.pull_request;
    const review = ev.payload.review;
    console.log("pull_request_review event:", ev.payload.id, pr.number, pr.head.sha, pr.state, review.state);
    processEvent();
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
WebhookHandler.on('pull_request', (ev) => {
    const pr = ev.payload.pull_request;
    console.log("pull_request event:", ev.payload.id, pr.number, pr.head.sha, pr.state);
    processEvent();
});

// https://developer.github.com/v3/activity/events/types/#statusevent
WebhookHandler.on('status', (ev) => {
    const e = ev.payload;
    console.log("status event:", e.id, e.sha, e.context, e.state);
    if (merging(e.sha)) {
        currentContext.signaled = true;
        finishMerging(currentContext);
    } else
        processEvent();
});

function processEvent() {
    if (currentContext !== null) {
        currentContext.signaled = true;
        console.log(contextToStr());
    } else {
        processNextPR(true);
    }
}


// helper methods

function createContext(pr) {
    assert(currentContext === null);
    currentContext = {};
    currentContext.pr = pr;
    currentContext.autoSha = null;
    currentContext.tagSha = null;
    currentContext.signaled = false;
}

function merging(sha) {
    return (currentContext !== null && currentContext.autoSha !== null && sha === currentContext.autoSha);
}

function signaled() {
    return (currentContext !== null && currentContext.signaled);
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

function approved(reviews) {
    return checkValues(reviews, Config.reviews_number);
}

function allChecksSuccessful(checks) {
    return checkValues(checks, Config.checks_number);
}

function markedAsFailed(labels) {
    return (labels.find((label) => {
           return (label.name === MergeFailedLabel); })) !== undefined;
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
    const n = 6;
    let str = "PR" + currentContext.pr.number + "(head: " + currentContext.pr.head.sha.substr(0, n);
    if (currentContext.autoSha !== null)
        str += ", auto: " + currentContext.autoSha.substr(0, n);
    if (currentContext.tagSha !== null)
        str += ", tag: " + currentContext.tagSha.substr(0, n);
    if (currentContext.signaled !== false)
        str += ", signaled: true";
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


// Bot core methods

function getPRList() {
    PRList = [];
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.getAll(commonParams(), (err, res) => {
        if (err) {
            console.error("Could not get PR list:", err);
            return;
        }
        if (res.data.length === 0) {
            console.log("No open PR found on Github.");
            return;
        }
        console.log("Will process", res.data.length, "open PRs.");
        PRList = res.data;
        processNextPR();
    });
}

function processNextPR(all) {
    const sig = signaled();
    currentContext = null;
    if (all) {
        getPRList();
        return;
    } else if (PRList.length === 0 && !sig) {
        console.log("No more PRs to process.");
        return;
    } else if (sig) {
        getPRList();
        return;
    }
    createContext(PRList.shift());
    console.log(contextToStr(), "start processing");
    checkMergePreconditions();
}

function initContext() {
    assert(currentContext === null);
    currentContext = {};
    let autoSha = null;

    let autoParams = commonParams();
    autoParams.ref = "heads/" + Config.auto_branch;
    let autoPromise = getReference(autoParams);

    let tagsParams = commonParams();
    let tagsPromise = getTags(tagsParams);

    Promise.all([autoPromise, tagsPromise])
        .then( (results) => {
            autoSha = results[0];
            let tags = results[1];
            let prNum = null;

            tags.find( (tag) => {
                if (tag.object.sha === autoSha) {
                    let matched = tag.ref.match(TagRegex);
                    if (matched)
                        prNum = matched[2];
                }
            });

            if (prNum === null)
                return Promise.reject(rejectArg("auto_branch does not have an unfinished PR merge"));

            let params = commonParams();
            params.number = prNum;
            return getPR(params);
        })
        .then((pr) => {
            createContext(pr);
            currentContext.autoSha = autoSha;
            console.log(contextToStr(), "found in the merging state");
            finishMerging(currentContext);
            return;
        })
        .catch((err) => {
            console.log("No PR is in the merging state: ", err);
            currentContext = null;
        })
        .finally(() => {
            console.log("Start listening on " + Config.port);
            http.createServer((req, res) => {
                 WebhookHandler(req, res, () => {
                   res.statusCode = 404;
                   res.end('no such location');
                 });
            }).listen(Config.port);
            if (currentContext === null)
                processNextPR(true);
        });
}

function checkMergePreconditions() {
    assert(currentContext);
    let reviewsParams = commonParams();
    reviewsParams.number = currentContext.pr.number;
    let reviewsPromise = getReviews(reviewsParams);

    let statusParams = commonParams();
    statusParams.ref = currentContext.pr.head.sha;
    let statusPromise = getStatuses(statusParams);

    let mergeableParams = commonParams();
    mergeableParams.number = currentContext.pr.number;
    let mergeablePromise = getPR(mergeableParams);

    let labelsParams = commonParams();
    labelsParams.number = currentContext.pr.number;
    let labelsPromise = getLabels(labelsParams);

    Promise.all([reviewsPromise, statusPromise, mergeablePromise, labelsPromise]).then((results) => {
            if (currentContext.signaled)
                return Promise.reject(rejectArg("signaled while getting merge preconditions"));

            let reviews = results[0];
            let statuses = results[1];
            let mergeable = results[2].mergeable;
            let labels = results[3];

            if ((mergeable !== true) || !approved(reviews) || !allChecksSuccessful(statuses))
                return Promise.reject(rejectArg("some of merge precoditions have failed"));

            if (markedAsMerged(labels))
                return Promise.reject(rejectArg("already merged"));

            if (markedAsFailed(labels))
                console.log(contextToStr(), "previous merge attempt was unsuccessful");

            checkBeforeStartMerging(currentContext);
            return Promise.resolve(true);
    })
    .catch((err) => {
        logError(err, "will not merge because:");
        processNextPR();
    });
}

function checkBeforeStartMerging() {
   assert(currentContext);
   let refParams = commonParams();
   refParams.ref = mergingTag(currentContext.pr.number);
   let tagTreeSha = null;
   currentContext.tagSha = null;
   console.log(contextToStr(), "looking for previous failed merge attempts");
   getReference(refParams)
       .then( (obj) => {
           let commitParams = commonParams();
           commitParams.sha = obj.sha;
           currentContext.tagSha = obj.sha;
           let commitPromise = getCommit(commitParams);

           let prParams = commonParams();
           prParams.number = currentContext.pr.number;
           let prPromise = getPR(prParams);

           return Promise.all([commitPromise, prPromise]);
       })
       .then((results) => {
           let commitObj = results[0];
           let pr = results[1];
           assert(pr.number === currentContext.pr.number);
           let params = commonParams();
           tagTreeSha = commitObj.treeSha;
           params.ref = "pull/" + currentContext.pr.number + "/merge";
           return getReference(params);
       })
       .then((obj) => {
           let params = commonParams();
           params.sha = obj.sha;
           return getCommit(params);
       })
       .then((obj) => {
           if (obj.treeSha !== tagTreeSha)
               return Promise.reject(rejectArg("PR merge commit has changed since last failed attempt"));
           console.log(contextToStr(), "PR merge commit has not changed since last failed attempt");
           let statusParams = commonParams();
           statusParams.ref = currentContext.tagSha;
           return getStatuses(statusParams);
       })
       .then((checks) => {
           if (!checkValues(checks, Config.checks_number)) {
               console.log(contextToStr(), "auto_branch checks are still failed");
               processNextPR();
               return Promise.resolve(true);
           }
           return Promise.reject(rejectArg("auto_branch checks succeeded"));
       })
       .catch((obj) => {
           if (Config.dry_run) {
               console.log(contextToStr(), "skip merging due to dry_run option");
               return;
           }
           if (currentContext.tagSha === null)
               logError(obj, "Will merge because no failed attempts found. Details:");
           else
               logError(obj, "There were failed attempts, but will try to merge because");
           startMerging(currentContext);
       });
}

function startMerging() {
    assert(currentContext);
    console.log(contextToStr(), "start merging");
    let getParams = commonParams();
    getParams.ref = "heads/master";
    let masterSha = null;
    getReference(getParams)
        .then((obj) => {
            masterSha = obj.sha;
            let params = commonParams();
            params.ref = "pull/" + currentContext.pr.number.toString() + "/merge";
            return getReference(params);
        })
        .then((obj) => {
            let params = commonParams();
            params.sha = obj.sha;
            return getCommit(params);
        })
        .then((obj) => {
            let params = commonParams();
            params.tree = obj.treeSha;
            params.message = currentContext.pr.title + endOfLine + currentContext.pr.body + endOfLine + "(PR #" + currentContext.pr.number.toString() + ")";
            params.parents = [];
            params.parents.push(masterSha.toString());
            return createCommit(params);
        })
        .then((obj) => {
            const sha = obj.sha;
            let params = commonParams();
            params.body = "Merging PR #" + currentContext.pr.number.toString();
            params.sha = sha;

            let tagParams = commonParams();
            tagParams.sha = sha;
            let tagPromise = null;
            if (currentContext.tagSha === null) {
                tagParams.ref = "refs/" + mergingTag(currentContext.pr.number);
                tagPromise = createReference(tagParams);
            } else {
                tagParams.ref = mergingTag(currentContext.pr.number);
                tagParams.force = true;
                tagPromise = updateReference(tagParams);
            }
            return tagPromise;
        })
        .then(obj => {
            let params = commonParams();
            params.ref = "heads/" + Config.auto_branch;
            params.sha = obj.sha;
            params.force = true;
            return updateReference(params);
        })
        .then((obj) => {
            currentContext.autoSha = obj.sha;
        })
        .catch((err) => {
            logError(err, "Could not start merging auto_branch into master. Details:");
            processNextPR();
        });
}

function finishMerging() {
    assert(currentContext);
    let statusParams = commonParams();
    assert(currentContext.autoSha);
    statusParams.ref = currentContext.autoSha;
    let processNext = true;
    getStatuses(statusParams)
        .then((checks) => {
            // some checks not completed yet, will wait
            if (Object.keys(checks).length < Config.checks_number) {
                processNext = false;
                return Promise.reject("Waiting for more auto_branch statuses completing for PR" + currentContext.pr.number);
            }
            // some checks failed, drop our merge results
            if (!checkValues(checks, Config.checks_number))
                return Promise.reject("Some auto_branch checks failed for PR" + currentContext.pr.number);
            // merge master into auto_branch (ff merge).
            let updateParams = commonParams();
            updateParams.ref = "heads/master";
            updateParams.sha = currentContext.autoSha;
            updateParams.force = false; // default (ensure we do ff merge).
            return updateReference(updateParams);
        })
        .then((obj) => {
            assert(obj.sha === statusParams.ref);

            let prParams = commonParams();
            prParams.state = "closed";
            prParams.number = currentContext.pr.number.toString();
            let prPromise = updatePR(prParams);

            let addLabelParams = commonParams();
            addLabelParams.number = currentContext.pr.number.toString();
            addLabelParams.labels = [];
            addLabelParams.labels.push(MergedLabel);
            let addLabelPromise = addLabels(addLabelParams);

            let deleteTagParams = commonParams();
            deleteTagParams.ref = mergingTag(currentContext.pr.number);
            let tagPromise = deleteReference(deleteTagParams);

            return Promise.all([prPromise, addLabelPromise, tagPromise]);
        })
        .then((results) => {
            if (results[0].state !== "closed")
                return Promise.reject("cleanup failed");
            const labels = results[1];
            if (markedAsFailed(labels)) {
                let delLabelParams = commonParams();
                delLabelParams.number = currentContext.pr.number.toString();
                delLabelParams.name = MergeFailedLabel;
                return removeLabel(delLabelParams);
            } else {
                return Promise.resolve({removed: true});
            }
        })
        .catch((err) => {
             logError(err, "Could not finish merging auto_branch into master. Details:");
             let params = commonParams();
             params.number = currentContext.pr.number.toString();
             params.labels = [];
             params.labels.push(MergeFailedLabel);
             addLabels(params);
        })
        .finally(() => {
            if (processNext)
               processNextPR();
        });
}


// Promisificated node-github wrappers

function getLabels(params) {
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

function getPR(params) {
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
        const delay = 500;
        if (pr.data.mergeable !== null) {
            logResolved(getMergeablePR.name, params, {mergeable: pr.data.mergeable});
            resolve(pr.data);
            return;
        }
        console.log("PR" + params.number + ": Github still calculates mergeable flag, will retry in " + delay + " msec delay");
        setTimeout(getMergeablePR, delay, params, resolve, reject);
    });
}

function getReviews(params) {
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
            const result = {reviews: res.data.length};
            logResolved(getReviews.name, params, result);
            resolve(reviews);
        });
    });
}


function getStatuses(params) {
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
            const result = {statuses: res.data.length};
            logResolved(getStatuses.name, params, result);
            resolve(checks);
       });
    });
}

function getCommit(params) {
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

function createCommit(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.createCommit(params, (err, res) => {
            if (err) {
                reject(rejectArg(err, createCommit.name, params));
                return;
            }
            const result = {sha: res.data.sha};
            logResolved(createCommit.name, params, result);
            resolve(result);
        });
  });
}

function getReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getReference(params, (err, res) => {
            if (err) {
                reject(rejectArg(err, getReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logResolved(getReference.name, params, result);
            resolve(result);
        });
    });
}

function getTags(params) {
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

function createReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.createReference(params, (err, res) => {
            if (err) {
                reject(rejectArg(err, createReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logResolved(createReference.name, params, result);
            resolve(result);
        });
    });
}

function updateReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.updateReference(params, (err, res) => {
            if (err) {
                reject(rejectArg(err, updateReference.name, params));
                return;
            }
            const result = {ref: res.data.ref, sha: res.data.object.sha};
            logResolved(updateReference.name, params, result);
            resolve(result);
       });
    });
}

function deleteReference(params) {
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

function updatePR(params) {
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

