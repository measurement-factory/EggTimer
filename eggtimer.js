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


let PRList = [];
let currentContext = null;

// Webhook Handlers

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
        mergeAutoIntoMaster(currentContext);
    } else
        processEvent();
});


function merging(sha) {
    return (currentContext !== null && currentContext.mergedAutoSha !== null && sha === currentContext.mergedAutoSha);
}

function signaled() {
    return (currentContext !== null && currentContext.signaled);
}

function processEvent() {
    if (currentContext !== null) {
        console.log("Signaling PR" + currentContext.pr.number, currentContext.pr.head.sha);
        currentContext.signaled = true;
    } else {
        processNextPR(true);
    }
}

function processNextPR(all) {
    currentContext = null;
    if (all) {
        getPRList();
        return;
    } else if (PRList.length === 0 && !signaled()) {
        console.log("No more PRs to process.");
        return;
    } else if (signaled()) {
        getPRList();
        return;
    }
    let prContext = createPRContext(PRList.shift());
    console.log("Processing PR" + prContext.pr.number, prContext.pr.head.sha);
    currentContext = prContext;
    populateMergeable(prContext);
    populateStatuses(prContext);
    populateReviews(prContext);
    populateLabels(prContext);
}

function createPRContext(pr) {
    let prContext = {};
    prContext.pr = pr;
    prContext.checks = {};
    prContext.reviews = {};
    prContext.signaled = false;
    prContext.aborted = false;
    prContext.mergeable = false;
    prContext.responses = 0;
    prContext.mergedAutoSha = null;
    return prContext;
}

function prRequestParams() {
    return {
        owner: Config.owner,
        repo: Config.repo
    };
}

function populateLabels(prContext) {
    let params = prRequestParams();
    params.number = prContext.pr.number;
    console.log("Getting PR" + prContext.pr.number, "label list");
    Github.authenticate(GithubAuthentication);
    Github.issues.getLabels(params, (err, res) => {
       if (err) {
           console.error("Error! Could not get labels for PR" + params.number + ":", err);
           return;
       }
       prContext.responses++;
       console.log("PR" + params.number, "labels total:", res.data.length);
       for (let label of res.data)
          console.log("PR label name:", label.name);
       prContext.labels = res.data;
       mergeIfReady(prContext);
    });
}

function populateMergeable(prContext) {
    let params = prRequestParams();
    params.number = prContext.pr.number;
    console.log("Getting PR" + prContext.pr.number, prContext.pr.head.sha);
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.get(params, (err, pr) => {
       if (err) {
           console.error("Error! Could not get a single PR:", err);
           prContext.aborted = true;
           return;
       }
       prContext.responses++;
       console.log("Got PR info", pr.data.number);
       prContext.mergeable = pr.data.mergeable;
       mergeIfReady(prContext);
    });
}

function populateStatuses(prContext) {
  let params = prRequestParams();
  params.ref = prContext.pr.head.sha;
  console.log("Getting statuses for PR" + prContext.pr.number, prContext.pr.head.sha);
  Github.authenticate(GithubAuthentication);
  Github.repos.getStatuses(params,
      (err, res) => {
        if (err) {
            console.error("Error! Could not get statuses:", err);
            prContext.aborted = true;
            return;
        }
        console.log("Got", res.data.length, "statuses for PR" + prContext.pr.number, prContext.pr.head.sha);
        prContext.responses++;
        // Statuses are returned in reverse chronological order.
        for (let st of res.data) {
            console.log(st.context, st.state);
            if (!(st.context in prContext.checks)) {
                console.log("adding", st.context, st.state);
                prContext.checks[st.context] = (st.state === 'success');
            }
        }

        mergeIfReady(prContext);
  });
}

function populateReviews(prContext) {
    let params = prRequestParams();
    params.number = prContext.pr.number;
    console.log("Getting reviews for PR", prContext.pr.number, prContext.pr.head.sha);
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.getReviews(params, (err, res) => {
        if (err) {
            console.error("Error! Could not get reviews:", err);
            prContext.aborted = true;
            return;
        }
        prContext.responses++;
        console.log("Got", res.data.length, "reviews for PR" + prContext.pr.number, prContext.pr.head.sha);
        for (let review of res.data) {
            console.log(review.state, review.user.login);
            // Reviews are returned in chronological order
            if (review.state.toLowerCase() === "approved")
                prContext.reviews[review.user.login] = true;
        }
        mergeIfReady(prContext);
    });
}

