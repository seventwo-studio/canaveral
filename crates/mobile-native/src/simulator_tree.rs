//! Process inventory for one leased iOS simulator's private device set.
//!
//! CoreSimulator starts a simulator's `launchd_sim` through launchd, so it is never a
//! child of the lease supervisor and cannot be put in a process group the supervisor
//! owns. The only handle is the lease's private device-set directory: `launchd_sim`
//! is started with a bootstrap path inside it, and every app installed on the device
//! runs from a bundle inside it.
//!
//! A tree is therefore every live process whose command line names the device set,
//! every live descendant of such a process, and every process recorded as a member
//! while its parent was still alive. Absence of that tree is the stop proof. It does
//! not cover a process that left the tree between two samples without naming the
//! device set (a double fork between samples), nor anything the simulated code
//! started through host services outside the tree. Native acceptance is open.
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Recorded members beyond this bound make the proof incomplete instead of unbounded.
pub const MEMBER_LIMIT: usize = 1024;
const INVENTORY_LIMIT: u64 = 64 << 20;

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

/// Every process this account can see, with full-width command lines.
pub fn inventory() -> Result<Vec<Process>> {
    let mut child = Command::new("/bin/ps")
        .args(["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,command="])
        .env_clear()
        .env("LC_ALL", "C")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()?;
    let mut data = Vec::new();
    let read = child
        .stdout
        .take()
        .ok_or("Missing inventory output")?
        .take(INVENTORY_LIMIT + 1)
        .read_to_end(&mut data);
    let deadline = Instant::now() + Duration::from_secs(10);
    let status = loop {
        match child.try_wait()? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                // Our own unreaped child: its PID cannot have been reused.
                let _ = child.kill();
                let _ = child.wait();
                return Err("Process inventory timed out".into());
            }
            None => std::thread::sleep(Duration::from_millis(5)),
        }
    };
    read?;
    if !status.success() || data.len() as u64 > INVENTORY_LIMIT {
        return Err("Process inventory failed".into());
    }
    parse(&String::from_utf8_lossy(&data))
}

/// Whether a command line names the device set as a path, not as a prefix of another name.
pub fn names(command: &str, set: &str) -> bool {
    if set.is_empty() {
        return false;
    }
    command.match_indices(set).any(|(at, _)| {
        !command[at + set.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || ['.', '_', '-'].contains(&c))
    })
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

/// Live processes naming the device set, and their live descendants. `excluded` is a
/// process group stopped and proven absent by its own owner (the supervisor's child).
pub fn members<'a>(processes: &'a [Process], set: &str, excluded: Option<i32>) -> Vec<&'a Process> {
    let own = lineage(processes);
    let eligible =
        |p: &Process| p.pid > 1 && !p.zombie && !own.contains(&p.pid) && Some(p.pgid) != excluded;
    let mut found: BTreeSet<i32> = processes
        .iter()
        .filter(|p| eligible(p) && names(&p.command, set))
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
    pub set: String,
    pub seen: BTreeMap<i32, String>,
    /// More members than `MEMBER_LIMIT` were alive at once; absence can no longer be proven.
    pub truncated: bool,
}

