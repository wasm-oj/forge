#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>

#include "quickjs-libc.h"
#include "quickjs.h"

static JSValue write_stream(JSContext *context, FILE *stream, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;
    size_t length = 0;
    const char *string = NULL;
    const uint8_t *bytes;
    if (JS_IsArrayBuffer(argv[0])) {
        bytes = JS_GetArrayBuffer(context, &length, argv[0]);
        if (bytes == NULL && JS_HasException(context)) return JS_EXCEPTION;
    } else {
        string = JS_ToCStringLen(context, &length, argv[0]);
        if (string == NULL) return JS_EXCEPTION;
        bytes = (const uint8_t *)string;
    }
    size_t written = fwrite(bytes, 1, length, stream);
    int flush_result = fflush(stream);
    if (string != NULL) JS_FreeCString(context, string);
    if (written != length || flush_result != 0) {
        return JS_ThrowInternalError(context, "Unable to write standard output/error");
    }
    return JS_UNDEFINED;
}

static JSValue write_stdout(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv) {
    (void)this_value;
    return write_stream(context, stdout, argc, argv);
}

static JSValue write_stderr(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv) {
    (void)this_value;
    return write_stream(context, stderr, argc, argv);
}

static JSValue call_module_hook(JSContext *context, const char *hook, int argc, JSValueConst *argv) {
    JSValue global = JS_GetGlobalObject(context);
    JSValue function = JS_GetPropertyStr(context, global, hook);
    JSValue result = JS_Call(context, function, global, argc, argv);
    JS_FreeValue(context, function);
    JS_FreeValue(context, global);
    return result;
}

static char *normalize_module(JSContext *context, const char *base, const char *name, void *opaque) {
    (void)opaque;
    JSValue args[] = { JS_NewString(context, name), JS_NewString(context, base) };
    JSValue result = call_module_hook(context, "__wasm_oj_resolve", 2, args);
    JS_FreeValue(context, args[0]);
    JS_FreeValue(context, args[1]);
    if (JS_IsException(result)) return NULL;
    const char *resolved = JS_ToCString(context, result);
    char *copy = resolved == NULL ? NULL : js_strdup(context, resolved);
    JS_FreeCString(context, resolved);
    JS_FreeValue(context, result);
    return copy;
}

static JSValue evaluate_module(JSContext *context, JSValueConst name, int flags) {
    JSValue source = call_module_hook(context, "__wasm_oj_module_source", 1, &name);
    if (JS_IsException(source)) return JS_EXCEPTION;
    size_t length = 0;
    const char *text = JS_ToCStringLen(context, &length, source);
    const char *filename = JS_ToCString(context, name);
    JSValue result = text == NULL || filename == NULL ? JS_EXCEPTION : JS_Eval(context, text, length, filename, JS_EVAL_TYPE_MODULE | flags);
    JS_FreeCString(context, text);
    JS_FreeCString(context, filename);
    JS_FreeValue(context, source);
    return result;
}

static JSModuleDef *load_module(JSContext *context, const char *name, void *opaque) {
    (void)opaque;
    JSValue filename = JS_NewString(context, name);
    JSValue module = evaluate_module(context, filename, JS_EVAL_FLAG_COMPILE_ONLY);
    JS_FreeValue(context, filename);
    if (JS_IsException(module)) return NULL;
    JSModuleDef *result = JS_VALUE_GET_PTR(module);
    JS_FreeValue(context, module);
    return result;
}

static JSValue eval_module(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv) {
    (void)this_value;
    if (argc != 1) return JS_ThrowTypeError(context, "Expected an entry module name");
    return evaluate_module(context, argv[0], 0);
}

static unsigned long long deterministic_env_u64(const char *name) {
    const char *value = getenv(name);
    if (value == NULL || *value == '\0') return 0;
    char *end = NULL;
    unsigned long long parsed = strtoull(value, &end, 10);
    return end != NULL && *end == '\0' ? parsed : 0;
}

static JSValue deterministic_seed(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv) {
    (void)this_value;
    (void)argc;
    (void)argv;
    return JS_NewUint32(context, (uint32_t)deterministic_env_u64("WASM_OJ_RANDOM_SEED"));
}

