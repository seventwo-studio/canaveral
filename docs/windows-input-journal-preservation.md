# Windows input journal

`WindowsInputJournal` in `coordination/src/guest/windows/journal.ts` stores held
input in two checksummed, context-bound slots through an injected `WindowsFileAPI`.
It requires a provisioned volume/file identity, a pinned root, relative path and
current authorization predicate. It chooses no guest, credentials or enrollment.

Each 128 KiB slot contains a version, context UUID, sequence, checksum and canonical
held-input state. Recovery validates slot parity and consecutive history. Missing,
foreign or ambiguous records fail closed. A blank journal initializes only with
explicit permission; corruption cannot silently produce a neutral input state.

Before native input, persist a blocked state covering every possibly held key,
button and transient action. Subsequent transitions can remove positively released
input but cannot lose uncertain ownership. Writes handle bounded partial progress,
flush the native file and verify readback before advancing the sequence. A lost
save acknowledgement fences the journal with `input_reset_uncertain` and an unknown
outcome. It must not authorize another input owner or an automatic action replay.

Directory, file and metadata identity are rechecked around I/O. Missing native
journal/write/flush operations return `capability_unsupported`. Close retains
unconfirmed handle ownership for inspection rather than claiming cleanup.

Portable fixtures must cover torn slots, context/sequence mismatch, conservative
recovery, invalid transitions, partial writes and flush/readback failure. They do
not establish Windows filesystem durability. Production Win32 binding, guest service
integration and end-to-end input reset acceptance remain outstanding.
