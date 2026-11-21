//! Process inventory for one leased iOS simulator.
//!
//! CoreSimulator starts a simulator's `launchd_sim` through launchd, so it is never a
//! child of the lease supervisor and cannot be put in a process group the supervisor
//! owns. The handle is the lease's own device directory, `<device set>/<UDID>`.
//!
//! A member of the simulator's tree is exactly one of:
//!
//! 1. the device's `launchd_sim`: a process named `launchd_sim` whose argument is a
//!    path inside the device directory (its bootstrap path);
//! 2. a process whose command line begins with the device directory, which is an
//!    executable started from inside the lease's own device, as installed apps are;
//! 3. a process recorded earlier as a member, while its PID still holds a process
//!    with the recorded start time;
//! 4. a live descendant of any member.
//!
//! Nothing else is a member, so nothing else is ever signalled: not a process that
//! merely mentions the device set in an argument (a `tail`, a shell, the runner's own
//! `simctl --set` calls), and not a path that only contains the device directory.
//!
//! That `launchd_sim` names its device directory is an assumption taken from how
//! CoreSimulator starts simulators. It has not been checked on a real host, so a tree
//! whose root was never observed proves nothing: see `Tree::observed`.
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Recorded members beyond this bound make the proof incomplete instead of unbounded.
pub const MEMBER_LIMIT: usize = 1024;
const INVENTORY_BYTES: u64 = 64 << 20;
/// One inventory, however it stalls, returns within this bound.
pub const INVENTORY_LIMIT: Duration = Duration::from_secs(10);
/// Re-reading one process's start time before a signal returns within this bound.
const IDENTITY_LIMIT: Duration = Duration::from_secs(2);

#[derive(Clone, Debug, PartialEq)]
pub struct Process {
    pub pid: i32,
    pub ppid: i32,
    pub pgid: i32,
    /// A zombie executes nothing; it only waits for its parent to collect it.
    pub zombie: bool,
    /// The process start time as `ps` prints it. With the PID it identifies one process.
    pub started: String,
    pub command: String,
}

/// Why a bounded command produced no result.
#[derive(Debug, PartialEq)]
pub enum Halt {
    /// The command could not be started, or its output could not be collected.
    Failed,
    /// It ran past its limit and its process group was killed.
    Limit,
    /// The caller's check asked to stop; the process group was killed.
    Reason(&'static str),
}

/// Runs one command in its own process group and never waits for it longer than
/// `limit`. Output is read on its own thread, so a command that stalls with its pipe
/// open cannot hold the caller: the wait below still polls `check` and the limit, then
/// kills the group. `capture` bounds the bytes kept from stdout (0 keeps none and
/// leaves stdout as the caller configured it).
pub fn bounded(
    mut command: Command,
    limit: Duration,
    capture: u64,
    mut check: impl FnMut() -> Option<&'static str>,
) -> std::result::Result<(Option<i32>, Vec<u8>), Halt> {
    command.stdin(Stdio::null()).process_group(0);
    if capture > 0 {
        command.stdout(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|_| Halt::Failed)?;
    let group = -(child.id() as i32);
    // The leader stays our unreaped child until `wait`, so its group ID cannot be reused.
    let abandon = |child: &mut std::process::Child, halt: Halt| {
        unsafe { libc::kill(group, libc::SIGKILL) };
        let _ = child.wait();
        halt
    };
    let output = match child.stdout.take() {
        Some(out) => {
            let (sender, receiver) = mpsc::channel();
            let reader = std::thread::Builder::new().spawn(move || {
                let mut data = Vec::new();
                let read = out.take(capture + 1).read_to_end(&mut data);
                let _ = sender.send(read.is_ok().then_some(data));
            });
            if reader.is_err() {
                return Err(abandon(&mut child, Halt::Failed));
            }
            Some(receiver)
        }
        None => None,
    };
    let deadline = Instant::now() + limit;
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break status;
        }
        let halt = check()
            .map(Halt::Reason)
            .or_else(|| (Instant::now() >= deadline).then_some(Halt::Limit));
        if let Some(halt) = halt {
            return Err(abandon(&mut child, halt));
        }
        std::thread::sleep(Duration::from_millis(10));
    };
    let data = match output {
        // The command has exited, so its pipe is at end of file unless a descendant kept it.
        Some(receiver) => match receiver.recv_timeout(Duration::from_secs(2)) {
            Ok(Some(data)) if data.len() as u64 <= capture => data,
            _ => return Err(Halt::Failed),
        },
        None => Vec::new(),
    };
    Ok((status.code(), data))
}

