# PR 60 native workspace preview, 2026-11-18

One ARM64 Apple Virtualization workspace lease passed the owner HTTP preview, credential rotation, release and cleanup trial. The trial used an ephemeral loopback TLS controller, fresh runner enrollment, the Rust satellite and the installed signed VM helper. The scope was one preview operation.

## Bundle provenance

- Checked the installed pr24-main v2 manifest against its recorded canonical SHA256, `1c9a1e93b7a4c3fe419c278f8cfaa79502165a03c7983c66068e30b663cc0216`, and checked the Image, initrd and rootfs against their manifest hashes.
- Started a dedicated builder from the pinned tools/linux-guest-builder/lima.yaml. Copied a Git archive of `7891ec40121d7e57e4050e7b8c591590d580f418` and the retained ST-535 build inputs into the builder. The guest sources and Cargo.lock are identical at the subsequent PR revision `ff89e1d55d744b5a14183ad9ba3501220b36c81c`.
- Ran the official build-rust.sh after provisioning completed. Its pinned Rust signature, Debian EROFS source authentication, archive hash and ELF checks passed. Cargo built the locked static ARM64 MUSL binaries. Guest-agent SHA256 was `658505ae3a76b1651bb6e9f47f09209676b93a863516cb141eeca2a61cd55a7c`.
- Extracted a verified copy of the installed rootfs inside the builder, installed the current agent at /usr/sbin/canaveral-guest-agent and repacked it with the recipe timestamp and filesystem UUID. Verified the image with fsck.erofs. The derived rootfs SHA256 was `7506f73904adee0a85ab6c8d81f2924402f949bb08b523e6ce1e694bacb564f3`.
- Copied the installed kernel and initrd into a new private bundle, updated the rootfs size and hash, serialized the canonical manifest and sealed the four trial files read-only and immutable. The satellite accepted canonical digest `719b6ed36362807ac8bb69d11f92193fd825229ed7fadddf0195b45f3affa814` for both image identity and previewBundleDigest.

## Observations

The trial reused the native harness enrollment, signature verification, acquisition, mount inspection, release and independent cleanup checks. It used one 2-CPU, 4096-MiB, 8-GiB workspace with a 120-second lease. The installed helper SHA256 was `44f5e5a0b5a0b150a7afac2e82d07c449dee6c92b1c5d3f7eb29a73a0da91289`. The guest mounted its real EROFS root and launch medium and its ext4 workspace. The satellite reported preview readiness over the native transport.

The foreground guest wrapper launched a Node HTTP service on guest loopback port 18760. The owner's HTTPS GET through the controller and native virtio-vsock relay returned 200. Its JSON body matched both the randomly generated request path and the guest working directory /workspace. Rotating the lease credential revoked the previously successful token. Repeating the GET with that token returned 401.

After the application released the lease, the controller reported complete cleanup and zero domain reservations. The satellite exited successfully. Independent process and filesystem checks confirmed the helper and owned VM processes were gone and the machine directory, workspace and relay were removed. The journal recorded stopped, cleaned and released. The dedicated Lima builder was stopped and deleted. The separate derived bundle was retained for inspection. This trial did not exercise service-exit port reuse or an in-flight release race.
