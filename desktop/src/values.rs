use std::path::PathBuf;

use rn_gpui_module::Value;

pub fn field<'a>(options: &'a Value, name: &str) -> Option<&'a Value> {
    match options {
        Value::Object(fields) => fields
            .iter()
            .find_map(|(key, value)| (key == name).then_some(value)),
        _ => None,
    }
}

pub fn string(options: &Value, name: &str) -> Option<String> {
    match field(options, name) {
        Some(Value::String(text)) => Some(text.clone()),
        _ => None,
    }
}

pub fn number(options: &Value, name: &str) -> Option<f64> {
    match field(options, name) {
        Some(Value::Number(number)) => Some(*number),
        _ => None,
    }
}

pub fn strings(options: &Value, name: &str) -> Option<Vec<String>> {
    match field(options, name) {
        Some(Value::Array(items)) => Some(
            items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    _ => String::new(),
                })
                .collect(),
        ),
        _ => None,
    }
}

/// A map of string values; a value of another type is an error naming the key.
pub fn string_map(
    options: &Value,
    name: &str,
    label: &str,
) -> Result<Vec<(String, String)>, String> {
    match field(options, name) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Object(entries)) => entries
            .iter()
            .map(|(key, value)| match value {
                Value::String(text) => Ok((key.clone(), text.clone())),
                _ => Err(format!(
                    "{label} must be string key/values. Value was invalid for '{key}'"
                )),
            })
            .collect(),
        Some(_) => Err(format!("{name} must be a hash.")),
    }
}

pub fn path_from(raw: &str) -> PathBuf {
    PathBuf::from(raw.strip_prefix("file://").unwrap_or(raw))
}
