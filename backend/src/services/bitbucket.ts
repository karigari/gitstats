import * as moment from "moment";
import * as types from "../types";
import * as rp from "request-promise-native";
import * as url from "url";
import { getComparativeDurations, getComparativeCounts } from "./utils";
import {
  Team,
  Repo,
  Member,
  PullsAPIResult,
  CommitsAPIResult,
  RepoStats,
  Commit
} from "gitstats-shared";
import { ServiceClient } from "./base";

export default class BitbucketService extends ServiceClient {
  baseUrl: string;
  periodPrev: moment.Moment;
  periodNext: moment.Moment;

  constructor(
    public token: string,
    public owner: string,
    public weekStart: moment.Moment
  ) {
    super(token, owner, weekStart);
    this.baseUrl = "https://api.bitbucket.org/2.0/";

    // We use Sunday-Saturday as the definition of the week
    // This is because of how the Github stats API returns weeks
    this.periodPrev = moment(this.weekStart).subtract(1, "weeks");
    this.periodNext = moment(this.weekStart);
  }

  private isInDuration(date: string, minDateValue: moment.Moment) {
    return (
      moment(date) > minDateValue &&
      moment(date) <
        moment()
          .utc()
          .startOf("week")
    );
  }

  private get({ path, qs }) {
    return rp({
      baseUrl: this.baseUrl,
      uri: path,
      headers: {
        Authorization: `Bearer ${this.token}`
      },
      qs,
      json: true
    });
  }

  private getAll({ path, qs }, aggregateValues) {
    return this.get({ path, qs }).then(response => {
      const { values, next } = response;
      const newAggregate = [...aggregateValues, ...values];

      if (next) {
        const { query } = url.parse(next, true);
        return this.getAll({ path, qs: { ...qs, ...query } }, newAggregate);
      } else {
        return newAggregate;
      }
    });
  }

  // This method accesses arbitrarily nested property of an object
  // Source https://medium.com/javascript-inside/safely-accessing-deeply-nested-values-in-javascript-99bf72a0855a
  private access = (p, o) =>
    p.reduce((xs, x) => (xs && xs[x] ? xs[x] : null), o);

  private getAllTillDate({ path, qs }, aggregateValues, key, minDateValue) {
    // Assumes the response is sorted in desc by key (which is true for commits)
    // key can be a nested field (using .) or a combination of fields (using ,)
    // eg, key as update.date,comment.created_on checks for two nested fields
    return this.get({ path, qs }).then(response => {
      const { values, next } = response;
      const filtered = values.filter(value => {
        const allKeys = key.split(",");
        let keyValue;

        allKeys.forEach(key => {
          const result = this.access(key.split("."), value);
          if (result) {
            keyValue = result;
          }
        });

        return !keyValue || moment(keyValue) > minDateValue;
      });

      if (filtered.length < values.length) {
        // We have all the data
        const newAggregate = [...aggregateValues, ...filtered];
        return newAggregate;
      }

      // We will need next page if available
      const newAggregate = [...aggregateValues, ...values];

      if (next) {
        const { query } = url.parse(next, true);
        return this.getAllTillDate(
          { path, qs: { ...qs, ...query } },
          newAggregate,
          key,
          minDateValue
        );
      } else {
        return newAggregate;
      }
    });
  }

  private getCommonQueryParams() {
    const lastDate = this.periodPrev.toISOString().substr(0, 10);
    return { sort: "-updated_on", q: `updated_on>=${lastDate}` };
  }

  private buildRepeatedQueryParams(key, values) {
    // eg, state=OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED
    // This method will return "OPEN&state=MERGED&state=DECLINED&state=SUPERSEDED"
    return values.join(`&${key}=`);
  }

  // TODO: delete this
  report = async (): Promise<types.Report> => {
    const responses = await Promise.all([this.repos(), this.members()]);
    let response = {
      members: responses[1],
      repos: responses[0]
    };

    const { repos } = response;
    const prs = repos.map(repo => this.pulls(repo.name));
    const pullsValues = await Promise.all(prs);
    let repoResult = [];
    let index;

    for (index = 0; index < repos.length; index++) {
      repoResult.push({ ...repos[index], prs: pullsValues[index] });
    }

    return {
      ...response,
      repos: repoResult
    };
  };

