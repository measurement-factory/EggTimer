# EggTimer

A GitHub webhook driven bot that merges Pull Requests when they're ready.

EggTimer runs as a node script, listening to events (webhooks) from a GitHub
repository. Eligible events are: 'pull request', 'pull request review' and
'status'. When the bot starts up or receives one of listed events, it requests
Github for open PRs and starts processing them.

### PR processing

Generally, a PR processing iteration consists of the following steps:

1. Get open PR list from Github.
2. Find a PR suitable for merging. Stop processing if there are no more such PRs.
3. Force CIs to start checking 'merge revision', which is the merged product of the base branch(usually master) and PR branch.
4. Place 'merge revision' into the HEAD of the base branch, IFF all required CI tests have succeeded.
5. Go to (2).

In the end of such iteration, all ready-for-merge PRs should be merged.


### PR processing details

#### PR labeling

For Github users convenience, EggTimer marks in-process PR with several labels, depending on
the merge step status:

* S-merging, (2) OK.
* S-autochecks-failed, (3) failed.
* S-merge-ready, (3) OK.
* S-merge-failed, (4) failed.
* S-merged, (4) OK.

Note that all labels, except 'S-merged' have only informational purpose and are
ignored by the bot (e.g., if they were set manually by a Github user).


#### PR selecting

 PR is considered as 'ready-for-merge', if all its required statuses are
'green':

* The PR has Github 'mergeable' status.
* All PR required status checks succeeded.
* The PR is approved by one or more core developers(with repository push rights).
* The PR is not labeled as 'merged' (S-merged label). Though this is not a standard
  PR status, this helps to avoid merging of an already merged PR.


#### PR approving

The bot essentially implements the official voting
[requirements](https://wiki.squid-cache.org/MergeProcedure), with some
differences:

* For reliability sake, only approvals of core developers are considered.

* In order to let all interested core developers to review a PR, there is a
  so-called 'rejection period'. This period starts from the PR creation date
  date and lasts for 2 days(by default). The bot will not attempt to merge
  the PR during this period.

* The bot will merge PR just after 'rejection period' if it was approved by
  several core developers (>=2). If PR author is a core develper, its vote
  is automatically appended.

* One negative vote by a core developer blocks the merge until resolved
  (unchanged, placed here for completeness).

* PRs with only one core developer approval (and no rejections) will be
  accepted after a 8 days period (starting from the end of 'reject period').
  Overall 10 days delay is preserved.


#### PR merging

If all 'merge revision' checks were successful, the revision is placed into the
base's HEAD (base is fast-forwarded into it), and the bot closes this PR. Note
that Github is not able to determine that PR was merged in a way, other from
standard Github 'merge button', and does not mark the PR with 'merged' status.
Instead, it shows a confusing message:

```
This pull request is closed, but the 'branch' branch has unmerged commits.
```

As a consequence, an irresponsible user can re-open such already merged PR
causing more confusion. The 'S-merged' label should help to distinguish such
situations. What if 'merge revision' checks failed? A PR user will know that,
noticing 'S-autochecks-failed' label and examining 'merge revision' checks
statuses (showed on PR's conversation tab). The failure reason may vary and
be unrelated to the PR itself (e.g., a problem in the base branch,
revealed after merging). Obviously, there is no reason to repeat
these checks for unchanged code, so the bot will re-attempt merging this PR
only after 'merge revision' has been changed (i.e., base branch and(or) PR
branch have been changed).


#### Error handling

During its operation, EggTimer can face various 'unexpected' errors, such as
general network problems, Github errors(e.g., HTTP 500 error) or internal
configuration errors. In order to eliminate wasting Github API resources and
logging useless identical error messages, the bot will wait for a period (10
minutes by default), and then re-try merge iteration.


#### Concurrency

Currently, no concurrency is supported, the bot can merge only one PR at a
time. A being-in-merge PR can not be interrupted by other Github events:
EggTimer will flag such event and start PR processing iteration only after
finishing the current one.


#### Is it safe to restart the bot?

EggTimer was designed as a stateless PR processing bot, with a possibility to be
restarted anytime it is needed. It manipulates git repository via Github
API calls (without cloning), all required information is requested from Github
during a PR processing iteration. If the bot was terminated for a reason while
merging a PR and started again, it will search for being-in-merge PR, restore
its merging context and finish the merging as needed.


### Configuration

EggTimer is meant to be run as a web server, which is then called by [GitHub's
webhook framework](https://developer.github.com/webhooks/). Go to your GitHub
project's Settings-&gt;Webhooks and "add webhook". The correct "payload URL"
will contain your webserver's hostname, *port*, and *github_webhook_path*
configuration. "Content type" should be `application/json` and "secret" should
match your *github_webhook_secret* configuration. The proper webhook events
needed are `Pull request` and `Pull request review` and `Status`.

Create a config.js, by cloning config-example.js:

```
cp config-example.js config.js
```

Then modify the fields to suit your needs. All fields are required. Here is an
explanation of the fields:

 *Field* | *Description* | *default*
 --- | --- | ---
*github_username* | The GitHub username as which this script will be masquerading. The user needs to have 'push' access to the repository.| -
*github_token* | An auth token generated for the associated github_username. | -
*github_webhook_path* | Path to which the EggTimer webserver should respond(this needs to be mirrored on the GitHub webhook configuration). | -
*github_webhook_secret* | A random secret string to be used here and in the GitHub webhook configuration. | -
*port* | Port of this webserver. | 7777
*repo* | Github repository name. | -
*owner* | The owner(organization) of the repository. | -
*dry_run*| A testing mode when the bot operates in a 'read-only' manner, selecting PRs for merge but skipping further merging steps. If 'true', no changes in PRs are performed. | false
*skip_merge*| A testing mode, when the bot skips the last step ( fast-forwarding base branch (usually master) into the auto_branch) | false
*auto_branch* | The name of the auto branch. | heads/auto_branch
*approval_period* | For the given PR: how many days, starting from the first approval date, the bot will wait before merge attempt | 10
*approvals_number* | The minimal number of 'core' developers required for a PR to be merged just after 'reject_period' ('approval_period' does not matter) | 2
*reject_period*| For the given PR: how many days, starting from the PR creation date, the bot will not merge this PR | 2


### Start the bot

This needs to be a publicly accessible server (or accessible from GitHub's webhooks):

```
node eggtimer.js
```

