"""Offline topology checks. Requires Helm, Node.js and PyYAML; never calls kubectl."""
import ipaddress
import json
from pathlib import Path
import subprocess
import unittest
import yaml

ROOT = Path(__file__).resolve().parent.parent
COMPONENT = 'app.kubernetes.io/component'
PART = 'app.kubernetes.io/part-of'

def render(chart, namespace='crap', *args):
    return list(filter(None, yaml.safe_load_all(subprocess.check_output(
        ['helm', 'template', chart, str(ROOT / 'k8s/helm' / chart), '--namespace', namespace,
         '--kube-version', '1.30.0', *args], text=True))))

DOCS = render('crap') + render('cliproxy')
POLICIES = [d for d in DOCS if d['kind'] == 'NetworkPolicy']

def labels(role):
    return {PART: 'crap', COMPONENT: role}

def matches(selector, values):
    if any(values.get(k) != v for k, v in selector.get('matchLabels', {}).items()):
        return False
    for expr in selector.get('matchExpressions', []):
        if expr['operator'] != 'In':
            raise AssertionError('Extend evaluator for new selector operator')
        if values.get(expr['key']) not in expr['values']:
            return False
    return True

def permitted(role, direction, port, peer_role=None, peer_ns='crap', peer_labels=None, ip=None, protocol='TCP'):
    selected = [d['spec'] for d in POLICIES if matches(d['spec']['podSelector'], labels(role))
                and direction.title() in d['spec']['policyTypes']]
    if not selected:
        return True
    for spec in selected:
        for rule in spec.get(direction, []):
            if 'ports' in rule and not any(p['port'] == port and p.get('protocol', 'TCP') == protocol for p in rule['ports']):
                continue
            peers = rule.get('to' if direction == 'egress' else 'from', [{}])
            for peer in peers:
                if 'ipBlock' in peer:
                    block = peer['ipBlock']
                    if ip and ipaddress.ip_address(ip) in ipaddress.ip_network(block['cidr']) and not any(
                        ipaddress.ip_address(ip) in ipaddress.ip_network(c) for c in block.get('except', [])):
                        return True
                    continue
                if ip:
                    continue
                ns_match = matches(peer['namespaceSelector'], {'kubernetes.io/metadata.name': peer_ns}) if 'namespaceSelector' in peer else peer_ns == 'crap'
                pod_match = matches(peer.get('podSelector', {}), peer_labels if peer_labels is not None else labels(peer_role))
                if ns_match and pod_match:
                    return True
    return False