  emailReport = async () => {
    const responses = await Promise.all([this.repos(), this.ownerInfo()]);
    let response = {
      period: { previous: this.periodPrev, next: this.periodNext },
      owner: responses[1],
      repos: responses[0]
    };

    const { repos } = response;
    const stats = repos.map(repo => this.statistics(repo.name));
    const statsValues = await Promise.all(stats);
    let repoResult = [];
    let index;

    for (index = 0; index < repos.length; index++) {
      repoResult.push({ ...repos[index], stats: statsValues[index] });
    }
    return {
      ...response,
      repos: repoResult
    };
  };

  repos = async (): Promise<Repo[]> => {
    const values = await this.getAll(
      {
        path: `repositories/${this.owner}`,
        qs: { ...this.getCommonQueryParams() }
      },
      []
    );
    return values.map(repo => ({
      name: repo.slug,
      url: repo.links.html.href,
      description: repo.description,
      is_private: repo.is_private,
      is_fork: false,
      stargazers_count: 0,
      updated_at: repo.updated_on,
      stats: { is_pending: true }
    }));
  };

  members = async (): Promise<Member[]> => {
    const values = await this.getAll(
      {
        path: `teams/${this.owner}/members`,
        qs: {}
      },
      []
    );
    return values.map(member => ({
      login: member.username,
      name: member.display_name,
      avatar: member.links.avatar.href
    }));
  };

  ownerInfo = async (): Promise<Team> => {
    const team = await this.get({
      path: `teams/${this.owner}`,
      qs: {}
    });
    return {
      login: team.username,
      name: team.display_name,
      avatar: team.links.avatar.href,
      service: "bitbucket"
    };
  };

  private pullsApi(repo: string) {
    return this.getAll(
      {
        path: `repositories/${this.owner}/${repo}/pullrequests`,
        qs: {
          ...this.getCommonQueryParams(),
          fields: `-values.description,-values.destination,-values.summary,-values.source,-values.closed_by`,
          state: this.buildRepeatedQueryParams("state", [
            "MERGED",
            "SUPERSEDED",
            "OPEN",
            "DECLINED"
          ])
        }
      },
      []
    );
  }

  private async prActivityApi(repo: string) {
    const params = {
      path: `repositories/${this.owner}/${repo}/pullrequests/activity`,
      qs: {}
    };
    const response = await this.getAllTillDate(
      params,
      [],
      "update.date,comment.created_on",
      this.periodPrev
    );
    return response;
  }

  // TODO: delete this
  pulls(repo: string): Promise<types.RepoPR[]> {
    return this.pullsApi(repo).then(values => {
      let authorWisePRs = {};
      values.forEach(pr => {
        const { username } = pr.author;
        if (username in authorWisePRs) {
          authorWisePRs[username] = [].concat(pr, ...authorWisePRs[username]);
        } else {
          authorWisePRs[username] = [pr];
        }
      });

      // TODO: not sure if updated is a good proxy for merged_at
      // we can use the time of the merge commit
      return Object.keys(authorWisePRs).map(author => {
        const pulls = authorWisePRs[author];
        return {
          author,
          prs_opened: getComparativeCounts(pulls, "created_on"),
          prs_merged: getComparativeCounts(
            pulls.filter(p => p.state === "MERGED"),
            "updated_on"
          ),
          time_to_merge: getComparativeDurations(
            pulls.filter(p => p.state === "MERGED"),
            "updated_on",
            "created_on"
          )
        };
      });
    });
  }

  pullsV2 = async (repo: string): Promise<PullsAPIResult> => {
    const responses = await Promise.all([
      this.pullsApi(repo),
      this.prActivityApi(repo)
    ]);
    const pulls = responses[0];
    const prActivity = responses[1];

    const filteredPulls = pulls
      .filter(pr => moment(pr.updated_on) > this.periodPrev)
      .map(pr => ({
        author: pr.author.username,
        title: pr.title,
        number: pr.id,
        created_at: pr.created_on,
        merged_at: pr.state === "MERGED" ? pr.updated_on : null,
        closed_at: pr.state === "MERGED" ? pr.updated_on : null,
        updated_at: pr.updated_on,
        state: pr.state,
        url: pr.links.html.href
      }));

    const result = filteredPulls.map(pr => ({
      ...pr,
      commits: prActivity
        .filter(value => {
          const { update, pull_request } = value;
          return !!update && pull_request.id === pr.number;
        })
        .map(value => ({
          date: value.update.date,
          author: value.update.author ? value.update.author.username : null
        })),
      comments: prActivity
        .filter(value => {
          const { comment, pull_request } = value;
          return !!comment && pull_request.id === pr.number;
        })
        .map(value => ({
          date: value.comment.created_on,
          author: value.comment.user.username
        }))
    }));

    return {
      repo,
      pulls: result
    };
  };