impl Tree {
    pub fn new(set: &str) -> Self {
        Tree {
            set: set.to_owned(),
            ..Tree::default()
        }
    }
    fn alive_recorded(&self, processes: &[Process]) -> Vec<i32> {
        self.seen
            .iter()
            .filter(|(pid, started)| {
                processes
                    .iter()
                    .any(|p| p.pid == **pid && &p.started == *started && !p.zombie)
            })
            .map(|(pid, _)| *pid)
            .collect()
    }
    /// Records the current members and forgets recorded ones that are positively gone.
    /// Returns whether any member is present, and whether the record changed.
    pub fn observe(&mut self, processes: &[Process], excluded: Option<i32>) -> (bool, bool) {
        let before = self.seen.clone();
        let alive: BTreeSet<i32> = self.alive_recorded(processes).into_iter().collect();
        self.seen.retain(|pid, _| alive.contains(pid));
        let current = members(processes, &self.set, excluded);
        for p in &current {
            if self.seen.len() >= MEMBER_LIMIT && !self.seen.contains_key(&p.pid) {
                self.truncated = true;
            } else {
                self.seen.insert(p.pid, p.started.clone());
            }
        }
        (!current.is_empty(), before != self.seen)
    }
    /// Every member still present in this inventory: current members and recorded ones
    /// whose PID still holds a process with the recorded start time.
    pub fn alive(&self, processes: &[Process], excluded: Option<i32>) -> Vec<i32> {
        let own = lineage(processes);
        let mut result: BTreeSet<i32> = members(processes, &self.set, excluded)
            .iter()
            .map(|p| p.pid)
            .collect();
        result.extend(
            self.alive_recorded(processes)
                .into_iter()
                .filter(|pid| *pid > 1 && !own.contains(pid)),
        );
        result.into_iter().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn a_device_set_is_named_only_as_a_whole_path() {
        let set = "/s/1/device-set";
        assert!(names(
            "launchd_sim /s/1/device-set/AB/data/launchd_bootstrap.plist",
            set
        ));
        assert!(names(
            "idb_companion --device-set-path /s/1/device-set",
            set
        ));
        assert!(names(
            "simctl --set /s/1/device-set boot AB /s/1/device-set-2",
            set
        ));
        assert!(!names("launchd_sim /s/1/device-set-2/AB/data", set));
        assert!(!names("launchd_sim /s/1/device-set.old/AB", set));
        assert!(!names("launchd_sim /s/1/device/AB", set));
        assert!(!names("anything", ""));
    }

    #[test]
    fn members_are_named_processes_and_their_descendants_only() {
        let set = "/s/1/device-set";
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
                200,
                1,
                200,
                "idb_companion --device-set-path /s/1/device-set",
            ),
            process(201, 200, 200, "helper"),
            process(
                300,
                1,
                300,
                "launchd_sim /s/2/device-set/CD/data/boot.plist",
            ),
            process(301, 300, 300, "SpringBoard"),
            // This process is never a member, even when its own arguments name the set.
            process(own, 1, own, "lease-simulator-status /s/1 /s/1/device-set"),
            process(400, own, own, "/bin/ps"),
        ];
        let pids = |excluded| -> Vec<i32> {
            members(&processes, set, excluded)
                .iter()
                .map(|p| p.pid)
                .collect()
        };
        assert_eq!(pids(Some(200)), vec![100, 101, 102]);
        assert_eq!(pids(None), vec![100, 101, 102, 200, 201]);
    }

    #[test]
    fn a_recorded_member_is_found_after_its_parent_is_gone_and_forgotten_once_absent() {
        let set = "/s/1/device-set";
        let mut tree = Tree::new(set);
        let booted = vec![
            process(
                100,
                1,
                100,
                "launchd_sim /s/1/device-set/AB/data/boot.plist",
            ),
            process(101, 100, 100, "SpringBoard"),
        ];
        assert_eq!(tree.observe(&booted, None), (true, true));
        assert_eq!(tree.observe(&booted, None), (true, false));
        // launchd_sim died; its child was reparented and names nothing.
        let orphaned = vec![process(101, 1, 100, "SpringBoard")];
        assert!(members(&orphaned, set, None).is_empty());
        assert_eq!(tree.alive(&orphaned, None), vec![101]);
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
        assert!(tree.seen.is_empty() && !tree.truncated);
    }

    #[test]
    fn more_members_than_the_bound_make_the_record_incomplete() {
        let set = "/s/1/device-set";
        let mut tree = Tree::new(set);
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
    fn the_live_inventory_contains_this_process() {
        let processes = inventory().unwrap();
        let own = processes
            .iter()
            .find(|p| p.pid == std::process::id() as i32)
            .expect("own process is listed");
        assert!(!own.zombie && own.started.len() >= 20 && !own.command.is_empty());
    }
}
