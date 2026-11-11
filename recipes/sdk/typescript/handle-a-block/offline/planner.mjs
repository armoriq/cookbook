// Offline stand-in for src/planner.js: keywords in, steps out, same plan() signature, no Gemini.

export const MODEL = 'offline-rule-planner';

export async function plan(goal, tools, { avoid = [], done = [] } = {}) {
  const text = goal.toLowerCase();
  const build = text.match(/(checkout|payments) build (\d+)/);
  const target = build ? { service: build[1], build_id: build[2] } : {};
  const env = text.match(/(staging-[a-z]+)/);
  let steps;

  if (env && (text.includes('tear down') || text.includes('delete'))) {
    steps = avoid.includes('delete_environment')
      // The direct route was refused, so ask a human to do it instead.
      ? [{ action: 'request_teardown', params: { environment: env[1], reason: goal } }]
      : [{ action: 'list_environments', params: {} }, { action: 'delete_environment', params: { name: env[1] } }];
  } else if (text.includes('smoke')) {
    steps = [{ action: 'run_smoke_tests', params: { ...target } }, { action: 'deploy_to_staging', params: { ...target } }];
  } else if (text.includes('production')) {
    steps = [{ action: 'get_build_status', params: { ...target } }, { action: 'deploy_to_production', params: { ...target } }];
  } else {
    steps = [{ action: 'get_build_status', params: { ...target } }, { action: 'deploy_to_staging', params: { ...target } }];
  }
  return steps.filter((s) => !avoid.includes(s.action) && !done.includes(s.action));
}
