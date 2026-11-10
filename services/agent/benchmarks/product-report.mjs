const percentile = (values, p) => {
  const sorted = values.filter(value => typeof value === 'number').sort((a,b) => a-b);
  return sorted.length ? sorted[Math.ceil(sorted.length*p)-1] : null;
};

export function aggregate(rows) {
  const responsive = rows.filter(row => !row.error);
  return {
    runs: rows.length,
    tool_hits: rows.reduce((n,row) => n+row.found.length,0),
    required_tools: rows.reduce((n,row) => n+row.expected.length,0),
    completed: rows.filter(row => row.complete).length,
    errors: rows.length-responsive.length,
    elapsed_p50_ms: percentile(responsive.map(row => row.elapsed_ms),0.5),
    elapsed_p95_ms: percentile(responsive.map(row => row.elapsed_ms),0.95),
    first_text_p50_ms: percentile(responsive.map(row => row.first_text_ms),0.5),
    model_requests: rows.reduce((n,row) => n+row.model_requests,0),
    tokens: rows.reduce((n,row) => n+row.tokens,0),
  };
}

const metrics = ['completed','tool_hits','errors','elapsed_p50_ms','elapsed_p95_ms','first_text_p50_ms','model_requests','tokens'];
function differences(current, baseline) {
  return Object.fromEntries(metrics.map(key => [
    key, current[key] === null || baseline[key] === null ? null : current[key]-baseline[key],
  ]));
}

export function compareRuns(current, baseline) {
  if (!baseline) return { status:'no_baseline' };
  const identity = ['report_schema','suite_sha256','harness','model_fingerprint','repeats','concurrency'];
  const mismatches = identity.filter(key => current[key] !== baseline[key]);
  if (JSON.stringify(current.scenarios) !== JSON.stringify(baseline.scenarios)) mismatches.push('scenarios');
  if (current.kind !== 'product_regression' || baseline.kind !== 'product_regression') mismatches.push('kind');
  if (mismatches.length) return { status:'incompatible', mismatches };
  const per_case = current.scenarios.map(id => {
    const before = aggregate(baseline.rows.filter(row => row.scenario === id));
    const after = aggregate(current.rows.filter(row => row.scenario === id));
    const delta = differences(after,before);
    return { id, baseline:before, current:after, delta };
  });
  return {
    status:'compared', baseline_run:baseline.run_id,
    delta:differences(current.summary.current,baseline.summary.current),
    regressions:per_case.filter(item => item.delta.completed < 0 || item.delta.tool_hits < 0 || item.delta.errors > 0).map(item => item.id),
    improvements:per_case.filter(item => item.delta.completed > 0 || item.delta.tool_hits > 0 || item.delta.errors < 0).map(item => item.id),
    per_case,
  };
}

export function serializeReport(report) {
  return JSON.stringify(report,null,2) + '\n';
}
