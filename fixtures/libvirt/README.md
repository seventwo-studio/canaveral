# Libvirt VM lease acceptance

`.github/workflows/vm-acceptance.yaml` runs `acceptance.mjs` on a disposable
GitHub-hosted ubuntu-24.04 x64 runner with host libvirtd and KVM. It installs
the released lease helper root-owned, provisions the `canaveral-vm` group
(GID 10002), the `canaverald` service account and the `2750` storage root, and
runs canaverald as a systemd service with the
`canaverald.service.d/libvirt-leases.conf` drop-in (ambient `CAP_KILL`). The
guest is the digest-pinned CirrOS image in `guest-image.json`, booted by BIOS
without TPM.

Each step requests a consumer lease through the public request API and checks
the boot through the guest's DHCP lease, the transient domain, QEMU's account
and the storage modes. It then ends the lease one way: release, expiry,
SIGKILL of the daemon, a guardian killed mid-fence, a libvirtd restart, a
deadline that passes while libvirtd is frozen, or a kernel OOM kill of the
guardian under pressure in the service cgroup (a guardian that fences itself
first under that pressure is also accepted and recorded). Every step requires a fresh `VIR_ERR_NO_DOMAIN` lookup, no QEMU process
for the lease UUID, removed lease storage, a released reservation and a refused
`virsh start`. The JSON evidence names each step, its outcome, timings and the
guardian receipts.

The run proves one hosted kernel and libvirt build. It does not cover
Kubernetes pods, UEFI or TPM guests, other distributions, real hardware
suspend or a host reboot.
