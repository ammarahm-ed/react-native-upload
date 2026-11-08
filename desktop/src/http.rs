use std::io::{self, Read, Seek, SeekFrom};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use ureq::config::Config;
use ureq::tls::{RootCerts, TlsConfig};
use ureq::{Agent, SendBody};

#[derive(Default)]
pub struct Flag(AtomicBool);

impl Flag {
    pub fn set(&self, value: bool) {
        self.0.store(value, Ordering::SeqCst);
    }

    pub fn is_set(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug)]
pub enum HttpError {
    Cancelled,
    Network(String),
}

pub struct Response {
    pub status: u16,
    pub body: String,
    pub etag: Option<String>,
}

fn agent() -> &'static Agent {
    static AGENT: OnceLock<Agent> = OnceLock::new();
    AGENT.get_or_init(|| {
        let config = Config::builder()
            .http_status_as_error(false)
            .timeout_connect(Some(Duration::from_secs(60)))
            .timeout_recv_response(Some(Duration::from_secs(120)))
            .tls_config(
                TlsConfig::builder()
                    .root_certs(RootCerts::PlatformVerifier)
                    .build(),
            )
            .build();
        Agent::new_with_config(config)
    })
}

/// Counts the bytes handed to the HTTP stack, reports the total, and stops when
/// `stop` is set.
pub struct Tracked<R> {
    inner: R,
    stop: Arc<Flag>,
    total: u64,
    report: Box<dyn FnMut(u64) + Send>,
}

impl<R> Tracked<R> {
    pub fn new(inner: R, stop: Arc<Flag>, report: Box<dyn FnMut(u64) + Send>) -> Self {
        Self {
            inner,
            stop,
            total: 0,
            report,
        }
    }
}

impl<R: Read> Read for Tracked<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.stop.is_set() {
            return Err(io::Error::new(io::ErrorKind::Interrupted, "cancelled"));
        }
        let read = self.inner.read(buf)?;
        self.total += read as u64;
        (self.report)(self.total);
        Ok(read)
    }
}

/// `size` bytes of a file starting at `offset`.
pub struct FileRegion {
    file: std::fs::File,
    remaining: u64,
}

impl FileRegion {
    pub fn open(path: &std::path::Path, offset: u64, size: u64) -> io::Result<Self> {
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::Start(offset))?;
        Ok(Self {
            file,
            remaining: size,
        })
    }
}

impl Read for FileRegion {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.remaining == 0 {
            return Ok(0);
        }
        let limit = buf
            .len()
            .min(self.remaining.min(usize::MAX as u64) as usize);
        let read = self.file.read(&mut buf[..limit])?;
        if read == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "unexpected end of file while reading chunk",
            ));
        }
        self.remaining -= read as u64;
        Ok(read)
    }
}

pub struct Request {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub length: u64,
}

fn run(request: Request, body: impl Read + Send + 'static) -> Result<Response, HttpError> {
    let mut builder = ureq::http::Request::builder()
        .method(request.method.as_str())
        .uri(request.url.as_str());
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let built = builder
        .header("content-length", request.length)
        .body(SendBody::from_owned_reader(body))
        .map_err(|e| HttpError::Network(e.to_string()))?;
    let mut response = agent()
        .run(built)
        .map_err(|e| HttpError::Network(e.to_string()))?;
    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().trim_matches('"').to_string());
    let body = response
        .body_mut()
        .with_config()
        .limit(16 * 1024 * 1024)
        .lossy_utf8(true)
        .read_to_string()
        .unwrap_or_default();
    Ok(Response { status, body, etag })
}

/// Sends `body` and returns the response. The request runs on its own thread
/// so a cancel is honoured while waiting for the server, not only while
/// sending.
pub fn send(
    request: Request,
    body: impl Read + Send + 'static,
    stop: &Flag,
) -> Result<Response, HttpError> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(run(request, body));
    });
    loop {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(result) => {
                return match result {
                    Err(_) if stop.is_set() => Err(HttpError::Cancelled),
                    other => other,
                }
            }
            Err(RecvTimeoutError::Timeout) if stop.is_set() => return Err(HttpError::Cancelled),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                return Err(HttpError::Network("the request thread stopped".into()))
            }
        }
    }
}