class Recipes(unittest.TestCase):
    def test_rendered_files_are_current(self):
        subprocess.run(['node', str(ROOT / 'k8s/render.mjs'), '--check'], check=True)

    def test_no_duplicate_resources_or_embedded_secrets(self):
        names = [(d['kind'], d['metadata']['name']) for d in DOCS]
        self.assertEqual(len(names), len(set(names)))
        self.assertNotIn('Secret', [d['kind'] for d in DOCS])
        self.assertNotIn('Cluster', [d['kind'] for d in DOCS])

    def test_private_single_replica_and_persisted_state(self):
        for d in DOCS:
            if d['kind'] == 'Service':
                self.assertEqual(d['spec']['type'], 'ClusterIP')
            if d['kind'] == 'PersistentVolumeClaim':
                self.assertEqual(d['metadata']['annotations']['helm.sh/resource-policy'], 'keep')
                self.assertIn('Delete=false', d['metadata']['annotations']['argocd.argoproj.io/sync-options'])
            if d['kind'] != 'Deployment':
                continue
            self.assertEqual(d['spec']['replicas'], 1)
            self.assertEqual(d['spec']['strategy']['type'], 'Recreate')
            pod = d['spec']['template']['spec']
            self.assertFalse(pod['automountServiceAccountToken'])
            self.assertFalse(pod.get('hostNetwork', False))
            self.assertEqual(pod['nodeSelector']['kubernetes.io/arch'], 'amd64')
            for c in pod['containers'] + pod.get('initContainers', []):
                self.assertFalse(c['securityContext']['allowPrivilegeEscalation'])
                self.assertTrue(c['securityContext']['readOnlyRootFilesystem'])
                self.assertEqual(c['securityContext']['capabilities']['drop'], ['ALL'])
                self.assertNotIn('livenessProbe', c)

    def test_migration_privilege_is_init_only(self):
        control = next(d for d in DOCS if d['kind'] == 'Deployment' and d['metadata']['name'] == 'control')['spec']['template']['spec']
        self.assertEqual(control['initContainers'][0]['args'], ['affinity-db'])
        self.assertIn('migrate-secret', [v['name'] for v in control['initContainers'][0]['volumeMounts']])
        self.assertNotIn('migrate-secret', [v['name'] for v in control['containers'][0]['volumeMounts']])

    def test_official_proxy_and_matching_plugin(self):
        proxy = next(d for d in DOCS if d['kind'] == 'Deployment' and d['metadata']['name'] == 'proxy')['spec']['template']['spec']
        panel = next(d for d in DOCS if d['kind'] == 'Deployment' and d['metadata']['name'] == 'panel')['spec']['template']['spec']
        self.assertEqual(proxy['containers'][0]['image'], json.loads((ROOT / 'deploy/cliproxy-release.json').read_text())['image'])
        self.assertEqual(proxy['initContainers'][0]['image'], panel['containers'][0]['image'])
        self.assertEqual(proxy['containers'][0]['args'], ['/CLIProxyAPI/CLIProxyAPI', '--local-model'])

    def test_required_internal_flows(self):
        for source, target, ports in [('panel', 'proxy', [8317]), ('panel', 'control', [8318]),
          ('panel', 'gateway', [8319, 8320]), ('gateway', 'proxy', [8317]),
          ('gateway', 'control', [8318]), ('proxy', 'gateway', [8320, 8321]), ('proxy', 'control', [8318])]:
            for port in ports:
                self.assertTrue(permitted(source, 'egress', port, peer_role=target), (source, target, port))
                self.assertTrue(permitted(target, 'ingress', port, peer_role=source), (source, target, port))

    def test_proxy_cannot_bypass_gateway(self):
        for role in ['proxy', 'control']:
            self.assertFalse(permitted(role, 'egress', 443, ip='203.0.113.10'))
        for role in ['panel', 'gateway']:
            self.assertTrue(permitted(role, 'egress', 443, ip='203.0.113.10'))
            for ip in ['10.0.0.2', '169.254.169.254', '192.168.1.1', '127.0.0.1']:
                self.assertFalse(permitted(role, 'egress', 443, ip=ip))
        self.assertFalse(permitted('proxy', 'ingress', 8317, peer_role='other'))
        self.assertFalse(permitted('proxy', 'ingress', 8317, peer_role='panel', peer_ns='other'))
        self.assertFalse(permitted('gateway', 'ingress', 8321, peer_role='panel'))

    def test_database_and_dns_are_scoped(self):
        for role in ['proxy', 'control']:
            self.assertTrue(permitted(role, 'egress', 5432, peer_ns='database', peer_labels={'cnpg.io/cluster': 'postgres'}))
            self.assertFalse(permitted(role, 'egress', 5432, peer_ns='database', peer_labels={'cnpg.io/cluster': 'other'}))
        for role in ['panel', 'gateway', 'proxy', 'control']:
            self.assertTrue(permitted(role, 'egress', 53, peer_ns='kube-system', peer_labels={'k8s-app': 'kube-dns'}, protocol='UDP'))
            self.assertFalse(permitted(role, 'egress', 443, peer_ns='kube-system', peer_labels={'k8s-app': 'kube-dns'}))

    def test_no_outside_dashboard_access_by_default(self):
        for role, port in [('panel', 3000), ('gateway', 8319), ('gateway', 8320), ('control', 8318)]:
            self.assertFalse(permitted(role, 'ingress', port, peer_role='other', peer_ns='other'))

    def test_internal_callbacks_are_not_readiness_gated(self):
        services = {d['metadata']['name']: d['spec'] for d in DOCS if d['kind'] == 'Service'}
        self.assertTrue(services['gateway']['publishNotReadyAddresses'])
        self.assertFalse(services['api'].get('publishNotReadyAddresses', False))
        self.assertEqual([p['port'] for p in services['api']['ports']], [8319])

    def test_existing_pvcs_and_custom_namespace(self):
        docs = render('crap', 'personal', '--set', 'persistence.panelClaim=old-panel,persistence.controlClaim=old-control')
        docs += render('cliproxy', 'personal', '--set', 'persistence.existingClaim=old-proxy')
        self.assertNotIn('PersistentVolumeClaim', [d['kind'] for d in docs])
        self.assertTrue(all(d['metadata']['namespace'] == 'personal' for d in docs))

    def test_unsupported_replica_option_is_rejected(self):
        result = subprocess.run(['helm', 'template', 'crap', str(ROOT / 'k8s/helm/crap'), '--set', 'replicaCount=2'], capture_output=True)
        self.assertNotEqual(result.returncode, 0)

    def test_lan_mtls_is_scoped_and_renews_leaves(self):
        docs = list(yaml.safe_load_all((ROOT / 'k8s/examples/lan-mtls.yaml').read_text(encoding='utf-8-sig')))
        self.assertTrue(all(d['metadata']['namespace'] == 'crap' for d in docs))
        self.assertFalse(any(d['kind'] in ['ClusterIssuer', 'Secret', 'ClusterRole'] for d in docs))
        certs = {d['metadata']['name']: d['spec'] for d in docs if d['kind'] == 'Certificate'}
        for name in ['crap-lan-server', 'crap-lan-client']:
            self.assertEqual(certs[name]['duration'], '24h')
            self.assertEqual(certs[name]['renewBefore'], '8h')
            self.assertEqual(certs[name]['privateKey']['rotationPolicy'], 'Always')
            self.assertEqual(certs[name]['issuerRef'], {'name': 'crap-lan-ca', 'kind': 'Issuer'})
        self.assertEqual(certs['crap-lan-ca']['privateKey']['rotationPolicy'], 'Never')
        transport = next(d['spec'] for d in docs if d['kind'] == 'ServersTransport')
        self.assertFalse(transport['insecureSkipVerify'])
        self.assertEqual(transport['serverName'], certs['crap-lan-server']['dnsNames'][0])
        self.assertEqual(transport['certificatesSecrets'], ['crap-lan-client'])
        pod = next(d['spec']['template']['spec'] for d in docs if d['kind'] == 'Deployment')
        self.assertFalse(pod['automountServiceAccountToken'])
        self.assertEqual(pod['volumes'], [{'name': 'tls', 'secret': {'secretName': 'crap-lan-server', 'defaultMode': 288}}])
        self.assertEqual(pod['containers'][0]['command'], ['/app/lan-gateway'])
        terms = pod['affinity']['podAffinity']['requiredDuringSchedulingIgnoredDuringExecution']
        self.assertEqual({t['labelSelector']['matchLabels'][COMPONENT] for t in terms}, {'panel'})
        # Kubernetes matches all required terms against each individual existing pod.
        # Separate panel and gateway terms are unsatisfiable even on the same node.
        self.assertTrue(any(all(matches(term['labelSelector'], labels(role)) for term in terms)
                            for role in ['panel', 'gateway']))
        policies = {d['metadata']['name']: d['spec'] for d in docs if d['kind'] == 'NetworkPolicy'}
        entry = policies['crap-lan-entrypoint']
        self.assertEqual(entry['policyTypes'], ['Ingress', 'Egress'])
        self.assertEqual(entry['ingress'][0]['ports'], [{'protocol': 'TCP', 'port': 9443}])
        self.assertTrue(all(p['ipBlock']['cidr'].endswith('/32') for p in entry['ingress'][0]['from'] if 'ipBlock' in p))
        for name, port in [('crap-lan-panel', 3000), ('crap-lan-api', 8319)]:
            self.assertEqual(policies[name]['ingress'], [{'from': [{'podSelector': {'matchLabels': labels('lan')}}], 'ports': [{'protocol': 'TCP', 'port': port}]}])
        route = next(d['spec'] for d in docs if d['kind'] == 'IngressRoute')['routes'][0]
        self.assertEqual(route['middlewares'], [{'name': 'crap-lan-only'}])
        self.assertEqual(route['services'][0]['scheme'], 'https')
        self.assertEqual(route['services'][0]['serversTransport'], 'crap-lan')

    def test_optional_cilium_rule_cannot_open_backend_ports(self):
        rule = yaml.safe_load((ROOT / 'k8s/examples/lan-mtls-cilium.yaml').read_text(encoding='utf-8-sig'))
        self.assertEqual(rule['kind'], 'CiliumNetworkPolicy')
        self.assertEqual(rule['metadata']['namespace'], 'crap')
        self.assertEqual(rule['spec'], {'endpointSelector': {'matchLabels': labels('lan')},
            'ingress': [{'fromEntities': ['remote-node'], 'toPorts': [{'ports': [{'port': '9443', 'protocol': 'TCP'}]}]}]})

    def test_argocd_sources_match_and_are_manual(self):
        app = yaml.safe_load((ROOT / 'k8s/argocd/application.yaml').read_text())['spec']
        self.assertNotIn('automated', app['syncPolicy'])
        self.assertEqual(len(app['sources']), 2)
        self.assertEqual(app['sources'][0]['targetRevision'], app['sources'][1]['targetRevision'])
        self.assertEqual(app['sources'][0]['helm']['valuesObject']['images']['panel'], app['sources'][1]['helm']['valuesObject']['pluginImage'])
        for source in app['sources']:
            self.assertTrue((ROOT / source['path'] / 'Chart.yaml').exists())

if __name__ == '__main__':
    unittest.main(verbosity=2)
