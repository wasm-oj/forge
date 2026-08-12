use crate::{
    GoCompilerSession as CoreGoCompilerSession, GoCompilerSessionConfig, GoCompilerSessionRequest,
    InteractiveRequest, RunRequest, interactive_response, run_response,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn run_wasm_oj(request: JsValue) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let request: RunRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("invalid run request: {error}")))?;
    let response = run_response(request);
    response
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| JsValue::from_str(&format!("failed to serialize run response: {error}")))
}

/// Process-local browser Go compiler session. Construction transfers and
/// hydrates the immutable package/stdlib exactly once; later calls carry only
/// monotonic source deltas and pipeline requests.
#[wasm_bindgen(js_name = GoCompilerSession)]
pub struct WebGoCompilerSession {
    inner: CoreGoCompilerSession,
}

#[wasm_bindgen(js_class = GoCompilerSession)]
impl WebGoCompilerSession {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WebGoCompilerSession, JsValue> {
        console_error_panic_hook::set_once();
        let config: GoCompilerSessionConfig = serde_wasm_bindgen::from_value(config)
            .map_err(|error| JsValue::from_str(&format!("invalid Go compiler session: {error}")))?;
        let inner = CoreGoCompilerSession::new(config)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(Self { inner })
    }

    #[wasm_bindgen(getter)]
    pub fn digest(&self) -> String {
        self.inner.digest().to_string()
    }

    #[wasm_bindgen(getter)]
    pub fn generation(&self) -> Result<u32, JsValue> {
        self.inner
            .generation()
            .map_err(|error| JsValue::from_str(&error.to_string()))
    }

    #[wasm_bindgen(js_name = compilePipeline)]
    pub async fn compile_pipeline(&self, request: JsValue) -> Result<JsValue, JsValue> {
        let request: GoCompilerSessionRequest = serde_wasm_bindgen::from_value(request)
            .map_err(|error| JsValue::from_str(&format!("invalid Go compiler request: {error}")))?;
        let response = self
            .inner
            .compile_pipeline_response(request)
            .await
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        response
            .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
            .map_err(|error| {
                JsValue::from_str(&format!(
                    "failed to serialize Go compiler response: {error}"
                ))
            })
    }
}

#[wasm_bindgen]
pub async fn interact_wasm_oj(request: JsValue) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let request: InteractiveRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("invalid interactive request: {error}")))?;
    let response = interactive_response(request).await;
    response
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| {
            JsValue::from_str(&format!(
                "failed to serialize interactive response: {error}"
            ))
        })
}
