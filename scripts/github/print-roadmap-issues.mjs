#!/usr/bin/env node
// Prints the per-phase issue tables used in docs/roadmap.md, so the roadmap and backlog stay in step.
import { milestones, issues } from './backlog.mjs';

const flags = (labels) =>
  [
    labels.includes('safety-critical') ? 'safety' : null,
    labels.includes('decision-needed') ? 'decision' : null,
    labels.includes('blocked-external') ? 'blocked' : null,
    labels.includes('status:started') ? 'started' : null,
  ]
    .filter(Boolean)
    .join(', ');

for (const m of milestones) {
  console.log(`\n#### ${m.title}\n`);
  console.log('| ID | Issue | Flags |');
  console.log('|---|---|---|');
  for (const i of issues.filter((x) => x.milestone === m.key)) {
    console.log(`| ${i.id} | ${i.title} | ${flags(i.labels)} |`);
  }
}
