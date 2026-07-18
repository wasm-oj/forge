use crate::{
    CompilePipelineRequest, InteractiveRequest, RunRequest, compile_pipeline_response,
    interactive_response, run_response,
};
use serde::Serialize;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn run_forge(request: JsValue) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let request: RunRequest = serde_wasm_bindgen::from_value(request)
        .map_err(|error| JsValue::from_str(&format!("invalid run request: {error}")))?;
    let response = run_response(request);
    response
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| JsValue::from_str(&format!("failed to serialize run response: {error}")))
}

#[wasm_bindgen]
pub async fn compile_pipeline_forge(request: JsValue) -> Result<JsValue, JsValue> {
    console_error_panic_hook::set_once();
    let request: CompilePipelineRequest =
        serde_wasm_bindgen::from_value(request).map_err(|error| {
            JsValue::from_str(&format!("invalid compile pipeline request: {error}"))
        })?;
    let response = compile_pipeline_response(request).await;
    response
        .serialize(&serde_wasm_bindgen::Serializer::new().serialize_maps_as_objects(true))
        .map_err(|error| {
            JsValue::from_str(&format!(
                "failed to serialize compile pipeline response: {error}"
            ))
        })
}

#[wasm_bindgen]
pub async fn interact_forge(request: JsValue) -> Result<JsValue, JsValue> {
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
