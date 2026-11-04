import json
from unittest.mock import patch
import unittest

from canaveral.cluster_resources import collect, quantity, validate
from canaveral.infrastructure import validate_sample


def inventory(name="vm",containers=("guest",)):
    return {"metadata":{"name":name,"namespace":"guests","creationTimestamp":"2026-11-03T00:00:00Z"},
            "spec":{"containers":[{"name":n} for n in containers]},"status":{"phase":"Running"}}


def metric(name="vm",containers=("guest",),stamp="2026-11-03T00:01:00Z"):
    return {"metadata":{"name":name,"namespace":"guests"},"timestamp":stamp,"window":"30s",
            "containers":[{"name":n,"usage":{"cpu":"100m","memory":"64Mi"}} for n in containers]}


class FixtureProvider:
    config={"namespace":"guests"}
    def __init__(self,pods,metrics):self.pods=pods;self.metrics=metrics
    def kubectl(self,*args,timeout=None):
        assert timeout==5
        return json.dumps({"items":self.metrics if "--raw" in args else self.pods if args[1]=="pods" else []})


def report(pods,metrics):
    with patch("canaveral.cluster_resources.time.time",return_value=1793664060):
        return collect(FixtureProvider(pods,metrics))


class ClusterResourceTests(unittest.TestCase):
    def test_quantity_units_and_invalid_values(self):
        for raw,expected in [('250m',.25),('10n',1e-8),('2Gi',2147483648),('1.5G',1500000000),('1e3',1000)]:
            self.assertEqual(quantity(raw),expected)
        for raw in ('NaN','Infinity','-1','1garbage','1e999999999'):
            self.assertIsNone(quantity(raw))

    def test_namespace_metrics_quota_units_and_worker_separation(self):
        class Provider:
            config={'namespace':'guests'}
            def kubectl(self,*args,timeout=None):
                assert timeout==5
                if args[1]=='pods':return json.dumps({'items':[inventory(containers=('guest','helper'))]})
                if '--raw' in args:
                    data=metric(containers=('guest','helper'));data['containers'][0]['usage']={'cpu':'250000000n','memory':'512Mi'}
                    return json.dumps({'items':[data]})
                return json.dumps({'items':[{'metadata':{'name':'pool'},'status':{'hard':{'requests.cpu':'4','requests.memory':'8Gi','requests.storage':'100Gi'},'used':{'requests.cpu':'500m','requests.memory':'1Gi','requests.storage':'20Gi'}}}]})
        with patch("canaveral.cluster_resources.time.time",return_value=1793664060):report=collect(Provider())
        self.assertTrue(validate(report))
        self.assertEqual(report['metrics']['cpuCores'],.35)
        self.assertEqual(report['metrics']['memoryMiB'],576)
        self.assertEqual(report['metrics']['coverage'],{'status':'complete','activePods':1,'measuredPods':1})
        self.assertEqual(report['quotas']['items'][0]['used']['requests.storage'],20)
        sample={'scope':'runner','domain':'worker','sampledAt':1,'cpuPercent':5,'cluster':report}
        self.assertEqual(validate_sample(sample)['scope'],'runner')

    def test_missing_metrics_server_or_permission_is_unknown_not_zero(self):
        class Provider:
            config={'namespace':'guests'}
            def kubectl(self,*args,**kwargs):raise RuntimeError('private connection error')
        report=collect(Provider())
        self.assertEqual(report['metrics'],{'status':'unavailable','coverage':{'status':'unavailable'}})
        self.assertEqual(report['quotas'],{'status':'unavailable','items':[]})
        self.assertTrue(validate(report))
        self.assertNotIn('private',json.dumps(report))

    def test_all_active_namespace_workloads_are_required_for_a_total(self):
        own=inventory('vm');own['metadata']['labels']={'canaveral.io/machine':'fixture'}
        other=inventory('other')
        complete=report([own,other],[metric('vm'),metric('other')])
        self.assertTrue(validate(complete));self.assertEqual(complete['metrics']['cpuCores'],.2)
        self.assertEqual(complete['metrics']['memoryMiB'],128)
        missing=report([own,other],[metric('vm')])
        self.assertTrue(validate(missing));self.assertEqual(missing['metrics']['status'],'unavailable')
        self.assertEqual(missing['metrics']['coverage'],{'status':'incomplete','activePods':2,'measuredPods':1})
        self.assertNotIn('cpuCores',missing['metrics'])

    def test_stale_future_missing_and_previous_incarnation_timestamps_are_unknown(self):
        for stamp in ('2026-11-02T23:58:59Z','2026-11-03T00:01:06Z',None,'2026-11-03T00:01:00'):
            with self.subTest(stamp=stamp):
                value=report([inventory()],[metric(stamp=stamp)])
                self.assertTrue(validate(value));self.assertEqual(value['metrics']['status'],'unavailable')
                self.assertNotIn('cpuCores',value['metrics'])
        replaced=inventory();replaced['metadata']['creationTimestamp']='2026-11-03T00:00:50Z'
        value=report([replaced],[metric(stamp='2026-11-03T00:00:49Z')])
        self.assertEqual(value['metrics']['coverage']['measuredPods'],0)
        fresh=report([inventory()],[metric(stamp='2026-11-03T00:00:10Z')])
        self.assertEqual(fresh['metrics']['sampledAt'],1793664010)

    def test_missing_containers_and_duplicate_metrics_cannot_undercount_or_double_count(self):
        for metrics in ([metric(containers=())],[metric(),metric()],
                        [metric(containers=('guest','guest'))],[metric(containers=('helper',))]):
            with self.subTest(metrics=metrics):
                value=report([inventory()],metrics)
                self.assertTrue(validate(value));self.assertEqual(value['metrics']['status'],'unavailable')
                self.assertNotIn('cpuCores',value['metrics'])
        value=report([inventory(containers=('guest','sidecar'))],[metric()])
        self.assertEqual(value['metrics']['status'],'unavailable')

    def test_measured_empty_namespace_differs_from_missing_metrics_or_inventory(self):
        empty=report([],[])
        self.assertEqual(empty['metrics']['cpuCores'],0);self.assertEqual(empty['metrics']['coverage']['status'],'complete')
        completed=inventory();completed['status']['phase']='Succeeded'
        self.assertEqual(report([completed],[])['metrics']['podCount'],0)
        for failed in ('pods','--raw'):
            provider=FixtureProvider([],[]);original=provider.kubectl
            def denied(*args,**kwargs):
                if failed in args:raise RuntimeError('private-cluster-details')
                return original(*args,**kwargs)
            provider.kubectl=denied
            value=collect(provider)
            self.assertTrue(validate(value));self.assertEqual(value['metrics']['status'],'unavailable')
            self.assertNotIn('private-cluster-details',json.dumps(value));self.assertNotIn('cpuCores',value['metrics'])

    def test_invalid_inventory_or_metrics_never_becomes_empty_zero(self):
        for pods,metrics in (({},[]),([],{}),([inventory(),inventory()],[metric()])):
            value=report(pods,metrics)
            self.assertTrue(validate(value));self.assertEqual(value['metrics']['status'],'unavailable')
        value=metric();value['containers'][0]['usage']['cpu']='NaN'
        self.assertEqual(report([inventory()],[value])['metrics']['status'],'unavailable')

    def test_coverage_validation_rejects_impossible_counts_and_available_partial_totals(self):
        import copy
        complete=report([inventory()],[metric()])
        for coverage in ({'status':'complete','activePods':2,'measuredPods':1},
                         {'status':'incomplete','activePods':1,'measuredPods':1},
                         {'status':'complete','activePods':True,'measuredPods':1},
                         {'status':'unavailable'},{'status':'complete'}):
            value=copy.deepcopy(complete);value['metrics']['coverage']=coverage
            self.assertFalse(validate(value))
        legacy=copy.deepcopy(complete);legacy['metrics'].pop('coverage');legacy['metrics'].pop('sampledAt')
        self.assertTrue(validate(legacy))

    def test_running_init_sidecars_and_debug_containers_require_measurements(self):
        for section in ('initContainerStatuses','ephemeralContainerStatuses'):
            pod=inventory();pod['status'][section]=[{'name':'extra','state':{'running':{}}}]
            self.assertEqual(report([pod],[metric()])['metrics']['status'],'unavailable')
            complete=report([pod],[metric(containers=('guest','extra'))])
            self.assertEqual(complete['metrics']['cpuCores'],.2)
            pod['status'][section][0]['state']={'terminated':{}}
            self.assertEqual(report([pod],[metric()])['metrics']['status'],'available')
