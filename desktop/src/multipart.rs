use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rn_gpui_module::{ModuleError, Value};

use crate::http::{self, FileRegion, Flag, HttpError, Request, Tracked};
use crate::values;
use crate::Emitter;

const MIN_CHUNK_SIZE: u64 = 5 * 1024 * 1024;
const MAX_RETRIES: u32 = 3;
const PAUSE_POLL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Running,
    Completed,
    Failed,
}

impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }
}

pub struct Record {
    id: String,
    path: PathBuf,
    parts: Vec<String>,
    max_parallel: usize,
    total: u64,
    chunk: u64,
    etags: Mutex<Vec<String>>,
    status: Mutex<Status>,
    error: Mutex<Option<String>>,
}

impl Record {
    pub fn id(&self) -> &str {
        &self.id
    }

    pub fn total(&self) -> u64 {
        self.total
    }

    fn size_of(&self, index: usize) -> u64 {
        let offset = index as u64 * self.chunk;
        if index == self.parts.len() - 1 {
            self.total - offset
        } else {
            self.chunk
        }
    }

    pub fn uploaded(&self) -> u64 {
        let etags = self.etags.lock().expect("etags");
        (0..etags.len())
            .filter(|&i| !etags[i].is_empty())
            .map(|i| self.size_of(i))
            .sum()
    }

    pub fn etag_values(&self) -> Value {
        Value::Array(
            self.etags
                .lock()
                .expect("etags")
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        )
    }
}

#[derive(Default)]
pub struct Job {
    stop: Arc<Flag>,
    paused: Flag,
    user_cancelled: Flag,
}

enum Failure {
    Cancelled,
    Failed(String),
}

#[derive(Default)]
pub struct Engine {
    records: Mutex<HashMap<String, Arc<Record>>>,
    active: Mutex<HashMap<String, Arc<Job>>>,
}

fn invalid(message: impl ToString) -> ModuleError {
    ModuleError::with_code("INVALID_ARGUMENT", message.to_string())
}

fn parse(options: &Value) -> Result<(Record, Vec<String>), ModuleError> {
    let id = values::string(options, "uploadId").ok_or_else(|| invalid("uploadId is required"))?;
    let raw_path = values::string(options, "path").ok_or_else(|| invalid("path is required"))?;
    let path = values::path_from(&raw_path);
    let parts = values::strings(options, "parts").ok_or_else(|| invalid("parts is required"))?;
    if parts.is_empty() {
        return Err(invalid("parts array cannot be empty"));
    }
    let max_parallel = values::number(options, "maxParallel").map_or(3, |n| n.max(1.0) as usize);
    let existing = values::strings(options, "existingEtags").unwrap_or_default();

    let metadata = std::fs::metadata(&path)
        .ok()
        .filter(|m| m.is_file())
        .ok_or_else(|| invalid(format!("File does not exist at path: {}", path.display())))?;
    let total = metadata.len();
    if total == 0 {
        return Err(invalid(format!(
            "File is empty or invalid: {}",
            path.display()
        )));
    }
    let count = parts.len() as u64;
    let minimum = MIN_CHUNK_SIZE * (count - 1);
    if count > 1 && total <= minimum {
        return Err(invalid(format!(
            "File size ({total} bytes) is too small for {count} parts. Minimum required size: {} bytes.",
            minimum + 1
        )));
    }
    let chunk = total.div_ceil(count).max(MIN_CHUNK_SIZE);
    for index in 0..parts.len() {
        let offset = index as u64 * chunk;
        let size = if index == parts.len() - 1 {
            total.saturating_sub(offset)
        } else {
            chunk
        };
        if offset >= total || size == 0 {
            return Err(invalid(format!(
                "Part {} has invalid size ({size} bytes). Offset: {offset}, FileSize: {total}",
                index + 1
            )));
        }
    }
    Ok((
        Record {
            id,
            path,
            max_parallel,
            total,
            chunk,
            etags: Mutex::new(vec![String::new(); parts.len()]),
            status: Mutex::new(Status::Running),
            error: Mutex::new(None),
            parts,
        },
        existing,
    ))
}

