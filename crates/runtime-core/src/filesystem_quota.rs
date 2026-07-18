use crate::RunError;
use std::sync::{Arc, Mutex};
use virtual_fs::{FsError, limiter::FsMemoryLimiter};

#[derive(Debug)]
pub(crate) struct VfsQuota {
    state: Mutex<VfsQuotaState>,
}

#[derive(Debug)]
struct VfsQuotaState {
    bytes: usize,
    entries: usize,
    byte_ceiling: Option<usize>,
    entry_ceiling: Option<usize>,
    peak_bytes: usize,
    peak_entries: usize,
    exceeded: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct VfsMetrics {
    pub bytes: u64,
    pub entries: u64,
}

impl VfsQuota {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(VfsQuotaState {
                bytes: 0,
                entries: 0,
                byte_ceiling: None,
                entry_ceiling: None,
                peak_bytes: 0,
                peak_entries: 0,
                exceeded: false,
            }),
        })
    }

    /// Seal the mounted filesystem as the baseline and allow only the supplied
    /// additional live file data and inode counts during guest execution.
    pub fn seal(&self, write_bytes: usize, entries: usize) -> Result<(), RunError> {
        let mut state = self
            .state
            .lock()
            .map_err(|error| RunError::Runtime(error.to_string()))?;
        if state.byte_ceiling.is_some() || state.entry_ceiling.is_some() {
            return Err(RunError::Runtime(
                "runtime filesystem quota was sealed more than once".to_string(),
            ));
        }
        state.byte_ceiling = Some(state.bytes.checked_add(write_bytes).ok_or_else(|| {
            RunError::InvalidRequest("filesystem byte quota overflows host range".to_string())
        })?);
        state.entry_ceiling = Some(state.entries.checked_add(entries).ok_or_else(|| {
            RunError::InvalidRequest("filesystem entry quota overflows host range".to_string())
        })?);
        state.peak_bytes = state.bytes;
        state.peak_entries = state.entries;
        Ok(())
    }

    pub fn exceeded(&self) -> bool {
        self.state.lock().expect("VFS quota lock poisoned").exceeded
    }

    pub fn metrics(&self) -> VfsMetrics {
        let state = self.state.lock().expect("VFS quota lock poisoned");
        VfsMetrics {
            bytes: state.peak_bytes as u64,
            entries: state.peak_entries as u64,
        }
    }
}

impl FsMemoryLimiter for VfsQuota {
    fn on_grow(&self, grown_bytes: usize) -> Result<(), FsError> {
        let mut state = self.state.lock().map_err(|_| FsError::Lock)?;
        let next = state
            .bytes
            .checked_add(grown_bytes)
            .ok_or(FsError::WriteZero)?;
        if state.byte_ceiling.is_some_and(|limit| next > limit) {
            state.exceeded = true;
            return Err(FsError::WriteZero);
        }
        state.bytes = next;
        state.peak_bytes = state.peak_bytes.max(next);
        Ok(())
    }

    fn on_shrink(&self, shrunk_bytes: usize) {
        let mut state = self.state.lock().expect("VFS quota lock poisoned");
        state.bytes = state
            .bytes
            .checked_sub(shrunk_bytes)
            .expect("VFS byte accounting underflow");
    }

    fn on_create_entry(&self) -> Result<(), FsError> {
        let mut state = self.state.lock().map_err(|_| FsError::Lock)?;
        let next = state.entries.checked_add(1).ok_or(FsError::WriteZero)?;
        if state.entry_ceiling.is_some_and(|limit| next > limit) {
            state.exceeded = true;
            return Err(FsError::WriteZero);
        }
        state.entries = next;
        state.peak_entries = state.peak_entries.max(next);
        Ok(())
    }

    fn on_remove_entry(&self) {
        let mut state = self.state.lock().expect("VFS quota lock poisoned");
        state.entries = state
            .entries
            .checked_sub(1)
            .expect("VFS entry accounting underflow");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_a_baseline_and_trips_sticky_limits() {
        let quota = VfsQuota::new();
        quota.on_grow(10).unwrap();
        quota.on_create_entry().unwrap();
        quota.seal(4, 1).unwrap();

        quota.on_grow(4).unwrap();
        quota.on_create_entry().unwrap();
        assert_eq!(
            quota.metrics(),
            VfsMetrics {
                bytes: 14,
                entries: 2
            }
        );
        assert_eq!(quota.on_grow(1), Err(FsError::WriteZero));
        assert!(quota.exceeded());
    }

    #[test]
    fn deletion_releases_live_storage_headroom() {
        let quota = VfsQuota::new();
        quota.on_grow(10).unwrap();
        quota.on_create_entry().unwrap();
        quota.seal(4, 1).unwrap();
        quota.on_shrink(10);
        quota.on_remove_entry();

        quota.on_grow(14).unwrap();
        quota.on_create_entry().unwrap();
        assert!(!quota.exceeded());
        assert_eq!(
            quota.metrics(),
            VfsMetrics {
                bytes: 14,
                entries: 1
            }
        );
    }
}
