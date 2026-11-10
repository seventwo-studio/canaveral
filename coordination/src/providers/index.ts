import { ServiceError } from "../errors.ts";
import { AppleProvider } from "./apple.ts";
import { HypervProvider } from "./hyperv.ts";
import { KubevirtProvider } from "./kubevirt.ts";
import { LibvirtProvider } from "./libvirt.ts";
import { AndroidProvider } from "./android.ts";
import { IosProvider } from "./ios.ts";

export type ProviderRecord = Record<string, unknown>;
/** Native effects require an assignment-bound ownership receipt in each adapter. */
export interface NativeProvider {
  readonly kind: string;
  check(): Promise<unknown>;
  reconcile(machine: ProviderRecord, image: ProviderRecord, folder: string): Promise<ProviderRecord>;
}

export function createProvider(config: ProviderRecord, state: string): NativeProvider {
  switch (config.provider) {
    case "apple": return new AppleProvider(config, state);
    case "hyperv": return new HypervProvider(config, state);
    case "kubevirt": return new KubevirtProvider(config, state);
    case "libvirt": return new LibvirtProvider(config, state);
    case "android": return new AndroidProvider(config, state);
    case "ios": return new IosProvider(config, state);
    default: throw new ServiceError("Configure a supported native provider.", 400);
  }
}
