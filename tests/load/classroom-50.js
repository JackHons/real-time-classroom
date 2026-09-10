/* global __ENV, __VU */
/*
 * k6 LAN acceptance scenario. Provision a disposable class and export its
 * values as K6_BASE_URL, K6_CLASS_ID, K6_STUDENT_COOKIE_0..49 and
 * K6_STUDENT_CSRF_0..49 before running: k6 run tests/load/classroom-50.js
 *
 * The portable `pnpm test:load` runner exercises the same contract against an
 * ephemeral real server and writes a JSON artifact. k6 is intentionally
 * opt-in because it must target an operator-provisioned LAN instance.
 */
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const base = __ENV.K6_BASE_URL;
const classId = __ENV.K6_CLASS_ID;
const failures = new Rate('classroom_failures');
const requestLatency = new Trend('classroom_request_latency', true);

export const options = {
  scenarios: { fifty_students: { executor: 'per-vu-iterations', vus: 50, iterations: 1, maxDuration: '2m' } },
  thresholds: { classroom_failures: ['rate==0'], classroom_request_latency: ['p(95)<2000'], http_req_failed: ['rate==0'] }
};

export default function () {
  if (!base || !classId) throw new Error('K6_BASE_URL and K6_CLASS_ID are required');
  const index = __VU - 1;
  const cookie = __ENV[`K6_STUDENT_COOKIE_${index}`];
  if (!cookie) throw new Error(`student fixture ${index} is missing`);
  const response = http.get(`${base}/api/student/activities`, { headers: { Cookie: cookie } });
  requestLatency.add(response.timings.duration);
  failures.add(!check(response, { 'student session survives load': (r) => r.status === 200 }));
  sleep(0.1);
}
