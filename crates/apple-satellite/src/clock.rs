//! Suspend-aware elapsed time for execution and controller-contact fencing.
use std::time::Duration;
#[derive(Clone, Copy)]
pub struct Clock(Duration);
impl Clock {
    pub fn now() -> Self {
        Self(now())
    }
    pub fn elapsed(self) -> Duration {
        now().saturating_sub(self.0)
    }
}
#[cfg(target_os = "macos")]
pub fn now() -> Duration {
    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }
    unsafe extern "C" {
        fn mach_continuous_time() -> u64;
        fn mach_timebase_info(info: *mut Timebase) -> i32;
    }
    let mut info = Timebase { numer: 0, denom: 0 };
    // A failed kernel clock must not permit execution without a deadline.
    if unsafe { mach_timebase_info(&mut info) } != 0 || info.denom == 0 {
        std::process::abort();
    }
    let ticks = unsafe { mach_continuous_time() } as u128;
    Duration::from_nanos(
        (ticks * info.numer as u128 / info.denom as u128).min(u64::MAX as u128) as u64,
    )
}
#[cfg(target_os = "linux")]
pub fn now() -> Duration {
    let mut value = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &mut value) } != 0 {
        std::process::abort();
    }
    Duration::new(value.tv_sec as u64, value.tv_nsec as u32)
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
pub fn now() -> Duration {
    std::process::abort()
}
