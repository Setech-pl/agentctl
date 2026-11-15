Verdict: PASS
<!-- agentctl:attempt hems-feedback -->
HEMS report with nonstandard outputs.
```agentctl-outputs
schema_version: 1
version: 1
verdict: PASS
commits: [{repo: hems, branch: work, sha: [abc1234, def5678]}]
checks: [{unit: pass}, "smoke: PASS", {name: suite, result: pass}]
```
<!-- agentctl:report-end -->
