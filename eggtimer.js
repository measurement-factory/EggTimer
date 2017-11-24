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

// startup
initContext();

function merging(sha) {
    return (currentContext !== null && currentContext.autoSha !== null && sha === currentContext.autoSha);
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
                return Promise.reject(true);

            let params = commonParams();
            params.number = prNum;
            return getPR(params);
        })
        .then((pr) => {
            currentContext = createPRContext(pr);
            currentContext.autoSha = autoSha;
            console.log("Found PR" + pr.number + " in a merging state");
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
    let prContext = createPRContext(PRList.shift());
    console.log("Processing PR" + prContext.pr.number, prContext.pr.head.sha);
    currentContext = prContext;

    checkMergePreconditions(prContext);
}

function mergingTag(prNum) {
    return "tags/" + MergingTag + prNum;
}

function checkMergePreconditions(prContext) {
    let reviewsParams = commonParams();
    reviewsParams.number = prContext.pr.number;
    let reviewsPromise = getReviews(reviewsParams);

    let statusParams = commonParams();
    statusParams.ref = prContext.pr.head.sha;
    let statusPromise = getStatuses(statusParams);

    let mergeableParams = commonParams();
    mergeableParams.number = prContext.pr.number;
    let mergeablePromise = getPR(mergeableParams);

    let labelsParams = commonParams();
    labelsParams.number = prContext.pr.number;
    let labelsPromise = getLabels(labelsParams);

    Promise.all([reviewsPromise, statusPromise, mergeablePromise, labelsPromise]).then((results) => {
            if (prContext.signaled)
                return Promise.reject("signaled");

            let reviews = results[0];
            let statuses = results[1];
            let mergeable = results[2].mergeable;
            let labels = results[3];

            if ((mergeable !== true) || !approved(reviews) || !allChecksSuccessful(statuses))
                return Promise.reject("not ready for merging yet");

            if (markedAsMerged(labels))
                return Promise.reject("already merged");

            if (markedAsFailed(labels))
                console.log("PR" + prContext.pr.number + " previous merge was unsuccessful");

            checkBeforeStartMerging(prContext);
            return Promise.resolve(true);
    })
    .catch((err) => {
        console.error("Can't merge PR" + prContext.pr.number + ":", err);
        processNextPR();
    });
}

function checkBeforeStartMerging(prContext) {
   let refParams = commonParams();
   refParams.ref = mergingTag(prContext.pr.number);
   let tagTreeSha = null;
   prContext.tagSha = null;
   console.log("Checking whether to skip due to a previous unsuccessful merge for PR" + prContext.pr.number);
   getReference(refParams)
       .then( (sha) => {
           let params = commonParams();
           params.sha = sha;
           prContext.tagSha = sha;
           let commitPromise = getCommit(params);

           let prParams = commonParams();
           prParams.number = prContext.pr.number;
           let prPromise = getPR(prParams);

           return Promise.all([commitPromise, prPromise]);
       })
       .then((results) => {
           let commitObj = results[0];
           let pr = results[1];
           assert(pr.number = prContext.pr.number);
           let params = commonParams();
           tagTreeSha = commitObj.treeSha;
           params.ref = "pull/" + prContext.pr.number + "/merge";
           return getReference(params);
       })
       .then((sha) => {
           let params = commonParams();
           params.sha = sha;
           return getCommit(params);
       })
       .then((obj) => {
           if (obj.treeSha !== tagTreeSha)
               return Promise.reject("merge sha has changed");
           let statusParams = commonParams();
           statusParams.ref = prContext.tagSha;
           return getStatuses(statusParams);
       })
       .then((checks) => {
           if (!checkValues(checks, Config.checks_number)) {
               processNextPR();
               return Promise.resolve("Some auto_branch checks failed for PR" + prContext.pr.number);
           }
           return Promise.reject("all checks succeeded");
       })
       .catch((msg) => {
           console.log("Will merge:", msg);
           if (Config.dry_run) {
               console.log("PR" + prContext.pr.number + ": skip merging due to dry_run option");
               return;
           }
           startMerging(prContext);
       });
}

function createPRContext(pr) {
    let prContext = {};
    prContext.pr = pr;
    prContext.autoSha = null;
    prContext.signaled = false;
    prContext.tagSha = null;
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

function getPR(params) {
    return new Promise( (resolve, reject) => {
            getMergeablePR(params, resolve, reject);
    });
}

function getMergeablePR(params, resolve, reject) {
    Github.authenticate(GithubAuthentication);
    Github.pullRequests.get(params, (err, pr) => {
        if (err) {
            reject("Error! Could not get PR" + params.number + ":", err);
            return;
        }
        const delay = 500;
        if (pr.data.mergeable !== null) {
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

function markedAsFailed(labels) {
    if (labels === undefined)
        return false;
    return (labels.find((label) => {
           return (label.name === MergeFailedLabel); })) !== undefined;
}

function markedAsMerged(labels) {
    if (labels === undefined)
        return false;
    return (labels.find((label) => {
           return (label.name === MergedLabel); })) !== undefined;
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
            resolve({sha: res.data.sha, treeSha: res.data.tree.sha, message: res.data.message});
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
                reject("Error! Could not get reference " + params.ref + " :" + err);
                return;
            }
            console.log("Got reference:", res.data.object.sha);
            resolve(res.data.object.sha);
        });
    });
}

function getTags(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.getTags(params, (err, res) => {
            if (err) {
                reject("Error! Could not get tags: " + err);
                return;
            }
            console.log("Got " + res.data.length + " tags");
            resolve(res.data);
        });
    });
}

function createReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.createReference(params, (err, res) => {
            if (err) {
                reject("Error! Could not create reference " + params.ref + " :" + err);
                return;
            }
            console.log("Created reference " + res.data.ref);
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

function deleteReference(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.gitdata.deleteReference(params, (err) => {
            if (err) {
                reject("Error! Could not delete reference: " + err);
                return;
            }
            console.log("Deleted reference to sha:", params.ref);
            resolve(true);
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

function removeLabel(params) {
   return new Promise( (resolve) => {
     Github.authenticate(GithubAuthentication);
     Github.issues.removeLabel(params, (err) => {
        if (err)
            console.log("Could not remove label " + params.name + " to PR" + params.number + ": " + err);
        resolve(true);
     });
  });
}

function finishMerging(prContext) {
    let statusParams = commonParams();
    assert(prContext.autoSha);
    statusParams.ref = prContext.autoSha;
    let errorLabel = MergeFailedLabel;
    getStatuses(statusParams)
        .then((checks) => {
            // some checks not completed yet, will wait
            if (Object.keys(checks).length < Config.checks_number) {
                errorLabel = null;
                return Promise.reject("Waiting for more auto_branch statuses completing for PR" + prContext.pr.number);
            }
            // some checks failed, drop our merge results
            if (!checkValues(checks, Config.checks_number))
                return Promise.reject("Some auto_branch checks failed for PR" + prContext.pr.number);
            // merge master into auto_branch (ff merge).
            let updateParams = commonParams();
            updateParams.ref = "heads/master";
            updateParams.sha = prContext.autoSha;
            updateParams.force = false; // default (ensure we do ff merge).
            return updateReference(updateParams);
        })
        .then((sha) => {
            assert(sha === statusParams.ref);

            let prParams = commonParams();
            prParams.state = "closed";
            prParams.number = prContext.pr.number.toString();
            let prPromise = updatePR(prParams);

            let addLabelParams = commonParams();
            addLabelParams.number = prContext.pr.number.toString();
            addLabelParams.labels = [];
            addLabelParams.labels.push(MergedLabel);
            let addLabelPromise = addLabels(addLabelParams);

            let deleteTagParams = commonParams();
            deleteTagParams.ref = mergingTag(prContext.pr.number);
            let tagPromise = deleteReference(deleteTagParams);

            let delLabelParams = commonParams();
            delLabelParams.number = prContext.pr.number.toString();
            delLabelParams.name = MergeFailedLabel;
            let delLabelPromise = removeLabel(delLabelParams);

            return Promise.all([prPromise, addLabelPromise, tagPromise, delLabelPromise]);
        })
        .then((results) => {
            const state = results[0];
            const labelsUpdated = results[1];
            if (state === "closed" && labelsUpdated)
                return Promise.resolve(true);
            return Promise.reject("cleanup failed");
        })
        .then((result) => {
             assert(result === true);
             processNextPR();
             return Promise.resolve(true);
         })
        .catch((err) => {
            if (errorLabel === null) {
                return Promise.resolve(true);
            } else {
               console.error("Error merging auto_branch(" + prContext.autoSha + ") into master:", err);
               processNextPR();
               let params = commonParams();
               params.number = prContext.pr.number.toString();
               params.labels = [];
               params.labels.push(errorLabel);
               return addLabels(params);
            }
        })
        .then((result) => {
             assert(result === true);
        })
        .catch((err) => {
            console.error("Error setting label " + errorLabel, err);
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
            params.body = "Merging PR #" + prContext.pr.number.toString();
            params.sha = sha;

            let tagParams = commonParams();
            tagParams.sha = sha;
            let tagPromise = null;
            if (prContext.tagSha === null) {
                tagParams.ref = "refs/" + mergingTag(prContext.pr.number);
                tagPromise = createReference(tagParams);
            } else {
                tagParams.ref = mergingTag(prContext.pr.number);
                tagParams.force = true;
                tagPromise = updateReference(tagParams);
            }
            return tagPromise;
        })
        .then(sha => {
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
            console.error("Error while merging PR(" + prContext.pr.number.toString() + ") into auto_branch:", err);
            processNextPR();
        });
}