fn ps(arguments: &[&str]) -> Command {
    let mut command = Command::new("/bin/ps");
    command
        .args(arguments)
        .env_clear()
        .env("LC_ALL", "C")
        .stderr(Stdio::null());
    command
}

fn field<'a>(rest: &mut &'a str) -> Option<&'a str> {
    let text = rest.trim_start();
    if text.is_empty() {
        return None;
    }
    let end = text.find(char::is_whitespace).unwrap_or(text.len());
    *rest = &text[end..];
    Some(&text[..end])
}

/// Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=,command=`. A line that does not parse
/// fails the whole inventory: a partial inventory can never prove absence.
pub fn parse(output: &str) -> Result<Vec<Process>> {
    let mut processes = Vec::new();
    for line in output.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut rest = line;
        let mut number = || -> Result<i32> {
            Ok(field(&mut rest)
                .ok_or("Truncated process line")?
                .parse::<i32>()?)
        };
        let (pid, ppid, pgid) = (number()?, number()?, number()?);
        let stat = field(&mut rest).ok_or("Truncated process line")?;
        let mut started = Vec::with_capacity(5);
        for _ in 0..5 {
            started.push(field(&mut rest).ok_or("Truncated process line")?);
        }
        if pid <= 0 || ppid < 0 || started[4].len() != 4 {
            return Err("Unexpected process line".into());
        }
        processes.push(Process {
            pid,
            ppid,
            pgid,
            zombie: stat.starts_with('Z'),
            started: started.join(" "),
            command: rest.trim_start().to_owned(),
        });
    }
    if processes.is_empty() {
        return Err("Empty process inventory".into());
    }
    Ok(processes)
}

/// Every process this account can see, with full-width command lines. Bounded: a `ps`
/// that stalls is killed at `INVENTORY_LIMIT` and the inventory fails.
pub fn inventory() -> Result<Vec<Process>> {
    let command = ps(&["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="]);
    match bounded(command, INVENTORY_LIMIT, INVENTORY_BYTES, || None) {
        Ok((Some(0), data)) => parse(&String::from_utf8_lossy(&data)),
        _ => Err("Process inventory failed".into()),
    }
}

/// The start time `ps` reports for one PID right now, or `None` when no such process
/// exists. An error means the answer is unknown.
pub fn started(pid: i32) -> Result<Option<String>> {
    if pid <= 1 {
        return Err("Invalid process".into());
    }
    let command = ps(&["-p", &pid.to_string(), "-o", "lstart="]);
    match bounded(command, IDENTITY_LIMIT, 4096, || None) {
        Ok((Some(_), data)) => {
            let text = String::from_utf8_lossy(&data);
            let fields: Vec<&str> = text.split_whitespace().collect();
            match fields.len() {
                0 => Ok(None),
                5 => Ok(Some(fields.join(" "))),
                _ => Err("Unexpected start time".into()),
            }
        }
        _ => Err("Start time is unavailable".into()),
    }
}

/// Sends `signal` to `pid` only if, read immediately before, that PID still holds the
/// process that started at `expected`. Without a pidfd the gap between that read and the
/// signal cannot be closed, only kept this narrow. Returns whether the signal was sent.
pub fn signal(pid: i32, expected: &str, signal: libc::c_int) -> bool {
    if pid <= 1 || pid == std::process::id() as i32 {
        return false;
    }
    match started(pid) {
        Ok(Some(current)) if current == expected => unsafe { libc::kill(pid, signal) == 0 },
        _ => false,
    }
}

