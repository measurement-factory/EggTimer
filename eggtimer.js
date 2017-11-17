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
        finishMerging(currentContext);
    } else
        processEvent();
});


function merging(sha) {
    return (currentContext !== null && currentContext.autoSha !== null && sha === currentContext.autoSha);
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

    let reviewsParams = commonParams();
    reviewsParams.number = prContext.pr.number;
    let reviewsPromise = getReviews(reviewsParams);

    let statusParams = commonParams();
    statusParams.ref = prContext.pr.head.sha;
    let statusPromise = getStatuses(statusParams);

    let mergeableParams = commonParams();
    mergeableParams.number = prContext.pr.number;
    let mergeablePromise = getMergeable(mergeableParams);

    let labelsParams = commonParams();
    labelsParams.number = prContext.pr.number;
    let labelsPromise = getLabels(labelsParams);

    Promise.all([reviewsPromise, statusPromise, mergeablePromise, labelsPromise]).then((results) => {
            if (prContext.signaled)
                return Promise.reject("signaled");

            let reviews = results[0];
            let statuses = results[1];
            let mergeable = results[2];
            let labels = results[3];

            if ((mergeable !== true) || !approved(reviews) || !allChecksSuccessful(statuses) || mergedOrFailed(labels))
                return Promise.reject("not ready for merging yet");

            if (Config.dry_run)
                return Promise.reject("dry run option");

            startMerging(prContext);
            return Promise.resolve("Start merging PR" + prContext.pr.number);
    })
    .catch((err) => {
        console.error("Can't merge PR" + prContext.pr.number + ":", err);
        processNextPR();
    });
}

function createPRContext(pr) {
    let prContext = {};
    prContext.pr = pr;
    prContext.autoSha = null;
    return prContext;
}

function commonParams() {
    return {
        owner: Config.owner,
        repo: Config.repo
    };
}

function getLabels(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.issues.getIssueLabels(params, (err, res) => {
           if (err) {
               reject("Error! Could not get labels for PR" + params.number + ": " + err);
               return;
           }
           console.log("PR" + params.number, "labels total:", res.data.length);
           for (let label of res.data)
              console.log("PR label name:", label.name);
           resolve(res.data);
        });
    });
}

function getMergeable(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.get(params, (err, pr) => {
           if (err) {
               reject("Error! Could not get PR" + params.number + ":", err);
               return;
           }
           console.log("Got PR" + pr.data.number);
           resolve(pr.data.mergeable);
        });
    });
}

function getReviews(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.getReviews(params, (err, res) => {
            if (err) {
                reject("Error! Could not get reviews:" + err);
                return;
            }
            console.log("Got", res.data.length, "reviews for PR" + params.number);
            let reviews = {};
            for (let review of res.data) {
                console.log(review.state, review.user.login);
                // Reviews are returned in chronological order
                if (review.state.toLowerCase() === "approved")
                    reviews[review.user.login] = true;
            }
            resolve(reviews);
        });
    });
}

function getPRList() {
    PRList = [];
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.getAll(commonParams(), (err, res) => {
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

function mergedOrFailed(labels) {
    if (labels === undefined)
        return true;
    return (labels.find((label) => {
           return (label.name === "S-merged") || (label.name === "S-merge-failed"); })) !== undefined;
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

function getCommit(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getCommit(params, (err, res) => {
            if (err) {
                reject("Error! Could not get commit " + params.sha + ":" + err);
                return;
            }
            console.log("Got commit, sha:", res.data.sha, "treeSha:", res.data.tree.sha);
            resolve({sha: res.data.sha, treeSha: res.data.tree.sha});
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

function finishMerging(prContext) {
    let params = commonParams();
    assert(prContext.autoSha);
    params.ref = prContext.autoSha;
    let label = null;
    getStatuses(params)
        .then((checks) => {
            // some checks not completed yet, will wait
            if (Object.keys(checks).length < Config.checks_number) {
                return Promise.reject("Waiting for more auto_branch statuses completing for PR" + prContext.pr.number);
            }
            // some checks failed, drop our merge results
            if (!checkValues(checks, Config.checks_number)) {
                label = "S-merge-failed";
                return Promise.reject("Some auto_branch checks failed for PR" + prContext.pr.number);
            }
            // merge master into auto_branch (ff merge).
            let updateParams = commonParams();
            updateParams.ref = "heads/master";
            updateParams.sha = prContext.autoSha;
            updateParams.force = false; // default (ensure we do ff merge).
            return updateReference(updateParams);
        })
        .then((sha) => {
             assert(sha === params.ref);
             let prParams = commonParams();
             prParams.state = "closed";
             prParams.number = prContext.pr.number.toString();
             return updatePR(prParams);
        })
        .then((state) => {
             assert(state === "closed");
             let labelParams = commonParams();
             labelParams.number = prContext.pr.number.toString();
             labelParams.labels = [];
             labelParams.labels.push("S-merged");
             return addLabels(labelParams);
         })
        .then((result) => {
             assert(result === true);
             processNextPR();
             return Promise.resolve(true);
         })
        .catch((err) => {
            console.error("Error merging auto_branch(" + prContext.autoSha + ") into master:", err);
            if (label === null) {
                processNextPR();
                return Promise.resolve(true);
            } else {
               let labelParams = commonParams();
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

function startMerging(prContext) {
    console.log("Start merging PR" + prContext.pr.number, prContext.pr.head.sha);
    let getParams = commonParams();
    getParams.ref = "heads/master";
    let masterSha = null;
    getReference(getParams)
        .then((sha) => {
            masterSha = sha;
            let params = commonParams();
            params.ref = "pull/" + prContext.pr.number.toString() + "/merge";
            return getReference(params);
        })
        .then((sha) => {
            let params = commonParams();
            params.sha = sha;
            return getCommit(params);
        })
        .then((obj) => {
            let params = commonParams();
            params.tree = obj.treeSha;
            params.message = prContext.pr.title + endOfLine + prContext.pr.body + endOfLine + "(PR #" + prContext.pr.number.toString() + ")";
            params.parents = [];
            params.parents.push(masterSha.toString());
            return createCommit(params);
        })
        .then((sha) => {
            let params = commonParams();
            params.ref = "heads/" + Config.auto_branch;
            params.sha = sha;
            params.force = true;
            return updateReference(params);
        })
        .then((sha) => {
            prContext.autoSha = sha;
        })
        .catch((err) => {
            console.error("Error while merging PR("+prContext.pr.number.toString()+") into auto_branch:", err);
            processNextPR();
        });
}

// startup
processNextPR(true);

