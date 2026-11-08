rn_gpui_module::include_specs!();

mod http;
mod multipart;
mod simple;
mod values;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use rn_gpui_module::{ModuleError, Value};

const PREFIX: &str = "RNFileUploader-";

#[derive(Clone)]
pub struct Emitter(NativeRNFileUploaderEvents);

impl Emitter {
    fn send(&self, name: &str, body: Value) {
        self.0.send_event(&format!("{PREFIX}{name}"), body);
    }

    pub fn progress(&self, id: &str, sent: u64, total: u64) {
        let percent = (sent * 100).checked_div(total).map_or(-1.0, |p| p as f64);
        self.send(
            "progress",
            Value::object([
                ("id", Value::String(id.into())),
                ("progress", Value::Number(percent)),
                ("totalBytes", Value::Number(total as f64)),
                ("uploadedBytes", Value::Number(sent as f64)),
            ]),
        );
    }

    pub fn completed(&self, id: &str, response: &http::Response) {
        self.send(
            "completed",
            Value::object([
                ("id", Value::String(id.into())),
                ("responseCode", Value::Number(f64::from(response.status))),
                ("responseBody", Value::String(response.body.clone())),
            ]),
        );
    }

    pub fn error(&self, id: &str, message: &str, response: Option<&http::Response>) {
        let mut fields = vec![
            ("id", Value::String(id.into())),
            ("error", Value::String(message.into())),
        ];
        if let Some(response) = response {
            fields.push(("responseCode", Value::Number(f64::from(response.status))));
            fields.push(("responseBody", Value::String(response.body.clone())));
        }
        self.send("error", Value::object(fields));
    }

    pub fn cancelled(&self, id: &str, message: &str) {
        self.send(
            "cancelled",
            Value::object([
                ("id", Value::String(id.into())),
                ("error", Value::String(message.into())),
            ]),
        );
    }
}

pub struct Uploader {
    emitter: Emitter,
    uploads: Arc<simple::Uploads>,
    multipart: Arc<multipart::Engine>,
    counter: AtomicU64,
}

fn failure(message: impl ToString) -> ModuleError {
    ModuleError::new(message.to_string())
}

impl NativeRNFileUploaderSpec for Uploader {
    fn new(events: NativeRNFileUploaderEvents) -> Self {
        Self {
            emitter: Emitter(events),
            uploads: Arc::new(Mutex::new(HashMap::new())),
            multipart: Arc::new(multipart::Engine::default()),
            counter: AtomicU64::new(0),
        }
    }

    fn should_limit_network(&self, _limit: bool) {}

    fn can_suspend_if_background(&self) {}

    async fn get_file_info(&self, path: String) -> Result<Value, ModuleError> {
        let path = values::path_from(&path);
        let name = path
            .file_name()
            .map_or_else(String::new, |n| n.to_string_lossy().into_owned());
        let mut fields = vec![("name", Value::String(name))];
        match std::fs::metadata(&path) {
            Ok(metadata) if metadata.is_file() => {
                let extension = path
                    .extension()
                    .map_or_else(String::new, |e| e.to_string_lossy().into_owned());
                let mime = mime_guess::from_path(&path)
                    .first()
                    .map(|m| m.essence_str().to_string());
                fields.push(("exists", Value::Bool(true)));
                fields.push(("size", Value::String(metadata.len().to_string())));
                fields.push(("extension", Value::String(extension)));
                fields.push(("mimeType", mime.map_or(Value::Null, Value::String)));
            }
            _ => fields.push(("exists", Value::Bool(false))),
        }
        Ok(Value::object(fields))
    }

