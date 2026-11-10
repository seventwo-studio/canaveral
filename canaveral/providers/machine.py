"""One physical host identity and set of host limits, with multiple runtimes."""
import platform
from pathlib import Path

from .base import Provider
from ..model import Error
from ..runtime_config import enabled_runtimes, runtime_for


class Machine(Provider):
    def __init__(self,config,state):
        super().__init__({**config,'guestAccess':None},state)
        from . import provider_for
        self.runtimes={}
        for name,settings in enabled_runtimes(config).items():
            child={**settings,'name':config['name'],'provider':name,'capacity':config['capacity'],
                   'templates':[image for image in config['templates'] if runtime_for(config,image)==name]}
            child.setdefault('storage',str(Path(config['storage'])/name))
            child_state=Path(settings.get('stateDirectory',self.state/'runtimes'/name))
            child_state.mkdir(mode=0o700,parents=True,exist_ok=True)
            self.runtimes[name]=provider_for(child,child_state)

    def runtime_context(self,machine,image,folder):
        runtime=self.runtimes[runtime_for(self.config,image)]
        return runtime,image,runtime.state/'machines'/machine['id']

    def check(self):
        expected={'macos':'Darwin','linux':'Linux','windows':'Windows'}[self.config['provider']]
        if platform.system()!=expected:raise Error('Host operating system does not match this runner.')
        for runtime in self.runtimes.values():runtime.check()