/// Whether this command line is the device's own `launchd_sim`: the name `launchd_sim`
/// as a whole path component, followed by a path inside the device directory.
pub fn is_root(command: &str, device: &str) -> bool {
    if device.is_empty() {
        return false;
    }
    let marker = format!("launchd_sim {device}/");
    command
        .match_indices(&marker)
        .any(|(at, _)| at == 0 || command.as_bytes()[at - 1] == b'/')
}

/// Whether this command line begins with the device directory: an executable started
/// from inside the lease's own device. A path that merely contains it does not count.
pub fn is_device_executable(command: &str, device: &str) -> bool {
    !device.is_empty()
        && command
            .strip_prefix(device)
            .is_some_and(|rest| rest.starts_with('/'))
}

/// This process and its ancestors. They are never members, whatever their command lines say.
fn lineage(processes: &[Process]) -> BTreeSet<i32> {
    let mut result = BTreeSet::new();
    let mut current = std::process::id() as i32;
    while current > 1 && result.insert(current) {
        current = processes
            .iter()
            .find(|p| p.pid == current)
            .map_or(0, |p| p.ppid);
    }
    result
}

/// Live members in this inventory: kinds 1 and 2, the `recorded` ones that are still the
/// same process, and every live descendant of those. `excluded` is a process group
/// stopped and proven absent by its own owner (the supervisor's child).
pub fn members<'a>(
    processes: &'a [Process],
    device: &str,
    recorded: &BTreeMap<i32, String>,
    excluded: Option<i32>,
) -> Vec<&'a Process> {
    let own = lineage(processes);
    let eligible =
        |p: &Process| p.pid > 1 && !p.zombie && !own.contains(&p.pid) && Some(p.pgid) != excluded;
    let mut found: BTreeSet<i32> = processes
        .iter()
        .filter(|p| {
            eligible(p)
                && (is_root(&p.command, device)
                    || is_device_executable(&p.command, device)
                    || recorded.get(&p.pid) == Some(&p.started))
        })
        .map(|p| p.pid)
        .collect();
    loop {
        let before = found.len();
        for p in processes {
            if eligible(p) && found.contains(&p.ppid) {
                found.insert(p.pid);
            }
        }
        if found.len() == before {
            break;
        }
    }
    processes
        .iter()
        .filter(|p| found.contains(&p.pid))
        .collect()
}

/// Members seen while their parents were alive, so a process that outlives the
/// simulator's `launchd_sim` is still found after it has been reparented.
#[derive(Default)]
pub struct Tree {
    /// The lease's own device directory, `<device set>/<UDID>`.
    pub device: String,
    pub seen: BTreeMap<i32, String>,
    /// More members than `MEMBER_LIMIT` were alive at once; absence can no longer be proven.
    pub truncated: bool,
    /// The device's own `launchd_sim` was seen at least once. Until then the premise that
    /// this tree is visible in the process table is unconfirmed for this device.
    pub observed: bool,
}

