use std::io::{Cursor, Read};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use rn_gpui_module::{ModuleError, Value};

use crate::http::{self, FileRegion, Flag, HttpError, Request, Tracked};
use crate::values;
use crate::Emitter;

const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Default)]
pub struct Upload {
    pub stop: Arc<Flag>,
}

pub struct Options {
    id: String,
    url: String,
    path: std::path::PathBuf,
    method: String,
    multipart_field: Option<String>,
    parameters: Vec<(String, String)>,
    headers: Vec<(String, String)>,
    max_retries: u32,
}

pub type Uploads = Mutex<std::collections::HashMap<String, Arc<Upload>>>;

fn invalid(message: impl ToString) -> ModuleError {
    ModuleError::with_code("INVALID_ARGUMENT", message.to_string())
}

pub fn parse(options: &Value, id: String) -> Result<Options, ModuleError> {
    let url = values::string(options, "url").ok_or_else(|| invalid("Missing 'url' field."))?;
    let path = values::string(options, "path").ok_or_else(|| invalid("Missing 'path' field."))?;
    let kind = values::string(options, "type").unwrap_or_else(|| "raw".into());
    if kind != "raw" && kind != "multipart" {
        return Err(invalid("type should be string: raw or multipart."));
    }
    let multipart_field = if kind == "multipart" {
        Some(
            values::string(options, "field")
                .ok_or_else(|| invalid("field is required field for multipart type."))?,
        )
    } else {
        None
    };
    let parameters = values::string_map(options, "parameters", "Parameters").map_err(invalid)?;
    if kind == "raw" && !parameters.is_empty() {
        return Err(invalid("Parameters supported only in multipart type"));
    }
    let headers = values::string_map(options, "headers", "Headers").map_err(invalid)?;
    Ok(Options {
        id,
        url,
        path: values::path_from(&path),
        method: values::string(options, "method")
            .unwrap_or_else(|| "POST".into())
            .to_uppercase(),
        multipart_field,
        parameters,
        headers,
        max_retries: values::number(options, "maxRetries").map_or(2, |n| n.max(0.0) as u32),
    })
}

fn boundary() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    format!("----RNFileUploader{nanos:x}")
}

fn has_header(headers: &[(String, String)], name: &str) -> bool {
    headers
        .iter()
        .any(|(key, _)| key.eq_ignore_ascii_case(name))
}

struct Prepared {
    request: Request,
    head: Vec<u8>,
    tail: Vec<u8>,
    file_size: u64,
}

fn prepare(options: &Options) -> Result<Prepared, String> {
    let metadata =
        std::fs::metadata(&options.path).map_err(|e| format!("{}: {e}", options.path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file", options.path.display()));
    }
    let file_size = metadata.len();
    let mut headers = options.headers.clone();
    let (head, tail) = match &options.multipart_field {
        None => {
            if !has_header(&headers, "content-type") {
                headers.push(("Content-Type".into(), "application/octet-stream".into()));
            }
            (Vec::new(), Vec::new())
        }
        Some(field) => {
            let boundary = boundary();
            let name = options
                .path
                .file_name()
                .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
            let mime = mime_guess::from_path(&options.path).first_or_octet_stream();
            let mut head = String::new();
            for (key, value) in &options.parameters {
                head.push_str(&format!(
                    "--{boundary}\r\nContent-Disposition: form-data; name=\"{key}\"\r\n\r\n{value}\r\n"
                ));
            }
            head.push_str(&format!(
                "--{boundary}\r\nContent-Disposition: form-data; name=\"{field}\"; filename=\"{name}\"\r\nContent-Type: {mime}\r\n\r\n"
            ));
            headers.retain(|(key, _)| !key.eq_ignore_ascii_case("content-type"));
            headers.push((
                "Content-Type".into(),
                format!("multipart/form-data; boundary={boundary}"),
            ));
            (
                head.into_bytes(),
                format!("\r\n--{boundary}--\r\n").into_bytes(),
            )
        }
    };
    let length = head.len() as u64 + file_size + tail.len() as u64;
    Ok(Prepared {
        request: Request {
            method: options.method.clone(),
            url: options.url.clone(),
            headers,
            length,
        },
        head,
        tail,
        file_size,
    })
}

enum Outcome {
    Done(http::Response),
    Cancelled,
    Failed(String),
    Unreadable(String),
}

fn attempt(options: &Options, upload: &Upload, emitter: &Emitter) -> Outcome {
    let prepared = match prepare(options) {
        Ok(prepared) => prepared,
        Err(message) => return Outcome::Unreadable(message),
    };
    let total = prepared.request.length;
    let file = match FileRegion::open(&options.path, 0, prepared.file_size) {
        Ok(file) => file,
        Err(e) => return Outcome::Unreadable(e.to_string()),
    };
    let body = Cursor::new(prepared.head)
        .chain(file)
        .chain(Cursor::new(prepared.tail));
    let report: Box<dyn FnMut(u64) + Send> = {
        let emitter = emitter.clone();
        let id = options.id.clone();
        let mut last = Instant::now() - PROGRESS_INTERVAL;
        Box::new(move |sent| {
            if last.elapsed() >= PROGRESS_INTERVAL {
                last = Instant::now();
                emitter.progress(&id, sent, total);
            }
        })
    };
    let body = Tracked::new(body, upload.stop.clone(), report);
    match http::send(prepared.request, body, &upload.stop) {
        Ok(response) => {
            emitter.progress(&options.id, total, total);
            Outcome::Done(response)
        }
        Err(HttpError::Cancelled) => Outcome::Cancelled,
        Err(HttpError::Network(message)) => Outcome::Failed(message),
    }
}

pub fn run(options: Options, upload: Arc<Upload>, emitter: Emitter, uploads: Arc<Uploads>) {
    let mut attempts = 0;
    let outcome = loop {
        let outcome = attempt(&options, &upload, &emitter);
        match outcome {
            Outcome::Failed(_) if attempts < options.max_retries && !upload.stop.is_set() => {
                attempts += 1;
                std::thread::sleep(Duration::from_secs(u64::from(attempts)));
            }
            other => break other,
        }
    };
    uploads.lock().expect("uploads").remove(&options.id);
    match outcome {
        Outcome::Done(response) if (200..300).contains(&response.status) => {
            emitter.completed(&options.id, &response);
        }
        Outcome::Done(response) => {
            emitter.error(
                &options.id,
                &format!("Server responded with HTTP code {}", response.status),
                Some(&response),
            );
        }
        Outcome::Cancelled => emitter.cancelled(&options.id, "User cancelled upload"),
        Outcome::Failed(message) | Outcome::Unreadable(message) => {
            emitter.error(&options.id, &message, None);
        }
    }
}
