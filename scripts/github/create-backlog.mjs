#!/usr/bin/env node
// Creates the AuraNoteTaker Pro labels, milestones and issues in a GitHub repository.
// Idempotent: existing labels, milestones and issues (matched by title) are left alone.
//
// Usage:
//   node scripts/github/create-backlog.mjs --repo hishamsaqib-create/auranotetaker-pro --dry-run
//   node scripts/github/create-backlog.mjs --repo hishamsaqib-create/auranotetaker-pro
//
// Requires the GitHub CLI (gh) authenticated with access to the repository.

import { execFileSync } from 'node:child_process';
import { labels, milestones, issues } from './backlog.mjs';

const args = process.argv.slice(2);
const repoIndex = args.indexOf('--repo');
const repo = repoIndex >= 0 ? args[repoIndex + 1] : undefined;
const dryRun = args.includes('--dry-run');

if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
  console.error('Usage: node scripts/github/create-backlog.mjs --repo <owner>/<repo> [--dry-run]');
  process.exit(1);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function gh(method, path, payload) {
  const ghArgs = ['api', '--method', method, path];
  if (payload) ghArgs.push('--input', '-');
  const out = execFileSync('gh', ghArgs, {
    input: payload ? JSON.stringify(payload) : undefined,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out.trim() ? JSON.parse(out) : null;
}

function getAll(path) {
  const results = [];
  for (let page = 1; page < 50; page += 1) {
    const sep = path.includes('?') ? '&' : '?';
    const batch = gh('GET', `${path}${sep}per_page=100&page=${page}`);
    results.push(...batch);
    if (batch.length < 100) break;
  }
  return results;
}

const issueTitle = (issue) => `[${issue.id}] ${issue.title}`;

async function main() {
  console.log(`${dryRun ? '[dry run] ' : ''}Backlog for ${repo}: ${labels.length} labels, ${milestones.length} milestones, ${issues.length} issues`);

  // Labels
  const existingLabels = new Set(getAll(`/repos/${repo}/labels`).map((l) => l.name));
  for (const label of labels) {
    if (existingLabels.has(label.name)) continue;
    console.log(`  + label ${label.name}`);
    if (!dryRun) {
      gh('POST', `/repos/${repo}/labels`, label);
      await sleep(300);
    }
  }

  // Milestones
  const existingMilestones = getAll(`/repos/${repo}/milestones?state=all`);
  const milestoneNumbers = new Map();
  for (const m of milestones) {
    const found = existingMilestones.find((em) => em.title === m.title);
    if (found) {
      milestoneNumbers.set(m.key, found.number);
      continue;
    }
    console.log(`  + milestone ${m.title}`);
    if (!dryRun) {
      const created = gh('POST', `/repos/${repo}/milestones`, { title: m.title, description: m.description });
      milestoneNumbers.set(m.key, created.number);
      await sleep(300);
    }
  }

  // Issues
  const existingTitles = new Set(
    getAll(`/repos/${repo}/issues?state=all`)
      .filter((i) => !i.pull_request)
      .map((i) => i.title),
  );
  let created = 0;
  for (const issue of issues) {
    const title = issueTitle(issue);
    if (existingTitles.has(title)) continue;
    console.log(`  + issue ${title}`);
    if (!dryRun) {
      gh('POST', `/repos/${repo}/issues`, {
        title,
        body: `${issue.body}\n\n---\nBacklog ID \`${issue.id}\`. See docs/roadmap.md for phase context and decisions.`,
        labels: issue.labels,
        milestone: milestoneNumbers.get(issue.milestone),
      });
      created += 1;
      await sleep(1000); // stay well inside GitHub's content-creation rate limits
    }
  }
  console.log(dryRun ? 'Dry run complete. Nothing was created.' : `Done. Created ${created} issues.`);
}

main().catch((err) => {
  console.error(err.stderr?.toString() || err.message);
  process.exit(1);
});