impl Tree {
    pub fn new(device: &str) -> Self {
        Tree {
            device: device.to_owned(),
            ..Tree::default()
        }
    }
    /// Records every member present in this inventory, including what a recorded member
    /// started since the last one, and forgets recorded ones that are positively gone.
    /// Returns whether any member is present, and whether the record changed.
    pub fn observe(&mut self, processes: &[Process], excluded: Option<i32>) -> (bool, bool) {
        let (before, was_observed) = (self.seen.clone(), self.observed);
        let current = members(processes, &self.device, &self.seen, excluded);
        self.seen.retain(|pid, started| {
            current
                .iter()
                .any(|p| p.pid == *pid && &p.started == started)
        });
        for p in &current {
            self.observed |= is_root(&p.command, &self.device);
            if self.seen.len() >= MEMBER_LIMIT && !self.seen.contains_key(&p.pid) {
                self.truncated = true;
            } else {
                self.seen.insert(p.pid, p.started.clone());
            }
        }
        (
            !current.is_empty(),
            before != self.seen || was_observed != self.observed,
        )
    }
    /// Every member present in this inventory, with the start time that identifies it.
    pub fn alive(&self, processes: &[Process], excluded: Option<i32>) -> Vec<(i32, String)> {
        members(processes, &self.device, &self.seen, excluded)
            .iter()
            .map(|p| (p.pid, p.started.clone()))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEVICE: &str = "/s/1/device-set/AB";

    fn process(pid: i32, ppid: i32, pgid: i32, command: &str) -> Process {
        Process {
            pid,
            ppid,
            pgid,
            zombie: false,
            started: "Sat Nov 21 10:15:30 2026".into(),
            command: command.into(),
        }
    }
    fn pids(alive: Vec<(i32, String)>) -> Vec<i32> {
        alive.into_iter().map(|(pid, _)| pid).collect()
    }

    #[test]
    fn parses_both_ps_layouts_and_refuses_partial_lines() {
        let output = "    1     0     1 Ss   Sat Nov  1 09:00:00 2026 /sbin/launchd\n  812     1   812 S    Sat Nov 21 10:15:30 2026 launchd_sim /s/device-set/AB/data/var/run/launchd_bootstrap.plist\n  900   812   812 Z    Sat Nov 21 10:15:31 2026 (SpringBoard)\n";
        let processes = parse(output).unwrap();
        assert_eq!(processes.len(), 3);
        assert_eq!(processes[0].started, "Sat Nov 1 09:00:00 2026");
        assert_eq!(processes[1].pgid, 812);
        assert!(processes[1]
            .command
            .starts_with("launchd_sim /s/device-set/AB/"));
        assert!(processes[2].zombie && !processes[1].zombie);
        assert!(parse("812 1 812 S Sat Nov 21\n").is_err());
        assert!(parse("abc 1 812 S Sat Nov 21 10:15:30 2026 x\n").is_err());
        assert!(parse("").is_err());
    }

    #[test]
    fn only_the_devices_own_launchd_and_executables_are_roots() {
        // The device's launchd_sim, with or without the runtime's path in front of it.
        for command in [
            "launchd_sim /s/1/device-set/AB/data/var/run/launchd_bootstrap.plist",
            "/Library/Runtimes/iOS 27.0.simruntime/RuntimeRoot/sbin/launchd_sim /s/1/device-set/AB/data/var/run/launchd_bootstrap.plist",
            "/bin/sh /fixture/launchd_sim /s/1/device-set/AB/data/boot.plist extra",
        ] {
            assert!(is_root(command, DEVICE), "{command}");
        }
        // Not this device, not launchd_sim, or only a mention of the path.
        for command in [
            "launchd_sim /s/1/device-set/ABC/data/boot.plist",
            "launchd_sim /s/1/device-set/CD/data/boot.plist",
            "launchd_sim /backup/s/1/device-set/AB/data/boot.plist",
            "my-launchd_sim /s/1/device-set/AB/data/boot.plist",
            "tail -f /s/1/device-set/AB/data/log",
            "/bin/sh -c cat /s/1/device-set/AB/data/x; launchd_sim",
            "xcrun simctl --set /s/1/device-set boot AB",
            "idb_companion --udid AB --device-set-path /s/1/device-set",
            "launchd_sim /s/1/device-set/AB",
        ] {
            assert!(!is_root(command, DEVICE), "{command}");
            assert!(!is_device_executable(command, DEVICE), "{command}");
        }
        // An executable started from inside the device, as an installed app is.
        assert!(is_device_executable(
            "/s/1/device-set/AB/data/Containers/Bundle/Application/X/Trial.app/Trial -flag",
            DEVICE
        ));
        for command in [
            "/s/1/device-set/ABC/data/app",
            "/backup/s/1/device-set/AB/data/app",
            "/s/1/device-set/AB",
            "/bin/sh /s/1/device-set/AB/data/script.sh",
        ] {
            assert!(!is_device_executable(command, DEVICE), "{command}");
        }
        assert!(!is_root("launchd_sim /x/", "") && !is_device_executable("/x/y", ""));
    }

    #[test]
    fn members_are_the_launch_lineage_and_never_a_process_that_only_mentions_the_set() {
        let own = std::process::id() as i32;
        let processes = vec![
            process(1, 0, 1, "/sbin/launchd"),
            process(
                100,
                1,
                100,
                "launchd_sim /s/1/device-set/AB/data/boot.plist",
            ),
            process(101, 100, 100, "SpringBoard"),
            process(102, 101, 102, "/runtime/usr/libexec/backboardd"),
            process(
                110,
                1,
                110,
                "/s/1/device-set/AB/data/Containers/Bundle/Trial.app/Trial",
            ),
            process(111, 110, 110, "helper"),
            // The companion, an operator's tail, a shell and the runner's simctl name the
            // device set and are not the simulator.
            process(
                200,
                1,
                200,
                "idb_companion --udid AB --device-set-path /s/1/device-set",
            ),
            process(201, 200, 200, "companion-helper"),
            process(210, 1, 210, "tail -f /s/1/device-set/AB/data/system.log"),
            process(211, 1, 211, "/bin/zsh -c ls /s/1/device-set/AB/data"),
            process(212, 211, 211, "ls /s/1/device-set/AB/data"),
            process(
                213,
                1,
                213,
                "xcrun simctl --set /s/1/device-set io AB screenshot",
            ),
            // Another lease's simulator.
            process(
                300,
                1,
                300,
                "launchd_sim /s/2/device-set/CD/data/boot.plist",
            ),
            process(301, 300, 300, "SpringBoard"),
            // This process is never a member, whatever its own arguments name.
            process(
                own,
                1,
                own,
                "launchd_sim /s/1/device-set/AB/data/boot.plist",
            ),
            process(400, own, own, "/bin/ps"),
        ];
        let none = BTreeMap::new();
        let found: Vec<i32> = members(&processes, DEVICE, &none, None)
            .iter()
            .map(|p| p.pid)
            .collect();
        assert_eq!(found, vec![100, 101, 102, 110, 111]);
        // A member in the excluded group belongs to that group's own owner.
        let found: Vec<i32> = members(&processes, DEVICE, &none, Some(110))
            .iter()
            .map(|p| p.pid)
            .collect();
        assert_eq!(found, vec![100, 101, 102]);
    }

    #[test]
    fn a_recorded_member_is_found_after_its_parent_is_gone_and_forgotten_once_absent() {
        let mut tree = Tree::new(DEVICE);
        let booted = vec![
            process(
                100,
                1,
                100,
                "launchd_sim /s/1/device-set/AB/data/boot.plist",
            ),
            process(101, 100, 100, "SpringBoard"),
        ];
        assert!(!tree.observed);
        assert_eq!(tree.observe(&booted, None), (true, true));
        assert!(tree.observed);
        assert_eq!(tree.observe(&booted, None), (true, false));
        // launchd_sim died; its child was reparented and names nothing.
        let orphaned = vec![process(101, 1, 100, "SpringBoard")];
        assert!(members(&orphaned, DEVICE, &BTreeMap::new(), None).is_empty());
        assert_eq!(pids(tree.alive(&orphaned, None)), vec![101]);
        // What the recorded member starts afterwards is a member too, and is recorded, so it
        // is still found when that parent is gone as well.
        let grown = vec![
            process(101, 1, 100, "SpringBoard"),
            process(102, 101, 100, "late-child"),
        ];
        assert_eq!(pids(tree.alive(&grown, None)), vec![101, 102]);
        assert_eq!(tree.observe(&grown, None), (true, true));
        let orphaned_again = vec![process(102, 1, 100, "late-child")];
        assert_eq!(pids(tree.alive(&orphaned_again, None)), vec![102]);
        // The same PID with another start time is another process.
        let mut reused = process(101, 1, 101, "unrelated");
        reused.started = "Sat Nov 21 11:00:00 2026".into();
        assert!(tree.alive(&[reused], None).is_empty());
        // A zombie executes nothing.
        let mut zombie = process(101, 1, 100, "(SpringBoard)");
        zombie.zombie = true;
        assert!(tree.alive(&[zombie], None).is_empty());
        assert_eq!(
            tree.observe(&[process(1, 0, 1, "/sbin/launchd")], None),
            (false, true)
        );
        assert!(tree.seen.is_empty() && !tree.truncated && tree.observed);
    }

    #[test]
    fn a_tree_whose_root_never_named_the_device_is_never_observed() {
        let mut tree = Tree::new(DEVICE);
        // Simulator-like processes that do not name the device: the premise does not hold.
        let unnamed = vec![
            process(100, 1, 100, "launchd_sim"),
            process(101, 100, 100, "SpringBoard"),
        ];
        assert_eq!(tree.observe(&unnamed, None), (false, false));
        assert!(!tree.observed && tree.seen.is_empty());
        // An executable inside the device is a member, but it is not the launchd root.
        let app = vec![process(110, 1, 110, "/s/1/device-set/AB/data/app")];
        assert_eq!(tree.observe(&app, None), (true, true));
        assert!(!tree.observed);
    }

    #[test]
    fn more_members_than_the_bound_make_the_record_incomplete() {
        let mut tree = Tree::new(DEVICE);
        let mut processes = vec![process(
            2,
            1,
            2,
            "launchd_sim /s/1/device-set/AB/data/boot.plist",
        )];
        for pid in 0..MEMBER_LIMIT as i32 + 5 {
            processes.push(process(10 + pid, 2, 2, "child"));
        }
        tree.observe(&processes, None);
        assert!(tree.truncated);
        assert_eq!(tree.seen.len(), MEMBER_LIMIT);
    }

    #[test]
    fn the_live_inventory_contains_this_process_and_identifies_it_by_start_time() {
        let processes = inventory().unwrap();
        let own = processes
            .iter()
            .find(|p| p.pid == std::process::id() as i32)
            .expect("own process is listed");
        assert!(!own.zombie && own.started.len() >= 20 && !own.command.is_empty());
        // The single-process read used before a signal agrees with the inventory.
        assert_eq!(
            started(own.pid).unwrap().as_deref(),
            Some(own.started.as_str())
        );
    }

    #[test]
    fn a_signal_is_sent_only_to_the_process_that_started_at_the_recorded_time() {
        let mut child = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let pid = child.id() as i32;
        let identity = started(pid).unwrap().expect("the child is running");
        // Another start time is another process: nothing is sent.
        assert!(!signal(pid, "Thu Jan 1 00:00:00 1970", libc::SIGKILL));
        assert!(child.try_wait().unwrap().is_none());
        assert!(signal(pid, &identity, libc::SIGKILL));
        child.wait().unwrap();
        // The PID is gone: no start time, and no signal.
        assert_eq!(started(pid).unwrap(), None);
        assert!(!signal(pid, &identity, libc::SIGKILL));
        // This process and PID 1 are never signalled.
        let own = std::process::id() as i32;
        assert!(!signal(own, &started(own).unwrap().unwrap(), libc::SIGKILL));
        assert!(!signal(1, "anything", libc::SIGKILL));
    }

    #[test]
    fn a_stalled_command_is_killed_at_its_limit_with_its_pipe_still_open() {
        // The command and its child both keep stdout open and never write or exit.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 60 & sleep 60"]);
        let begun = Instant::now();
        let result = bounded(command, Duration::from_millis(300), 1024, || None);
        assert_eq!(result, Err(Halt::Limit));
        assert!(
            begun.elapsed() < Duration::from_secs(5),
            "{:?}",
            begun.elapsed()
        );
        // A caller's stop reason interrupts it sooner than its limit.
        let mut command = Command::new("/bin/sleep");
        command.arg("60");
        let begun = Instant::now();
        let mut polls = 0;
        let result = bounded(command, Duration::from_secs(30), 0, || {
            polls += 1;
            (polls > 3).then_some("fenced")
        });
        assert_eq!(result, Err(Halt::Reason("fenced")));
        assert!(begun.elapsed() < Duration::from_secs(5));
        // Output beyond the capture bound is a failure, not a truncated success.
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf 0123456789"]);
        assert_eq!(
            bounded(command, Duration::from_secs(5), 4, || None),
            Err(Halt::Failed)
        );
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "printf ok; exit 3"]);
        assert_eq!(
            bounded(command, Duration::from_secs(5), 16, || None),
            Ok((Some(3), b"ok".to_vec()))
        );
    }
}
