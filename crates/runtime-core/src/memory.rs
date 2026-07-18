#[cfg(not(target_arch = "wasm32"))]
mod native {
    use std::ptr::NonNull;
    use wasmer::sys::{
        Tunables,
        vm::{self, VMMemoryDefinition, VMTableDefinition},
    };
    use wasmer::{MemoryError, MemoryStyle, MemoryType, Pages, TableStyle, TableType};

    pub struct LimitingTunables<T: Tunables> {
        limit: Pages,
        base: T,
    }

    impl<T: Tunables> LimitingTunables<T> {
        pub fn new(base: T, limit: Pages) -> Self {
            Self { limit, base }
        }

        fn adjusted(&self, requested: &MemoryType) -> Result<MemoryType, MemoryError> {
            if requested.minimum > self.limit
                || requested.maximum.is_some_and(|max| max > self.limit)
            {
                return Err(MemoryError::Generic(
                    "linear memory exceeds the configured hard limit".to_string(),
                ));
            }
            let mut adjusted = *requested;
            adjusted.maximum = Some(adjusted.maximum.unwrap_or(self.limit).min(self.limit));
            Ok(adjusted)
        }
    }

    impl<T: Tunables> Tunables for LimitingTunables<T> {
        fn memory_style(&self, memory: &MemoryType) -> MemoryStyle {
            let adjusted = self.adjusted(memory).unwrap_or(*memory);
            self.base.memory_style(&adjusted)
        }

        fn table_style(&self, table: &TableType) -> TableStyle {
            self.base.table_style(table)
        }

        fn create_host_memory(
            &self,
            ty: &MemoryType,
            style: &MemoryStyle,
        ) -> Result<vm::VMMemory, MemoryError> {
            self.base.create_host_memory(&self.adjusted(ty)?, style)
        }

        unsafe fn create_vm_memory(
            &self,
            ty: &MemoryType,
            style: &MemoryStyle,
            definition: NonNull<VMMemoryDefinition>,
        ) -> Result<vm::VMMemory, MemoryError> {
            unsafe {
                self.base
                    .create_vm_memory(&self.adjusted(ty)?, style, definition)
            }
        }

        fn create_host_table(
            &self,
            ty: &TableType,
            style: &TableStyle,
        ) -> Result<vm::VMTable, String> {
            self.base.create_host_table(ty, style)
        }

        unsafe fn create_vm_table(
            &self,
            ty: &TableType,
            style: &TableStyle,
            definition: NonNull<VMTableDefinition>,
        ) -> Result<vm::VMTable, String> {
            unsafe { self.base.create_vm_table(ty, style, definition) }
        }
    }
}

#[cfg(not(target_arch = "wasm32"))]
pub use native::LimitingTunables;
