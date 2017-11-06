const fs = require('fs');
const http = require('http');
const createHandler = require('github-webhook-handler');
const nodeGithub = require('github');

///////////////////////////////////////////////////////////////////////////////////////////////////
// Setup
///////////////////////////////////////////////////////////////////////////////////////////////////

const CONFIG = JSON.parse(fs.readFileSync('config.js'));
const HANDLER = createHandler({ path: CONFIG.github_webhook_path, secret: CONFIG.github_webhook_secret });
const GITHUB = new nodeGithub({ version: "3.0.0" });
const GITHUB_AUTHENTICATION = { type: 'token', username: CONFIG.github_username, token: CONFIG.github_token };

///////////////////////////////////////////////////////////////////////////////////////////////////
// PR state representation
///////////////////////////////////////////////////////////////////////////////////////////////////

// PRs contains status about incomplete pr's:
// {
//     'https://api.github.com/repos/dgmltn/api-test/pulls/5': {
//         head_sha: 'abcd1234...',
//         ref: 'my-pull-request',
//         checks: {
//             'context1': true|false,
//             'context2': true|false
//         },
//         reviews: {
//             'user1': true|false,
//             'user2': true|false
//         },
//         mergeable: true|false
//     }
// }
let prs = {};

// commits references a pr url to a commit sha:
// {
//     'abcd1234...': 'https://github.com/dgmltn/api-test/pull/5',
// }
let commits = {};

///////////////////////////////////////////////////////////////////////////////////////////////////
// Webhook Handlers
///////////////////////////////////////////////////////////////////////////////////////////////////

http.createServer((req, res) => {
  HANDLER(req, res, (err) => {
    res.statusCode = 404;
    res.end('no such location');
  });
}).listen(CONFIG.port);

