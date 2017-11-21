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
    let mergingCommentId = null;
    let getParams = commonParams();
    getParams.ref = "heads/" + Config.auto_branch;

    getReference(getParams)
        .then((sha) => {
            autoSha = sha;
            let params = commonParams();
            params.ref = sha;
            return getCommitComments(params);
        })
        .then((comments) => {
            if (comments.length !== 0) {
                const mergingRegex = /^(Merging PR #)(\d+)$/;
                let matched = comments[0].body.match(mergingRegex);
                if (matched) {
                    let params = commonParams();
                    params.number = matched[2];
                    mergingCommentId = comments[0].id;
                    return getPR(params);
                }
            }
            return Promise.reject(true);
        })
        .then((pr) => {
            currentContext = createPRContext(pr);
            currentContext.autoSha = autoSha;
            currentContext.commentId = mergingCommentId;
            console.log("Found PR"+ pr.number + " in a merging state");
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

    checkMergePreconditions(prContext);
}

function mergingTag(prNum) {
    return "regs/tags/T-merging-PR" + prNum;
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

            if (Config.dry_run)
                return Promise.reject("dry run option");

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
   let tagSha = null;
   console.log("Checking whether to skip due to a previous unsuccessful merge for PR" + prContext.pr.number);
   getReference(refParams)
       .then( (sha) => {
           let params = commonParams();
           params.sha = sha;
           tagSha = sha;
           return getCommit(params);
        })
        .then((obj) => {
            let params = commonParams();
            tagTreeSha = obj.treeSha;
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
            statusParams.ref = tagSha;
            return getStatuses(statusParams);
        })
        .then((checks) => {
            if (!checkValues(checks, Config.checks_number))
                return Promise.resolve("Some auto_branch checks failed for PR" + prContext.pr.number);
            return Promise.reject("all checks succeeded");
        })
        .catch((msg) => {
            console.log("Will merge:", msg);
            startMerging(prContext);
        });
}

function createPRContext(pr) {
    let prContext = {};
    prContext.pr = pr;
    prContext.autoSha = null;
    prContext.signaled = false;
    prContext.commentId = null;
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
        Github.authenticate(GithubAuthentication);
        Github.pullRequests.get(params, (err, pr) => {
           if (err) {
               reject("Error! Could not get PR" + params.number + ":", err);
               return;
           }
           console.log("Got PR" + pr.data.number);
           resolve(pr.data);
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

function markedAsFailed(labels) {
    if (labels === undefined)
        return false;
    return (labels.find((label) => {
           return (label.name === "S-merge-failed"); })) !== undefined;
}

function markedAsMerged(labels) {
    if (labels === undefined)
        return false;
    return (labels.find((label) => {
           return (label.name === "S-merged"); })) !== undefined;
}


// =========== Auto branch ================

function deleteCommitComment(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.deleteCommitComment(params, (err) => {
            if (err) {
                reject("Error! Could not delete comment with id " + params.id + ":" + err);
                return;
            }
            console.log("Deleted commit comment with id " + params.id);
            resolve(true);
        });
  });
}

function createCommitComment(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.createCommitComment(params, (err, res) => {
            if (err) {
                reject("Error! Could not create commit comment " + err);
                return;
            }
            console.log("Created commit comment", res.data.id, "for sha:", res.data.commit_id);
            resolve(res.data);
        });
  });
}

function getCommitComments(params) {
    return new Promise( (resolve, reject) => {
        Github.authenticate(GithubAuthentication);
        Github.repos.getCommitComments(params, (err, res) => {
            if (err) {
                reject("Error! Could not get commit comments " + params.ref + ":" + err);
                return;
            }
            console.log("Got commit comments", res.data.length, "for sha:", params.ref);
            resolve(res.data);
        });
  });
}

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
                reject("Error! Could not get master head reference: " + err);
                return;
            }
            console.log("Got master head sha:", res.data.object.sha);
            resolve(res.data.object.sha);
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
    let statusParams = commonParams();
    assert(prContext.autoSha);
    statusParams.ref = prContext.autoSha;
    let errorLabel = "S-merge-failed";
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

            let labelParams = commonParams();
            labelParams.number = prContext.pr.number.toString();
            labelParams.labels = [];
            labelParams.labels.push("S-merged");
            let lblPromise = addLabels(labelParams);

            let deleteCommentParams = commonParams();
            deleteCommentParams.id = prContext.commentId;
            let commPromise = deleteCommitComment(deleteCommentParams);

            return Promise.all([prPromise, lblPromise, commPromise]);
        })
        .then((results) => {
            const state = results[0];
            const labelsUpdated = results[1];
            const commentDeleted = results[2];
            if (state === "closed" && labelsUpdated && commentDeleted)
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
            let commentPromise = createCommitComment(params);

            let tagParams = commonParams();
            tagParams.ref = mergingTag(prContext.pr.number);
            params.sha = sha;
            let tagPromise = createReference(tagParams);

            return Promise.all([commentPromise, tagPromise]);
        })
        .then((results) => {
            let comment = results[0];
            let sha = results[1];
            assert(sha === comment.commit_id);

            prContext.commentId = comment.id;
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