function mergeIfReady(prContext) {
    if (prContext.signaled) {
        console.log("Do not merge PR" + prContext.pr.number, "due to signaled");
        processNextPR();
        return;
    }
    if (prContext.aborted) {
        console.log("Do not merge PR"+ prContext.pr.number, "due to aborted");
        processNextPR();
        return;
    }
    if (!checksReceived(prContext)) {
        console.log("Do not yet merge PR" + prContext.pr.number + ",", "waiting data from Github");
        return;
    }

    if (!readyForMerge(prContext)) {
        console.log("Can not merge PR" + prContext.pr.number, ": not ready");
        processNextPR();
        return;
    }

    console.log("Will merge PR" + prContext.pr.number, prContext.pr.head.sha);
    if (!Config.dry_run) {
        mergePRintoAuto(prContext);
        return;
    }
    processNextPR();
}

function getPRList() {
    PRList = [];
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.getAll(prRequestParams(), (err, res) => {
        if (err) {
            console.error("Error! Could not get all PRs:", err);
            return;
        }
        if (res.data.length === 0) {
            console.log("No open PR found on Github");
            return;
        }
        console.log("Will process", res.data.length, "open PRs");
        PRList = res.data;
        processNextPR();
    });
}

function checksReceived(prContext) {
    return prContext.responses >= 4;
}

function readyForMerge(prContext) {
    console.log("aborted:" + prContext.aborted, "signaled:"+ prContext.signaled,
            "mergeable:" + isMergeable(prContext), "approved:" + isApproved(prContext), "checks ok:" + checksPassed(prContext),
            "labels ok:" + labelsOk(prContext));
    return (!prContext.aborted && !prContext.signaled && isMergeable(prContext) && isApproved(prContext) && checksPassed(prContext) && labelsOk(prContext));
}

function isMergeable(prContext) {
    return prContext.mergeable === true;
}

function checkPropertyAllValues(obj, num) {
    if (obj === undefined || Object.keys(obj).length < num)
        return false;
    return (Object.values(obj).find((val) => { return val === false; })) === undefined;
}

function isApproved(prContext) {
    return checkPropertyAllValues(prContext.reviews, Config.reviews_number);
}

function checksPassed(prContext) {
    return checkPropertyAllValues(prContext.checks, Config.checks_number);
}

function labelsOk(prContext) {
    if (prContext.labels === undefined)
        return false;
    return (prContext.labels.find((label) => {
           return (label.name === "S-merged") || (label.name === "S-merge-failed"); })) === undefined;
}


// =========== Auto branch ================

function getStatuses(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.getStatuses(params, (err, res) => {
            if (err) {
                reject("Error! Could not get statuses for sha " + params.ref + " : "+ err);
                return;
            }
            console.log("Got", res.data.length, "statuses for sha:", params.ref);
            // Statuses are returned in reverse chronological order.
            let checks = {};
            for (let st of res.data) {
                console.log(st.context, st.state);
                if (!(st.context in checks)) {
                    if (st.state !== 'pending') {
                        console.log("adding", st.context, st.state);
                        checks[st.context] = (st.state === 'success');
                    }
                }
            }
            resolve(checks);
       });
    });
}

function createCommit(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.createCommit(params, (err, res) => {
            if (err) {
                reject("Error! Could not create commit " + params.sha + ":" + err);
                return;
            }
            console.log("Created commit, sha:", res.data.sha);
            resolve(res.data.sha);
        });
  });
}

function getReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getReference(params, (err, res) => {
            if (err) {
                reject("Error! Could not get master head reference: " + err);
                return;
            }
            console.log("Got master head sha:", res.data.object.sha);
            resolve(res.data.object.sha);
        });
    });
}

function updateReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.updateReference(params, (err, res) => {
            if (err) {
                reject("Error! Could not update reference: " + err);
                return;
            }
            console.log("Updated reference to sha:", res.data.object.sha);
            resolve(res.data.object.sha);
       });
    });
}

function updatePR(params) {
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.pullRequests.update(params, (err, res) => {
        if (err) {
            reject("Error! Could not update PR: " + err);
            return;
        }
        console.log("Updated PR" + res.data.number, res.data.state);
        resolve(res.data.state);
     });
  });
}