impl Engine {
    pub fn start(
        self: &Arc<Self>,
        options: &Value,
        emitter: Emitter,
    ) -> Result<futures::channel::oneshot::Receiver<Result<Value, ModuleError>>, ModuleError> {
        let (record, existing) = parse(options)?;
        let record = Arc::new(record);
        let job = Arc::new(Job::default());
        {
            let mut active = self.active.lock().expect("active");
            if active.contains_key(&record.id) {
                return Err(ModuleError::with_code(
                    "ALREADY_EXISTS",
                    format!("Upload already in progress for {}", record.id),
                ));
            }
            active.insert(record.id.clone(), job.clone());
        }
        let preset = existing.len().min(record.parts.len());
        {
            let mut etags = record.etags.lock().expect("etags");
            for (i, etag) in existing.iter().take(preset).enumerate() {
                etags[i] = etag.clone();
            }
        }
        self.records
            .lock()
            .expect("records")
            .insert(record.id.clone(), record.clone());

        if record.uploaded() > 0 {
            emitter.multipart_progress(
                &record,
                (existing.iter().filter(|e| !e.is_empty()).count() as i64) - 1,
                None,
            );
        }

        let (sender, receiver) = futures::channel::oneshot::channel();
        let engine = self.clone();
        std::thread::spawn(move || {
            let outcome = execute(&record, &job, &emitter);
            engine.active.lock().expect("active").remove(&record.id);
            let result = match outcome {
                Ok(()) => {
                    *record.status.lock().expect("status") = Status::Completed;
                    *record.error.lock().expect("error") = None;
                    emitter.multipart_finished(&record, None);
                    Ok(Value::object([
                        ("uploadId", Value::String(record.id.clone())),
                        ("success", Value::Bool(true)),
                        ("etags", record.etag_values()),
                    ]))
                }
                Err(Failure::Cancelled) if job.user_cancelled.is_set() => {
                    engine.records.lock().expect("records").remove(&record.id);
                    emitter.multipart_cancelled(&record.id);
                    Err(ModuleError::with_code("CANCELLED", "Upload cancelled"))
                }
                Err(Failure::Cancelled) => {
                    fail(&record, &emitter, "Upload cancelled");
                    Err(ModuleError::with_code("CANCELLED", "Upload cancelled"))
                }
                Err(Failure::Failed(message)) => {
                    fail(&record, &emitter, &message);
                    Err(ModuleError::with_code("MULTIPART_UPLOAD_ERROR", message))
                }
            };
            let _ = sender.send(result);
        });
        Ok(receiver)
    }

    pub fn cancel(&self, id: &str) -> bool {
        let Some(job) = self.active.lock().expect("active").get(id).cloned() else {
            return false;
        };
        job.user_cancelled.set(true);
        job.stop.set(true);
        true
    }

    pub fn pause(&self, id: &str, paused: bool) -> bool {
        match self.active.lock().expect("active").get(id) {
            Some(job) => {
                job.paused.set(paused);
                true
            }
            None => false,
        }
    }

    pub fn cancel_all(&self) {
        for job in self.active.lock().expect("active").values() {
            job.user_cancelled.set(true);
            job.stop.set(true);
        }
    }

    pub fn acknowledge(&self, id: &str) -> bool {
        let mut records = self.records.lock().expect("records");
        match records.get(id) {
            Some(record) if *record.status.lock().expect("status") != Status::Running => {
                records.remove(id);
                true
            }
            _ => false,
        }
    }

    pub fn pending(&self) -> Vec<Value> {
        self.records
            .lock()
            .expect("records")
            .values()
            .map(|record| {
                let uploaded = record.uploaded();
                let progress = if record.total > 0 {
                    uploaded as f64 / record.total as f64
                } else {
                    1.0
                };
                Value::object([
                    ("uploadId", Value::String(record.id.clone())),
                    (
                        "status",
                        Value::String(record.status.lock().expect("status").name().into()),
                    ),
                    ("progress", Value::Number(progress)),
                    ("bytesUploaded", Value::Number(uploaded as f64)),
                    ("totalBytes", Value::Number(record.total as f64)),
                    ("etags", record.etag_values()),
                    (
                        "error",
                        record
                            .error
                            .lock()
                            .expect("error")
                            .clone()
                            .map_or(Value::Null, Value::String),
                    ),
                ])
            })
            .collect()
    }
}