static JSValue deterministic_epoch_ms(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv) {
    (void)this_value;
    (void)argc;
    (void)argv;
    return JS_NewInt64(context, (int64_t)deterministic_env_u64("WASM_OJ_REALTIME_EPOCH_MS"));
}

static JSValue deterministic_step_ns(JSContext *context, JSValueConst this_value, int argc, JSValueConst *argv) {
    (void)this_value;
    (void)argc;
    (void)argv;
    return JS_NewUint32(context, (uint32_t)deterministic_env_u64("WASM_OJ_CLOCK_STEP_NS"));
}

static char *read_stdin(size_t *length) {
    size_t capacity = 64 * 1024;
    size_t size = 0;
    char *buffer = malloc(capacity + 1);
    if (buffer == NULL) return NULL;

    for (;;) {
        if (size == capacity) {
            capacity *= 2;
            char *grown = realloc(buffer, capacity + 1);
            if (grown == NULL) {
                free(buffer);
                return NULL;
            }
            buffer = grown;
        }
        size_t count = fread(buffer + size, 1, capacity - size, stdin);
        size += count;
        if (count == 0) break;
    }
    if (ferror(stdin)) {
        free(buffer);
        return NULL;
    }
    buffer[size] = '\0';
    *length = size;
    return buffer;
}

int main(int argc, char **argv) {
    size_t source_length = 0;
    char *source = read_stdin(&source_length);
    if (source == NULL) {
        fputs("Unable to read the JavaScript bundle from stdin.\n", stderr);
        return 1;
    }

    JSRuntime *runtime = JS_NewRuntime();
    if (runtime == NULL) {
        free(source);
        fputs("Unable to initialize QuickJS.\n", stderr);
        return 1;
    }
    js_std_init_handlers(runtime);
    JS_SetHostPromiseRejectionTracker(runtime, js_std_promise_rejection_tracker, NULL);
    JS_SetModuleLoaderFunc(runtime, normalize_module, load_module, NULL);
    JSContext *context = JS_NewContext(runtime);
    if (context == NULL) {
        js_std_free_handlers(runtime);
        JS_FreeRuntime(runtime);
        free(source);
        fputs("Unable to initialize the QuickJS context.\n", stderr);
        return 1;
    }
    js_std_add_helpers(context, argc, argv);
    JSValue global = JS_GetGlobalObject(context);
    JS_SetPropertyStr(context, global, "__wasm_oj_eval_module", JS_NewCFunction(context, eval_module, "__wasm_oj_eval_module", 1));
    JS_SetPropertyStr(context, global, "__wasm_oj_write_stdout", JS_NewCFunction(context, write_stdout, "__wasm_oj_write_stdout", 1));
    JS_SetPropertyStr(context, global, "__wasm_oj_write_stderr", JS_NewCFunction(context, write_stderr, "__wasm_oj_write_stderr", 1));
    JS_SetPropertyStr(context, global, "__wasm_oj_determinism_seed", JS_NewCFunction(context, deterministic_seed, "__wasm_oj_determinism_seed", 0));
    JS_SetPropertyStr(context, global, "__wasm_oj_determinism_epoch_ms", JS_NewCFunction(context, deterministic_epoch_ms, "__wasm_oj_determinism_epoch_ms", 0));
    JS_SetPropertyStr(context, global, "__wasm_oj_determinism_step_ns", JS_NewCFunction(context, deterministic_step_ns, "__wasm_oj_determinism_step_ns", 0));
    JS_FreeValue(context, global);

    JSValue result = JS_Eval(context, source, source_length, "/project/bundle.js", JS_EVAL_TYPE_GLOBAL);
    free(source);
    if (JS_IsException(result)) {
        js_std_dump_error(context);
        JS_FreeValue(context, result);
        js_std_free_handlers(runtime);
        JS_FreeContext(context);
        JS_FreeRuntime(runtime);
        return 1;
    }
    int exit_code = js_std_loop(context);
    if (exit_code != 0) js_std_dump_error(context);
    if (exit_code == 0 && JS_PromiseState(context, result) == JS_PROMISE_PENDING) {
        fputs("Unsettled top-level await\n", stderr);
        exit_code = 13;
    }
    JS_FreeValue(context, result);
    js_std_free_handlers(runtime);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return exit_code;
}
