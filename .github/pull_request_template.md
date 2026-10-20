## What changed

## Safety impact

Tick every box that applies. Any ticked box needs a short note below and review against docs/clinical-safety.md.

- [ ] Patient identity (prediction, confirmation, session patient lock, reassignment)
- [ ] Clinical content (generation, safety checks, templates, Agent Knowledge rules, prompts or models)
- [ ] Record integrity or delivery to Dentally
- [ ] Data loss or failure handling
- [ ] Security, access rules, secrets or audit trail
- [ ] Retention or deletion
- [ ] None of the above

Notes:

## Checks

- [ ] `npm run typecheck && npm test && npm run check:shared && npm run build` pass
- [ ] No real patient data anywhere (code, tests, screenshots, this description)
- [ ] Docs updated if behaviour changed (hazard log if clinical behaviour changed)
