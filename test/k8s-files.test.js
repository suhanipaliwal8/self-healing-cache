import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCluster } from '../src/config.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('k8s: the StatefulSet has stable names, a numeric non-root user and health probes', () => {
  const sts = read('k8s/statefulset.yaml');
  assert.match(sts, /^kind: StatefulSet$/m);
  assert.match(sts, /^ {2}serviceName: cache\b/m); // must be the headless Service
  assert.match(sts, /^ {2}podManagementPolicy: Parallel\b/m);
  assert.match(sts, /^ {2}minReadySeconds: 10\b/m);
  assert.match(sts, /runAsNonRoot: true/);
  assert.match(sts, /runAsUser: 1000\b/);
  assert.match(sts, /readinessProbe:\s+httpGet:\s+path: \/health/);
  assert.match(sts, /livenessProbe:\s+httpGet:\s+path: \/health/);
  // the pod name becomes the node id
  assert.match(sts, /name: NODE_ID\s+valueFrom:\s+fieldRef:\s+fieldPath: metadata\.name/);
});

test('k8s: the CLUSTER list matches the replica count and uses the headless Service names', () => {
  const sts = read('k8s/statefulset.yaml');
  const replicas = Number(sts.match(/^ {2}replicas: (\d+)/m)[1]);
  const cluster = sts.match(/name: CLUSTER\s+value: "([^"]+)"/);
  assert.ok(cluster, 'CLUSTER value not found');

  const members = parseCluster(cluster[1]);
  const expectedIds = Array.from({ length: replicas }, (_, i) => `cache-${i}`);
  assert.deepEqual(members.map((m) => m.id), expectedIds);
  for (const member of members) {
    assert.equal(member.url, `http://${member.id}.cache:3000`); // <pod>.<serviceName>:port
  }
});

test('k8s: the headless Service has no cluster IP and publishes pods before they are Ready', () => {
  const services = read('k8s/services.yaml');
  const parts = services.split(/^---$/m);
  const headless = parts.find((part) => /^ {2}name: cache$/m.test(part));
  const client = parts.find((part) => /^ {2}name: cache-client$/m.test(part));

  assert.ok(headless, 'headless Service "cache" not found');
  assert.match(headless, /clusterIP: None\b/);
  assert.match(headless, /publishNotReadyAddresses: true\b/);
  assert.ok(client, 'Service "cache-client" not found');
  assert.doesNotMatch(client, /clusterIP: None/); // this one load-balances
});