  // TODO: delete this
  prActivity = async () => {
    const repos = await this.repos();
    const promises = repos.map(repo => this.pullsV2(repo.name));
    const responses = await Promise.all(promises);
    return responses;
  };

  private getWeekValues = (numWeeks, commits) => {
    const indexNumbers = Array.from(Array(numWeeks).keys());
    return indexNumbers.map(index => {
      const start = moment(this.periodNext).subtract(index, "weeks");
      const end = moment(start).add(1, "weeks");

      return {
        week: start.unix(),
        value: commits.filter(
          c => moment(c.date) > start && moment(c.date) < end
        ).length
      };
    });
  };

  // TODO: delete this
  statistics = async (repo: string) => {
    const NUM_WEEKS = 5;
    const minDateValue = moment(this.periodNext).subtract(
      NUM_WEEKS - 1,
      "weeks"
    );
    const response = await this.repoCommits(repo, minDateValue);
    const authors = Object.keys(response);

    const result: types.AuthorStats[] = authors.map(author => {
      const commits = response[author];
      return {
        login: author,
        commits: this.getWeekValues(NUM_WEEKS, commits),
        lines_added: [],
        lines_deleted: []
      };
    });

    return { is_pending: false, authors: result };
  };

  async repoCommits(repo: string, minDateValue: moment.Moment) {
    // Returns all commits in the repo, all branches
    // https://developer.atlassian.com/bitbucket/api/2/reference/resource/repositories/%7Busername%7D/%7Brepo_slug%7D/commits
    const values = await this.getAllTillDate(
      {
        path: `repositories/${this.owner}/${repo}/commits`,
        qs: {
          // does not support filtering: https://developer.atlassian.com/bitbucket/api/2/reference/meta/filtering
          fields: `-values.repository,-values.links,-values.summary,-values.parents`
        }
      },
      [],
      "date",
      minDateValue
    );

    let authorWiseCommits = {};
    values.forEach(commit => {
      const { date } = commit;
      const isInDuration = this.isInDuration(date, minDateValue);
      const { user, raw } = commit.author;
      // This user might not have a linked bitbucket account
      // eg, raw is `Tarun Gupta <tarungupta@Taruns-MacBook-Pro.local>`
      if (user && isInDuration) {
        const { username } = user;

        if (username in authorWiseCommits) {
          authorWiseCommits[username] = [].concat(
            commit,
            ...authorWiseCommits[username]
          );
        } else {
          authorWiseCommits[username] = [commit];
        }
      }
    });

    return authorWiseCommits;
  }

  // TODO: delete this
  allCommits = async (): Promise<types.Commits[]> => {
    const repos = await this.repos();
    const promises = repos.map(repo =>
      this.repoCommits(repo.name, this.periodPrev)
    );
    const responses = await Promise.all(promises);

    return responses.map((response, idx) => {
      const authors = Object.keys(response);
      let result = [];
      authors.forEach(author => {
        const commits = response[author].map(commit => ({
          date: commit.date,
          sha: commit.hash,
          message: commit.message
        }));
        result.push({ author, commits });
      });

      return {
        repo: repos[idx].name,
        commits: result
      };
    });
  };

  commitsV2 = async (repo: string): Promise<CommitsAPIResult> => {
    const NUM_WEEKS = 5;
    const minDateValue = moment(this.periodNext).subtract(
      NUM_WEEKS - 1,
      "weeks"
    );
    const response = await this.repoCommits(repo, minDateValue);
    const authors = Object.keys(response);
    const stats: RepoStats[] = authors.map(author => {
      const commits = response[author];
      return {
        author,
        commits: this.getWeekValues(NUM_WEEKS, commits)
      };
    });

    let commits: Commit[] = [];
    const minDate = this.periodPrev;
    authors.forEach(author => {
      const authorCommits: Commit[] = response[author].map(commit => ({
        author,
        date: commit.date,
        sha: commit.hash,
        message: commit.message
      }));
      commits = [
        ...commits,
        ...authorCommits.filter(({ date }) => this.isInDuration(date, minDate))
      ];
    });

    return {
      repo,
      is_pending: false,
      stats,
      commits
    };
  };
}