function addLabels(params) {
   return new Promise( (resolve, reject) => {
     Github.authenticate(GithubAuthentication);
     Github.issues.addLabels(params, (err, res) => {
        if (err) {
            reject("Error! Could not add label to PR" + params.number + ": " + err);
            return;
        }
        console.log("PR" + params.number, "labels total:", res.data.length);
        for (let label of res.data)
           console.log("PR label name:", label.name);
        resolve(true);
     });
  });
}

function mergeBranches(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.merge(params, (err, res) => {
            if (err) {
                reject("Error! Could not merge from " + params.head + " to " + params.base + ": ", err);
                return;
            }
            console.log("Merged: got", res.data.sha, "from", res.data.parents[0], "and", res.data.parents[1]);
            resolve({sha: res.data.sha, treeSha: res.data.tree.sha});
       });
    });
}

function mergeAutoIntoMaster(prContext) {
    let params = prRequestParams();
    assert(prContext.mergedAutoSha);
    params.ref = prContext.mergedAutoSha;
    let label = null;
    getStatuses(params)
        .then((checks) => {
            // some checks not completed yet, will wait
            if (Object.keys(checks).length < Config.checks_number) {
                return Promise.reject("Waiting for more auto_branch statuses completing for PR" + prContext.pr.number);
            }
            // some checks failed, drop our merge results
            if (!checkPropertyAllValues(checks, Config.checks_number)) {
                label = "S-merge-failed";
                return Promise.reject("Some auto_branch checks failed for PR" + prContext.pr.number);
            }
            // merge master into auto_branch (ff merge).
            let updateParams = prRequestParams();
            updateParams.ref = "heads/master";
            updateParams.sha = prContext.mergedAutoSha;
            updateParams.force = false; // default (ensure we do ff merge).
            return updateReference(updateParams);
        })
        .then((sha) => {
             assert(sha === params.ref);
             let prParams = prRequestParams();
             prParams.state = "closed";
             prParams.number = prContext.pr.number.toString();
             return updatePR(prParams);
        })
        .then((state) => {
             assert(state === "closed");
             let labelParams = prRequestParams();
             labelParams.number = prContext.pr.number.toString();
             labelParams.labels = [];
             labelParams.labels.push("S-merged");
             return addLabels(labelParams);
         })
        .then((result) => {
             assert(result === true);
             processNextPR();
         })
        .catch((err) => {
            console.error("Error merging auto_branch(" + prContext.mergedAutoSha + ") into master:", err);
            if (label === null) {
                processNextPR();
                return Promise.resolve(true);
            } else {
               let labelParams = prRequestParams();
               labelParams.number = prContext.pr.number.toString();
               labelParams.labels = [];
               labelParams.labels.push(label);
               return addLabels(labelParams);
            }
        })
        .then((result) => {
             assert(result === true);
        })
        .catch((err) => {
            console.error("Error setting label " + label, err);
        });
}

function mergePRintoAuto(prContext) {
    let getParams = prRequestParams();
    getParams.ref = "heads/master";
    let masterSha = null;
    getReference(getParams)
         .then((sha) => {
            let params = prRequestParams();
            params.ref = "heads/" + Config.auto_branch;
            params.sha = sha;
            params.force = true;
            return updateReference(params);
        })
        .then((sha) => {
            let params = prRequestParams();
            params.base = Config.auto_branch;
            params.head = prContext.pr.head.sha;
            params.message = "Bot merged " + prContext.pr.head.sha + " into " + Config.auto_branch;
            return mergeBranches(params);
        })
        .then((obj) => {
            let params = prRequestParams();
            params.tree = obj.treeSha;
            params.message = prContext.pr.title + endOfLine + prContext.pr.body + endOfLine + "(PR #" + prContext.pr.number.toString() + ")";
            params.parents = [];
            params.parents.push(masterSha.toString());
            return createCommit(params);
        })
        .then((sha) => {
            let params = prRequestParams();
            params.ref = "heads/" + Config.auto_branch;
            params.sha = sha;
            params.force = true;
            return updateReference(params);
        })
        .then((sha) => {
            prContext.mergedAutoSha = sha;
        })
        .catch((err) => {
            console.error("Error while merging PR("+prContext.pr.number.toString()+") into auto_branch:", err);
            processNextPR();
        });
}

// startup
processNextPR(true);