    async fn start_upload(&self, options: Value) -> Result<String, ModuleError> {
        let id = values::string(&options, "customUploadId").unwrap_or_else(|| {
            let nanos = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_nanos());
            format!(
                "upload-{nanos:x}-{}",
                self.counter.fetch_add(1, Ordering::Relaxed)
            )
        });
        let parsed = simple::parse(&options, id.clone())?;
        let upload = Arc::new(simple::Upload::default());
        {
            let mut uploads = self.uploads.lock().expect("uploads");
            if uploads.contains_key(&id) {
                return Err(failure(format!("Upload {id} is already running")));
            }
            uploads.insert(id.clone(), upload.clone());
        }
        let emitter = self.emitter.clone();
        let uploads = self.uploads.clone();
        std::thread::spawn(move || simple::run(parsed, upload, emitter, uploads));
        Ok(id)
    }

    async fn cancel_upload(&self, upload_id: String) -> Result<bool, ModuleError> {
        if let Some(upload) = self.uploads.lock().expect("uploads").get(&upload_id) {
            upload.stop.set(true);
        }
        Ok(true)
    }

    async fn stop_all_uploads(&self) -> Result<bool, ModuleError> {
        for upload in self.uploads.lock().expect("uploads").values() {
            upload.stop.set(true);
        }
        self.multipart.cancel_all();
        Ok(true)
    }

    async fn get_all_uploads(&self) -> Result<Vec<Value>, ModuleError> {
        Ok(self
            .uploads
            .lock()
            .expect("uploads")
            .keys()
            .map(|id| {
                Value::object([
                    ("id", Value::String(id.clone())),
                    ("state", Value::String("running".into())),
                ])
            })
            .collect())
    }

    async fn start_multipart_upload(&self, options: Value) -> Result<Value, ModuleError> {
        let receiver = self.multipart.start(&options, self.emitter.clone())?;
        receiver
            .await
            .map_err(|_| failure("the upload stopped unexpectedly"))?
    }

    async fn cancel_multipart_upload(&self, upload_id: String) -> Result<bool, ModuleError> {
        Ok(self.multipart.cancel(&upload_id))
    }

    async fn pause_multipart_upload(&self, upload_id: String) -> Result<bool, ModuleError> {
        Ok(self.multipart.pause(&upload_id, true))
    }

    async fn resume_multipart_upload(&self, upload_id: String) -> Result<bool, ModuleError> {
        Ok(self.multipart.pause(&upload_id, false))
    }

    async fn get_multipart_uploads(&self) -> Result<Vec<Value>, ModuleError> {
        Ok(self.multipart.pending())
    }

    async fn acknowledge_multipart_upload(&self, upload_id: String) -> Result<bool, ModuleError> {
        Ok(self.multipart.acknowledge(&upload_id))
    }

    fn add_listener(&self, _event_name: String) {}

    fn remove_listeners(&self, _count: i32) {}
}

impl Emitter {
    pub fn multipart_progress(
        &self,
        record: &multipart::Record,
        chunk_index: i64,
        etag: Option<&str>,
    ) {
        let uploaded = record.uploaded();
        let mut fields = vec![
            ("uploadId", Value::String(record.id().into())),
            (
                "progress",
                Value::Number(if record.total() > 0 {
                    uploaded as f64 / record.total() as f64
                } else {
                    1.0
                }),
            ),
            ("bytesUploaded", Value::Number(uploaded as f64)),
            ("totalBytes", Value::Number(record.total() as f64)),
            ("chunkIndex", Value::Number(chunk_index as f64)),
            ("etags", record.etag_values()),
        ];
        if let Some(etag) = etag {
            fields.push(("etag", Value::String(etag.into())));
        }
        self.send("multipart-progress", Value::object(fields));
    }

    pub fn multipart_finished(&self, record: &multipart::Record, error: Option<&str>) {
        let mut fields = vec![
            ("uploadId", Value::String(record.id().into())),
            ("etags", record.etag_values()),
        ];
        match error {
            None => {
                fields.push(("success", Value::Bool(true)));
                self.send("multipart-completed", Value::object(fields));
            }
            Some(message) => {
                fields.push(("error", Value::String(message.into())));
                self.send("multipart-error", Value::object(fields));
            }
        }
    }

    pub fn multipart_cancelled(&self, id: &str) {
        self.send(
            "multipart-cancelled",
            Value::object([
                ("uploadId", Value::String(id.into())),
                ("error", Value::String("Upload cancelled".into())),
            ]),
        );
    }
}

pub fn rn_gpui_register() {
    rn_gpui_module::register(native_rn_file_uploader_module::<Uploader>());
}