HANDLER.on('error', (err) => {
  console.error('Error:', err.message);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestreviewevent
HANDLER.on('pull_request_review', (event) => {
    const url = event.payload.pull_request.url;
    const headSha = event.payload.pull_request.head.sha;
    const ref = event.payload.pull_request.head.ref;
    console.log(url + " -> pull_request_review");
    ensurePr(url, headSha);
    prs[url].ref = ref;
    populateMergeable(url);
    populateReviews(url);
    mergeIfReady(url);
});

// https://developer.github.com/v3/activity/events/types/#pullrequestevent
HANDLER.on('pull_request', (event) => {
    const url = event.payload.pull_request.url;
    const headSha = event.payload.pull_request.head.sha;
    const ref = event.payload.pull_request.head.ref;
    console.log(url + " -> pull_request");
    ensurePr(url, headSha);
    prs[url].ref = ref;
    populateMergeable(url);
    populateReviews(url);
    mergeIfReady(url);
});

// https://developer.github.com/v3/activity/events/types/#statusevent
HANDLER.on('status', (event) => {
    const sha = event.payload.sha;
    const context = event.payload.context;
    const state = event.payload.state;
    let success = false;
    switch (state) {
        case 'success':
            success = true;
            break;
        case 'pending':
        case 'failure':
        case 'error':
            // success = false, still
            break;
        default:
            console.error("Unknown check state '" + state + "'. success = false");
            break;
    }

    const processUrl = (err, url) => {
        if (err) {
            console.error(err);
            return;
        }

        console.log(url + " -> status");
        ensurePr(url, sha);
        prs[url].checks[context] = success;
        populateMergeable(url);
        populateReviews(url);
        mergeIfReady(url);
    };

    if (sha in commits) {
        processUrl(null, commits[sha]);
    }
    else {
        const owner = event.payload.repository.owner.login;
        const repo = event.payload.repository.name;
        lookupPullRequest(owner, repo, sha, processUrl);
    }
});

///////////////////////////////////////////////////////////////////////////////////////////////////
// Private helpers
///////////////////////////////////////////////////////////////////////////////////////////////////

// Initialize an empty pr
function ensurePr(url, headSha) {
    if (!(url in prs)) {
        prs[url] = {};
    }
    if (!('headSha' in prs[url]) || prs[url].headSha !== headSha) {
        prs[url].headSha = headSha;
        prs[url].checks = {};
        prs[url].reviews = {};
        prs[url].mergeable = false;
    }
    commits[headSha] = url;
}

// GET pull requests and check their mergeable status
function populateMergeable(url) {
    setTimeout(() =>  {
        const params = parsePullRequestUrl(url);
        GITHUB.pullRequests.get(params,
            (err, pr) => {
                if (!(url in prs)) {
                    console.error(url + " not found in prs hash");
                    return;
                }
                prs[url].mergeable = !!pr.data.mergeable;
                mergeIfReady(url);
            }
        );
    }, 10000);
}

// GET pr reviews and check their approved status. Replace existing reviews.
function populateReviews(url) {
    console.log("populateReviews(" + url + ")");
    const params = parsePullRequestUrl(url);
    GITHUB.pullRequests.getReviews(params,
        (err, res) => {
            if (!(url in prs)) {
                console.error(url + " not found in prs hash");
                return;
            }

            // A bug in 'github' node module?
            if ('data' in res) { res = res.data; }

            prs[url].reviews = {};
            for (let i in res) {
                console.log("i = " + i);
                let review = res[i];
                console.log("review = " + JSON.stringify(review, null, " "));
                let user = review.user.login;
                // Since reviews are returned in chronological order, the last
                // one found is the most recent. We'll use that one.
                let approved = review.state.toLowerCase() === 'approved';
                prs[url].reviews[user] = approved;
            }

            mergeIfReady(url);
        }
    );
}

// Perform a merge on this PR if:
// 1. it's mergeable
// 2. >1 reviews exist and all are approved
// 3. >1 checks exist and all passed
function mergeIfReady(url) {
    console.log(JSON.stringify(prs, null, 4));
    if (url in prs
        && !prs[url].done
        && isMergeable(prs[url])
        && isApproved(prs[url])
        && checksPassed(prs[url])) {

        // APPROVED!
        prs[url].done = true;
        console.log("APPROVED (" + url + ")!");

        const deleteCallback = (err, res) => {
            if (err) {
                console.error("Error: could not delete ref: " + err);
                return;
            }
            delete prs[url];
            console.log("DELETED (" + url + ")!");
        };

        const mergeCallback = (err, res) => {
            if (err) {
                console.error("Error: could not merge: " + err);
                delete prs[url].done;
                return;
            }
            console.log("MERGED (" + url + ")!");

            if (CONFIG.delete_after_merge) {
                deleteReference(url, deleteCallback);
            }
        };

        mergePullRequest(url, mergeCallback);
    }
}

function mergePullRequest(url, callback) {
    if (!(url in prs)) {
        console.error(url + " not found in prs hash");
        return;
    }
    const params = parsePullRequestUrl(url);
    params.sha = prs[url].headSha;
    GITHUB.authenticate(GITHUB_AUTHENTICATION);
    GITHUB.pullRequests.merge(params, callback);
}

function deleteReference(url, callback) {
    if (!(url in prs)) {
        console.error(url + " not found in prs hash");
        return;
    }
    const params = parsePullRequestUrl(url);
    params.ref = 'heads/' + prs[url].ref;
    GITHUB.authenticate(GITHUB_AUTHENTICATION);
    GITHUB.gitdata.deleteReference(params, callback);
}

// Finds the PR URL associated with the given head SHA
function lookupPullRequest(owner, repo, sha, callback) {
    const params = {
        owner: owner,
        repo: repo
    };
    GITHUB.pullRequests.getAll(params, (err, res) => {
        if (err) {
            console.log("err with pr.get: " + err);
            callback(err, null);
            return;
        }

        for (let i in res.data) {
            const pr = res.data[i];
            if (pr.head.sha === sha) {
                const url = pr.url;
                callback(null, url);
                return;
            }
        }

        callback("PR not found: (" + owner + ", " + repo + ", " + sha + ")", null);
    });
}

function parsePullRequestUrl(url) {
    const re = /^https?:\/\/([^/]+)\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/;
    const match = re.exec(url);
    return {
        owner: match[2],
        repo: match[3],
        number: match[4]
    };
}

function isMergeable(obj) {
    return 'mergeable' in obj && !!obj.mergeable;
}

function isApproved(obj) {
    if (!('reviews' in obj)) {
        return false;
    }
    else if (Object.keys(obj.reviews).length <= 0) {
        return false;
    }
    for (let id in obj.reviews) {
        if (!obj.reviews[id]) {
            return false;
        }
    }
    return true;
}

function checksPassed(obj) {
    if (!('checks' in obj)) {
        return false;
    }
    else if (Object.keys(obj.checks).length <= 0) {
        return false;
    }
    for (let context in obj.checks) {
        if (!obj.checks[context]) {
            return false;
        }
    }
    return true;
}
