import json
import secrets
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from canaveral.cli import main,parser
from canaveral.host import Agent
from canaveral.model import Error
from test_access_sessions import AccessFixture
from test_orchestration import host_offer
from test_session_tls import TLSFixture


class HostTLSCLITests(unittest.TestCase):
    def test_ca_file_option_is_host_scoped_and_optional(self):
        args=parser().parse_args(['host','--config','fixture.json','--state','fixture-state'])
        self.assertIsNone(args.ca_file)
        args=parser().parse_args(['--url','https://fixture.invalid','host','--config','fixture.json','--state','fixture-state','--ca-file','ca.pem'])
        self.assertEqual(args.ca_file,'ca.pem')

    def test_config_and_setup_file_both_pass_ca_without_serializing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);config=host_offer();token=secrets.token_urlsafe(32)
            key=root/'enrollment.key';key.write_text(token);key.chmod(0o600)
            config_path=root/'config.json';config_path.write_text(json.dumps(config))
            setup_path=root/'setup.json';setup_path.write_text(json.dumps({'schemaVersion':1,'controllerUrl':'https://setup.invalid',
                'config':config,'enrollmentToken':token}))
            for option,path in (('--config',config_path),('--setup-file',setup_path)):
                state=root/option[2:]
                with self.subTest(option=option),patch('canaveral.cli.Agent') as agent,patch('canaveral.cli.signal.signal'):
                    main(['--url','https://config.invalid','host',option,str(path),'--state',str(state),
                        '--enrollment-token-file',str(key),'--ca-file',str(root/'ca.pem')])
                    self.assertEqual(agent.call_args.kwargs,{'ca_file':str(root/'ca.pem')})
                    self.assertEqual(agent.call_args.args[1],'https://setup.invalid' if option=='--setup-file' else 'https://config.invalid')
                    agent.return_value.run.assert_called_once_with(token)
                    self.assertNotIn('ca_file',agent.call_args.args[0])
                    self.assertNotIn('ca_file',json.loads(path.read_text()))


class HostTLSConnectionTests(TLSFixture,AccessFixture):
    def test_enrollment_and_reconnect_use_same_private_identity_and_ca(self):
        state=Path(self.temp.name)/'tls-host'
        agent=Agent(host_offer(),self.tls_url,state,ca_file=self.certificate)
        agent.connect(self.enrollment);agent.poll()
        identity=(state/'identity.json').read_bytes()
        self.assertEqual(agent.client.ca_file,self.certificate)
        self.assertNotIn('leaseProtocol',agent.offer)
        self.assertIn(agent.identity['id'],[host['id'] for host in self.store.hosts()])
        restored=Agent(host_offer(),self.tls_url,state,ca_file=self.certificate)
        with patch.object(self.store,'enroll',wraps=self.store.enroll) as enroll:
            restored.connect(None);restored.poll();enroll.assert_not_called()
        self.assertEqual((state/'identity.json').read_bytes(),identity)
        self.assertEqual(restored.identity['id'],agent.identity['id'])

    def test_invalid_local_bundle_never_persists_identity_or_enrolls(self):
        state=Path(self.temp.name)/'invalid-ca-host'
        agent=Agent(host_offer(),self.tls_url,state,ca_file=state/'missing.pem')
        with patch.object(self.store,'enroll',wraps=self.store.enroll) as enroll:
            with self.assertRaises(Error) as error:agent.connect(self.enrollment)
            self.assertEqual(error.exception.status,400);enroll.assert_not_called()
        self.assertFalse((state/'identity.json').exists())

    def test_untrusted_peer_retains_retry_identity_but_enrolls_no_host(self):
        state=Path(self.temp.name)/'untrusted-ca-host'
        agent=Agent(host_offer(),self.tls_url,state,ca_file=self.untrusted)
        before={host['id'] for host in self.store.hosts()}
        with self.assertRaises(Error):agent.connect(self.enrollment)
        identity=(state/'identity.json').read_bytes()
        self.assertEqual({host['id'] for host in self.store.hosts()},before)
        # Retry the same task-owned identity with the correct explicit bundle.
        agent.ca_file=self.certificate;agent.connect(self.enrollment);agent.poll()
        self.assertEqual((state/'identity.json').read_bytes(),identity)