fn fail(record: &Record, emitter: &Emitter, message: &str) {
    *record.status.lock().expect("status") = Status::Failed;
    *record.error.lock().expect("error") = Some(message.to_string());
    emitter.multipart_finished(record, Some(message));
}

fn execute(record: &Arc<Record>, job: &Arc<Job>, emitter: &Emitter) -> Result<(), Failure> {
    let next = AtomicUsize::new(0);
    let first_error: Mutex<Option<Failure>> = Mutex::new(None);
    let bytes = AtomicU64::new(record.uploaded());
    let workers = record.max_parallel.min(record.parts.len());

    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                if job.stop.is_set() {
                    return;
                }
                let index = next.fetch_add(1, Ordering::SeqCst);
                if index >= record.parts.len() {
                    return;
                }
                if !record.etags.lock().expect("etags")[index].is_empty() {
                    continue;
                }
                match upload_part(record, job, index) {
                    Ok(etag) => {
                        record.etags.lock().expect("etags")[index] = etag.clone();
                        bytes.fetch_add(record.size_of(index), Ordering::SeqCst);
                        emitter.multipart_progress(record, index as i64, Some(&etag));
                    }
                    Err(failure) => {
                        first_error.lock().expect("error").get_or_insert(failure);
                        job.stop.set(true);
                        return;
                    }
                }
            });
        }
    });

    if let Some(failure) = first_error.into_inner().expect("error") {
        return Err(failure);
    }
    if job.stop.is_set() {
        return Err(Failure::Cancelled);
    }
    let done = record
        .etags
        .lock()
        .expect("etags")
        .iter()
        .filter(|e| !e.is_empty())
        .count();
    if done < record.parts.len() {
        return Err(Failure::Failed(format!(
            "Upload incomplete: completed {done} of {} chunks",
            record.parts.len()
        )));
    }
    Ok(())
}

fn upload_part(record: &Record, job: &Job, index: usize) -> Result<String, Failure> {
    let mut last_error = String::new();
    for attempt in 0..MAX_RETRIES {
        while job.paused.is_set() && !job.stop.is_set() {
            std::thread::sleep(PAUSE_POLL);
        }
        if job.stop.is_set() {
            return Err(Failure::Cancelled);
        }
        if !record.path.is_file() {
            return Err(Failure::Failed("Upload cancelled: file deleted".into()));
        }
        let size = record.size_of(index);
        let region = FileRegion::open(&record.path, index as u64 * record.chunk, size)
            .map_err(|e| Failure::Failed(e.to_string()))?;
        let body = Tracked::new(region, job.stop.clone(), Box::new(|_| {}));
        let request = Request {
            method: "PUT".into(),
            url: record.parts[index].clone(),
            headers: vec![("Content-Type".into(), "application/octet-stream".into())],
            length: size,
        };
        match http::send(request, body, &job.stop) {
            Ok(response) if (200..300).contains(&response.status) => {
                return match response.etag.filter(|etag| !etag.is_empty()) {
                    Some(etag) => Ok(etag),
                    None => Err(Failure::Failed(format!(
                        "No ETag in response for part {}",
                        index + 1
                    ))),
                };
            }
            Ok(response) => {
                let retryable =
                    response.status >= 500 || response.status == 408 || response.status == 429;
                last_error = format!("HTTP {}: {}", response.status, response.body);
                if !retryable {
                    return Err(Failure::Failed(last_error));
                }
            }
            Err(HttpError::Cancelled) => return Err(Failure::Cancelled),
            Err(HttpError::Network(message)) => last_error = message,
        }
        if attempt + 1 < MAX_RETRIES {
            std::thread::sleep(Duration::from_secs(u64::from(attempt) + 1));
        }
    }
    Err(Failure::Failed(if last_error.is_empty() {
        format!("Part {} failed after {MAX_RETRIES} retries", index + 1)
    } else {
        last_error
    }))
}
