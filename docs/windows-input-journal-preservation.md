# Windows input journal component

This preserved component stores held Windows input state in two checksummed,
context-bound slots. It rejects uncertain ownership and invalid transitions and
retains recovery state across interrupted writes. It is not connected to the
Windows guest service or display worker. Native Windows durability, service
binding and end-to-end reset acceptance remain outstanding.

Source: local `stack/repair-partial-native-merge`, revision
`6dbaf9fef97d`, preserved on 2026-11-05. The component and its tests are unchanged.
The 16 journal tests pass against public main using native-shaped doubles and
POSIX temporary files; they do not establish Windows behavior.
