use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf};
use virtual_fs::{FsError, VirtualFile};

#[derive(Clone, Debug)]
pub struct OutputCapture {
    state: Arc<Mutex<State>>,
    budget: OutputBudget,
}

#[derive(Debug)]
struct State {
    bytes: Vec<u8>,
    exceeded: bool,
}

#[derive(Clone, Debug)]
pub struct OutputBudget {
    state: Arc<Mutex<BudgetState>>,
}

#[derive(Debug)]
struct BudgetState {
    used: usize,
    limit: usize,
    exceeded: bool,
}

impl OutputCapture {
    pub fn new(budget: OutputBudget, special_fd: u32) -> (Self, CappedOutput) {
        let capture = Self {
            state: Arc::new(Mutex::new(State {
                bytes: Vec::new(),
                exceeded: false,
            })),
            budget,
        };
        let file = CappedOutput {
            state: capture.state.clone(),
            budget: capture.budget.clone(),
            special_fd: Some(special_fd),
        };
        (capture, file)
    }

    pub fn bytes(&self) -> Vec<u8> {
        self.state
            .lock()
            .expect("output capture lock poisoned")
            .bytes
            .clone()
    }

    pub fn exceeded(&self) -> bool {
        self.state
            .lock()
            .expect("output capture lock poisoned")
            .exceeded
            || self.budget.exceeded()
    }

    pub fn file(&self, special_fd: u32) -> CappedOutput {
        CappedOutput {
            state: self.state.clone(),
            budget: self.budget.clone(),
            special_fd: Some(special_fd),
        }
    }
}

impl OutputBudget {
    pub fn new(limit: usize) -> Self {
        Self {
            state: Arc::new(Mutex::new(BudgetState {
                used: 0,
                limit,
                exceeded: false,
            })),
        }
    }

    fn exceeded(&self) -> bool {
        self.state
            .lock()
            .expect("output budget lock poisoned")
            .exceeded
    }
}

#[derive(Debug)]
pub struct CappedOutput {
    state: Arc<Mutex<State>>,
    budget: OutputBudget,
    special_fd: Option<u32>,
}

impl AsyncWrite for CappedOutput {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        input: &[u8],
    ) -> Poll<io::Result<usize>> {
        let mut budget = self
            .budget
            .state
            .lock()
            .expect("output budget lock poisoned");
        let remaining = budget.limit.saturating_sub(budget.used);
        let mut state = self.state.lock().expect("output capture lock poisoned");
        if input.len() > remaining {
            state.bytes.extend_from_slice(&input[..remaining]);
            state.exceeded = true;
            budget.used = budget.limit;
            budget.exceeded = true;
            return Poll::Ready(Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "output limit exceeded",
            )));
        }
        state.bytes.extend_from_slice(input);
        budget.used += input.len();
        Poll::Ready(Ok(input.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for CappedOutput {
    fn poll_read(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        _buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for CappedOutput {
    fn start_seek(self: Pin<&mut Self>, _position: io::SeekFrom) -> io::Result<()> {
        Ok(())
    }

    fn poll_complete(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for CappedOutput {
    fn last_accessed(&self) -> u64 {
        0
    }
    fn last_modified(&self) -> u64 {
        0
    }
    fn created_time(&self) -> u64 {
        0
    }
    fn size(&self) -> u64 {
        0
    }

    fn set_len(&mut self, _new_size: u64) -> Result<(), FsError> {
        // stdout/stderr are streams; WASI metadata updates must not allocate.
        Ok(())
    }

    fn unlink(&mut self) -> Result<(), FsError> {
        Ok(())
    }

    fn get_special_fd(&self) -> Option<u32> {
        self.special_fd
    }

    fn poll_read_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        let budget = self
            .budget
            .state
            .lock()
            .expect("output budget lock poisoned");
        let remaining = budget.limit.saturating_sub(budget.used);
        if remaining == 0 {
            Poll::Ready(Err(io::Error::new(
                io::ErrorKind::FileTooLarge,
                "output limit exceeded",
            )))
        } else {
            Poll::Ready(Ok(remaining.min(8_192)))
        }
    }
}
