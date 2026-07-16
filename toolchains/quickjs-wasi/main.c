#include <stdio.h>
#include <stdlib.h>

#include "quickjs-libc.h"
#include "quickjs.h"

static JSValue write_stream(JSContext *context, FILE *stream, int argc, JSValueConst *argv) {
    if (argc < 1) return JS_UNDEFINED;
    const char *value = JS_ToCString(context, argv[0]);
    if (value == NULL) return JS_EXCEPTION;
    fputs(value, stream);
    fflush(stream);
    JS_FreeCString(context, value);
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
    JS_SetPropertyStr(context, global, "__localwasi_write_stdout", JS_NewCFunction(context, write_stdout, "__localwasi_write_stdout", 1));
    JS_SetPropertyStr(context, global, "__localwasi_write_stderr", JS_NewCFunction(context, write_stderr, "__localwasi_write_stderr", 1));
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
    JS_FreeValue(context, result);
    js_std_loop(context);
    js_std_free_handlers(runtime);
    JS_FreeContext(context);
    JS_FreeRuntime(runtime);
    return 0;
}
