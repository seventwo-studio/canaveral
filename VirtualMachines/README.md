# Canaveral Virtual Machines

This Swift package targets macOS 26+ and contains VM management, a machine host, guest helpers and configuration checks. See `Package.swift` for products and dependencies. The signed guest bundle runs inside macOS guests. The Linux X11 desktop helper uses bearer-authenticated loopback access; takeover and uncertain-input recovery remain part of its contract.

The legacy autonomous Linux assistant worker and its provisioning class are excluded from this distribution. The general machine API lives in the root Python control plane. Guest-helper HTTP endpoints are distinct from the orchestration API.

Native boots, display/input, signing, guest connectivity and provider binding require target-platform acceptance. Existing disks, credential namespaces and persisted helper state are not migrated automatically. Native test scripts require operator setup and may sign configuration-check binaries.
