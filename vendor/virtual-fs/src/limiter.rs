use std::sync::Arc;

use crate::FsError;

pub use self::tracked_vec::TrackedVec;

/// Allows tracking and limiting the memory usage of a memfs [`FileSystem`](crate::FileSystem).
pub trait FsMemoryLimiter: Send + Sync + std::fmt::Debug {
    /// Reserve additional logical file-buffer bytes before allocation.
    fn on_grow(&self, grown_bytes: usize) -> std::result::Result<(), FsError>;
    /// Release logical file-buffer bytes after truncation or removal.
    fn on_shrink(&self, shrunk_bytes: usize);

    /// Reserve one filesystem inode before it is inserted into the memfs slab.
    fn on_create_entry(&self) -> std::result::Result<(), FsError> {
        Ok(())
    }

    /// Release one filesystem inode after it is removed from the memfs slab.
    fn on_remove_entry(&self) {}
}

pub type DynFsMemoryLimiter = Arc<dyn FsMemoryLimiter + Send + Sync>;

#[cfg(feature = "tracking")]
mod tracked_vec {
    use crate::FsError;

    use super::DynFsMemoryLimiter;

    #[derive(Debug)]
    pub struct TrackedVec {
        data: Vec<u8>,
        pub(super) limiter: Option<DynFsMemoryLimiter>,
    }

    impl TrackedVec {
        pub fn new(limiter: Option<DynFsMemoryLimiter>) -> Self {
            Self {
                data: Vec::new(),
                limiter,
            }
        }

        pub fn limiter(&self) -> Option<&DynFsMemoryLimiter> {
            self.limiter.as_ref()
        }

        pub fn with_capacity(
            capacity: usize,
            limiter: Option<DynFsMemoryLimiter>,
        ) -> Result<Self, FsError> {
            let mut data = Vec::new();
            if data.try_reserve_exact(capacity).is_err() {
                return Err(FsError::StorageFull);
            }
            Ok(Self { data, limiter })
        }

        pub fn clear(&mut self) {
            let old_len = self.data.len();
            self.data.clear();
            self.data.shrink_to_fit();
            if let Some(limiter) = &self.limiter {
                limiter.on_shrink(old_len);
            }
        }

        pub fn append(&mut self, other: &mut Self) -> Result<(), FsError> {
            let moved = other.data.len();
            let same_limiter = match (&self.limiter, &other.limiter) {
                (Some(left), Some(right)) => std::sync::Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            };
            if !same_limiter {
                self.reserve_logical_growth(moved)?;
            }
            if self.data.try_reserve(moved).is_err() {
                if !same_limiter && let Some(limiter) = &self.limiter {
                    limiter.on_shrink(moved);
                }
                return Err(FsError::StorageFull);
            }
            self.data.append(&mut other.data);
            other.data.shrink_to_fit();
            if !same_limiter && let Some(limiter) = &other.limiter {
                limiter.on_shrink(moved);
            }
            Ok(())
        }

        pub fn split_off(&mut self, at: usize) -> Result<Self, FsError> {
            if at > self.data.len() {
                return Err(FsError::InvalidInput);
            }
            let tail = &self.data[at..];
            let mut other = Self::with_capacity(tail.len(), self.limiter.clone())?;
            other.data.extend_from_slice(tail);
            self.data.truncate(at);
            self.data.shrink_to_fit();
            Ok(other)
        }

        pub fn resize(&mut self, new_len: usize, value: u8) -> Result<(), FsError> {
            let old_len = self.data.len();
            if new_len > old_len {
                let growth = new_len - old_len;
                self.reserve_logical_growth(growth)?;
                if self.data.try_reserve(new_len - old_len).is_err() {
                    if let Some(limiter) = &self.limiter {
                        limiter.on_shrink(growth);
                    }
                    return Err(FsError::StorageFull);
                }
            }
            self.data.resize(new_len, value);
            if new_len < old_len {
                self.data.shrink_to_fit();
                if let Some(limiter) = &self.limiter {
                    limiter.on_shrink(old_len - new_len);
                }
            }
            Ok(())
        }

        pub fn extend_from_slice(&mut self, other: &[u8]) -> Result<(), FsError> {
            self.data
                .len()
                .checked_add(other.len())
                .ok_or(FsError::StorageFull)?;
            self.reserve_logical_growth(other.len())?;
            if self.data.try_reserve(other.len()).is_err() {
                if let Some(limiter) = &self.limiter {
                    limiter.on_shrink(other.len());
                }
                return Err(FsError::StorageFull);
            }
            self.data.extend_from_slice(other);
            Ok(())
        }

        pub fn reserve_exact(&mut self, additional: usize) -> Result<(), FsError> {
            self.data
                .try_reserve_exact(additional)
                .map_err(|_| FsError::StorageFull)
        }

        fn reserve_logical_growth(&self, growth: usize) -> Result<(), FsError> {
            if let Some(limiter) = &self.limiter {
                limiter.on_grow(growth)?;
            }
            Ok(())
        }
    }

    impl Drop for TrackedVec {
        fn drop(&mut self) {
            if let Some(limiter) = &self.limiter {
                limiter.on_shrink(self.data.len());
            }
        }
    }

    impl std::ops::Deref for TrackedVec {
        type Target = [u8];

        fn deref(&self) -> &Self::Target {
            &self.data
        }
    }

    impl std::ops::DerefMut for TrackedVec {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.data
        }
    }
}

#[cfg(not(feature = "tracking"))]
mod tracked_vec {
    use crate::FsError;

    use super::DynFsMemoryLimiter;

    #[derive(Debug)]
    pub struct TrackedVec {
        data: Vec<u8>,
    }

    impl TrackedVec {
        pub fn new(_limiter: Option<DynFsMemoryLimiter>) -> Self {
            Self { data: Vec::new() }
        }

        pub fn limiter(&self) -> Option<&DynFsMemoryLimiter> {
            None
        }

        pub fn with_capacity(
            capacity: usize,
            _limiter: Option<DynFsMemoryLimiter>,
        ) -> Result<Self, FsError> {
            Ok(Self {
                data: Vec::with_capacity(capacity),
            })
        }

        pub fn clear(&mut self) {
            self.data.clear();
        }

        pub fn append(&mut self, other: &mut Self) -> Result<(), FsError> {
            self.data.append(&mut other.data);
            Ok(())
        }

        pub fn split_off(&mut self, at: usize) -> Result<Self, FsError> {
            let other = self.data.split_off(at);
            Ok(Self { data: other })
        }

        pub fn resize(&mut self, new_len: usize, value: u8) -> Result<(), FsError> {
            self.data.resize(new_len, value);
            Ok(())
        }

        pub fn extend_from_slice(&mut self, other: &[u8]) -> Result<(), FsError> {
            self.data.extend_from_slice(other);
            Ok(())
        }

        pub fn reserve_exact(&mut self, additional: usize) -> Result<(), FsError> {
            self.data.reserve_exact(additional);
            Ok(())
        }
    }

    impl std::ops::Deref for TrackedVec {
        type Target = Vec<u8>;

        fn deref(&self) -> &Self::Target {
            &self.data
        }
    }

    impl std::ops::DerefMut for TrackedVec {
        fn deref_mut(&mut self) -> &mut Self::Target {
            &mut self.data
        }
    }
}
