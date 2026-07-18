use std::collections::BTreeMap;
use wasm_oj_forge_runtime_core::{DeterminismConfig, ResourcePolicy, RunError, RunRequest, run};

fn request(wat_source: &str) -> RunRequest {
    RunRequest {
        wasm: wat::parse_str(wat_source).unwrap(),
        args: Vec::new(),
        env: BTreeMap::new(),
        stdin: Vec::new(),
        files: BTreeMap::new(),
        output_paths: Vec::new(),
        cwd: None,
        startup_entropy_bytes: 0,
        determinism: DeterminismConfig {
            random_seed: 7,
            realtime_epoch_ms: 946_684_800_000,
            clock_step_ns: 1_000_000,
        },
        resources: ResourcePolicy {
            instruction_budget: 1_000_000,
            logical_time_limit_ms: 60_000,
            memory_limit_bytes: 2 * 65_536,
            output_limit_bytes: 1_024,
            filesystem_write_limit_bytes: 64 * 1024 * 1024,
            filesystem_entry_limit: 4_096,
        },
    }
}

#[test]
fn runs_a_metered_wasi_module() {
    let result = run(request("(module (import \"wasi_snapshot_preview1\" \"proc_exit\" (func $exit (param i32))) (memory (export \"memory\") 1) (func (export \"_start\") i32.const 1 drop))")).unwrap();
    assert_eq!(result.code, 0);
    assert!(result.metrics.cost > 0);
    assert_eq!(result.metrics.memory_bytes, 65_536);
    assert_eq!(result.metrics.cost_model, "weighted");
}

#[test]
fn supplies_an_imported_guest_memory() {
    let result = run(request(
        r#"(module
      (import "env" "memory" (memory 1 2))
      (export "memory" (memory 0))
      (func (export "_start") i32.const 1 drop))"#,
    ))
    .unwrap();
    assert_eq!(result.code, 0);
    assert_eq!(result.metrics.memory_bytes, 65_536);
}

#[test]
fn rejects_an_unrecognized_imported_memory() {
    let result = run(request(
        r#"(module
          (import "env" "other_memory" (memory 1 2))
          (export "memory" (memory 0))
          (func (export "_start")))"#,
    ));
    assert!(
        matches!(result, Err(RunError::Compile(message)) if message.contains("admits only env.memory"))
    );
}

#[test]
fn meters_the_webassembly_start_section() {
    let result = run(request(
        r#"(module
          (memory (export "memory") 1)
          (func $initialize i32.const 1 drop)
          (start $initialize)
          (func (export "_start")))"#,
    ))
    .unwrap();
    assert_eq!(result.code, 0);
    assert!(result.metrics.cost > 0);
}

#[test]
fn defers_start_until_wasi_handles_and_deterministic_memory_are_ready() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "\30\00\00\00\01\00\00\00")
      (data (i32.const 8) "\20\00\00\00\10\00\00\00\38\00\00\00\08\00\00\00\31\00\00\00\01\00\00\00")
      (data (i32.const 48) "SM")
      (func $initialize
        i32.const 32 i32.const 16 call $random drop
        i32.const 0 i64.const 0 i32.const 56 call $clock drop
        i32.const 1 i32.const 0 i32.const 1 i32.const 64 call $write drop)
      (start $initialize)
      (func (export "_start")
        i32.const 1 i32.const 8 i32.const 3 i32.const 64 call $write drop))"#;

    let first = run(request(source)).unwrap();
    let second = run(request(source)).unwrap();
    assert_eq!(first.code, 0);
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.stdout.len(), 26);
    assert_eq!(first.stdout[0], b'S');
    assert_eq!(first.stdout[25], b'M');
    assert!(first.stdout[1..17].iter().any(|byte| *byte != 0));

    let mut different_seed = request(source);
    different_seed.determinism.random_seed = 8;
    let different = run(different_seed).unwrap();
    assert_ne!(first.stdout[1..17], different.stdout[1..17]);
    assert_eq!(first.stdout[17..25], different.stdout[17..25]);
}

#[test]
fn traps_thread_network_and_process_capabilities_before_wasmer_can_execute_them() {
    for (capability, source) in [
        (
            "wasi.thread-spawn",
            r#"(module
              (import "wasi" "thread-spawn" (func $denied (param i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start") i32.const 0 call $denied drop))"#,
        ),
        (
            "wasi_snapshot_preview1.sock_send",
            r#"(module
              (import "wasi_snapshot_preview1" "sock_send" (func $denied (param i32 i32 i32 i32) (result i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                i32.const 0 i32.const 0 i32.const 0 i32.const 0 call $denied drop))"#,
        ),
        (
            "wasix_32v1.proc_exec",
            r#"(module
              (import "wasix_32v1" "proc_exec" (func $denied (param i32 i32 i32 i32)))
              (memory (export "memory") 1)
              (func (export "_start")
                i32.const 0 i32.const 0 i32.const 0 i32.const 0 call $denied))"#,
        ),
    ] {
        let result = run(request(source)).unwrap();
        assert_eq!(result.code, 1);
        assert_eq!(
            result.termination,
            wasm_oj_forge_runtime_core::ExecutionTermination::Trap
        );
        assert!(
            result
                .trap_message
                .as_deref()
                .is_some_and(|message| message.contains(capability)),
            "missing denial for {capability}: {:?}",
            result.trap_message
        );
    }
}

#[test]
fn exposes_a_single_deterministic_main_thread_without_enabling_spawn() {
    let result = run(request(
        r#"(module
          (import "wasix_32v1" "thread_id" (func $thread_id (param i32) (result i32)))
          (import "wasix_32v1" "thread_parallelism" (func $parallelism (param i32) (result i32)))
          (import "wasix_32v1" "thread_sleep" (func $sleep (param i64) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 0) "\20\00\00\00\08\00\00\00")
          (func (export "_start")
            i32.const 32 call $thread_id drop
            i32.const 36 call $parallelism drop
            i64.const 999999999 call $sleep drop
            i32.const 1 i32.const 0 i32.const 1 i32.const 40 call $write drop))"#,
    ))
    .unwrap();
    assert_eq!(result.code, 0);
    assert_eq!(result.stdout, [1, 0, 0, 0, 1, 0, 0, 0]);
    assert_eq!(result.metrics.logical_time_ns, 999_999_999);
}

#[test]
fn wasix_sleep_fast_forwards_the_shared_virtual_clock() {
    let result = run(request(
        r#"(module
          (import "wasix_32v1" "thread_sleep" (func $sleep (param i64) (result i32)))
          (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 16) "\00\00\00\00\08\00\00\00")
          (func (export "_start")
            i64.const 5000000000 call $sleep drop
            i32.const 1 i64.const 0 i32.const 0 call $clock drop
            i32.const 1 i32.const 16 i32.const 1 i32.const 24 call $write drop))"#,
    ))
    .unwrap();

    assert_eq!(result.code, 0);
    assert_eq!(result.stdout, 5_000_000_000_u64.to_le_bytes());
    assert_eq!(result.metrics.logical_time_ns, 5_001_000_000);
}

#[test]
fn wasi_clock_poll_fast_forwards_without_waiting_for_the_host() {
    let result = run(request(
        r#"(module
          (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
          (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 160) "\80\00\00\00\08\00\00\00")
          (func (export "_start")
            i32.const 0 i64.const 7 i64.store
            i32.const 8 i32.const 0 i32.store8
            i32.const 16 i32.const 1 i32.store
            i32.const 24 i64.const 5000000000 i64.store
            i32.const 32 i64.const 1 i64.store
            i32.const 40 i32.const 0 i32.store16
            i32.const 0 i32.const 64 i32.const 1 i32.const 120 call $poll drop
            i32.const 1 i64.const 0 i32.const 128 call $clock drop
            i32.const 1 i32.const 160 i32.const 1 i32.const 168 call $write drop))"#,
    ))
    .unwrap();

    assert_eq!(result.code, 0);
    assert_eq!(result.stdout, 5_000_000_000_u64.to_le_bytes());
    assert_eq!(result.metrics.logical_time_ns, 5_001_000_000);
}

#[test]
fn absolute_realtime_poll_uses_the_same_virtual_timeline() {
    let result = run(request(
        r#"(module
          (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
          (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 160) "\80\00\00\00\08\00\00\00")
          (func (export "_start")
            i32.const 0 i64.const 7 i64.store
            i32.const 8 i32.const 0 i32.store8
            i32.const 16 i32.const 0 i32.store
            i32.const 24 i64.const 946684805000000000 i64.store
            i32.const 32 i64.const 1 i64.store
            i32.const 40 i32.const 1 i32.store16
            i32.const 0 i32.const 64 i32.const 1 i32.const 120 call $poll drop
            i32.const 0 i64.const 0 i32.const 128 call $clock drop
            i32.const 1 i32.const 160 i32.const 1 i32.const 168 call $write drop))"#,
    ))
    .unwrap();

    assert_eq!(result.code, 0);
    assert_eq!(result.stdout, 946_684_805_000_000_000_u64.to_le_bytes());
    assert_eq!(result.metrics.logical_time_ns, 5_001_000_000);
}

#[test]
fn ready_fd_wins_over_a_clock_without_advancing_virtual_time() {
    let result = run(request(
        r#"(module
          (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (func (export "_start")
            i32.const 0 i64.const 1 i64.store
            i32.const 8 i32.const 2 i32.store8
            i32.const 16 i32.const 1 i32.store
            i32.const 48 i64.const 2 i64.store
            i32.const 56 i32.const 0 i32.store8
            i32.const 64 i32.const 1 i32.store
            i32.const 72 i64.const 5000000000 i64.store
            i32.const 80 i64.const 1 i64.store
            i32.const 88 i32.const 0 i32.store16
            i32.const 0 i32.const 128 i32.const 2 i32.const 240 call $poll drop))"#,
    ))
    .unwrap();

    assert_eq!(result.code, 0);
    assert_eq!(result.metrics.logical_time_ns, 0);
}

#[test]
fn sleep_beyond_the_logical_time_budget_has_its_own_termination() {
    let mut run_request = request(
        r#"(module
          (import "wasix_32v1" "thread_sleep" (func $sleep (param i64) (result i32)))
          (memory (export "memory") 1)
          (func (export "_start") i64.const 11000000 call $sleep drop))"#,
    );
    run_request.resources.logical_time_limit_ms = 10;
    let result = run(run_request).unwrap();

    assert_eq!(result.code, 137);
    assert_eq!(
        result.termination,
        wasm_oj_forge_runtime_core::ExecutionTermination::LogicalTimeLimit
    );
    assert_eq!(result.trap_message, None);
    assert_eq!(result.metrics.logical_time_ns, 10_000_000);
}

#[test]
fn terminates_an_infinite_loop_by_instruction_budget() {
    let mut request = request(
        "(module (import \"wasi_snapshot_preview1\" \"proc_exit\" (func $exit (param i32))) (memory (export \"memory\") 1) (func (export \"_start\") (loop br 0)))",
    );
    request.resources.instruction_budget = 20;
    let result = run(request).unwrap();
    assert_eq!(result.code, 137);
    assert_eq!(
        result.termination,
        wasm_oj_forge_runtime_core::ExecutionTermination::InstructionLimit
    );
    assert_eq!(result.metrics.cost, 20);
}

#[test]
fn rejects_memory_above_the_hard_limit_before_instantiation() {
    let request = request("(module (memory (export \"memory\") 3) (func (export \"_start\")))");
    assert!(
        matches!(run(request), Err(RunError::Compile(message)) if message.contains("requires 3"))
    );
}

#[test]
fn rejects_memory64_without_entering_the_native_engine() {
    let result = run(request(
        r#"(module
          (memory (export "memory") i64 1)
          (func (export "_start")))"#,
    ));
    assert!(
        matches!(result, Err(RunError::Compile(message)) if message.contains("memory64 modules are unsupported"))
    );
}

#[test]
fn enforces_a_combined_stdout_stderr_limit() {
    let mut request = request(
        r#"(module
      (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "\20\00\00\00\08\00\00\00")
      (data (i32.const 32) "12345678")
      (func (export "_start")
        i32.const 1 i32.const 0 i32.const 1 i32.const 16 call $fd_write drop))"#,
    );
    request.resources.output_limit_bytes = 4;
    let result = run(request).unwrap();
    assert_eq!(result.code, 137);
    assert_eq!(
        result.termination,
        wasm_oj_forge_runtime_core::ExecutionTermination::OutputLimit
    );
    assert_eq!(result.stdout, b"1234");
    assert_eq!(result.metrics.stdout_bytes, 4);
}

#[test]
fn time_and_random_are_replayable_and_seeded() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "\08\00\00\00\18\00\00\00")
      (func (export "_start")
        i32.const 0 i64.const 0 i32.const 8 call $clock drop
        i32.const 16 i32.const 16 call $random drop
        i32.const 1 i32.const 0 i32.const 1 i32.const 24 call $write drop))"#;
    let mut first_request = request(source);
    first_request.resources.output_limit_bytes = 1024 * 1024;
    let mut second_request = request(source);
    second_request.resources.output_limit_bytes = 1024 * 1024;
    let first = run(first_request).unwrap();
    let second = run(second_request).unwrap();
    assert_eq!(first.stdout.len(), 24);
    assert_eq!(first.stdout, second.stdout);
    assert_eq!(first.metrics.cost, second.metrics.cost);

    let mut different = request(source);
    different.determinism.random_seed = 8;
    assert_ne!(first.stdout, run(different).unwrap().stdout);
}

#[test]
fn startup_entropy_is_fixed_and_does_not_advance_the_user_seeded_stream() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 64) "\00\00\00\00\30\00\00\00")
      (func (export "_start")
        i32.const 0 i32.const 32 call $random drop
        i32.const 32 i32.const 16 call $random drop
        i32.const 1 i32.const 64 i32.const 1 i32.const 72 call $write drop))"#;
    let mut first_request = request(source);
    first_request.startup_entropy_bytes = 32;
    let mut second_request = request(source);
    second_request.startup_entropy_bytes = 32;
    second_request.determinism.random_seed = 8;
    let first = run(first_request).unwrap();
    let second = run(second_request).unwrap();

    assert_eq!(first.stdout.len(), 48);
    assert_eq!(&first.stdout[..32], &second.stdout[..32]);
    assert_ne!(&first.stdout[32..], &second.stdout[32..]);

    let baseline_source = r#"(module
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 64) "\00\00\00\00\10\00\00\00")
      (func (export "_start")
        i32.const 0 i32.const 16 call $random drop
        i32.const 1 i32.const 64 i32.const 1 i32.const 72 call $write drop))"#;
    let baseline = run(request(baseline_source)).unwrap();
    assert_eq!(&first.stdout[32..], baseline.stdout);
}

#[test]
fn random_get_rejects_invalid_ranges_without_allocating_or_advancing_the_rng() {
    let invalid = run(request(
        r#"(module
          (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 32) "\00\00\00\00\18\00\00\00")
          (func (export "_start")
            i32.const 0 i32.const 65535 i32.const 2 call $random i32.store
            i32.const 4 i32.const 0 i32.const -1 call $random i32.store
            i32.const 8 i32.const 16 call $random drop
            i32.const 1 i32.const 32 i32.const 1 i32.const 40 call $write drop))"#,
    ))
    .unwrap();
    let baseline = run(request(
        r#"(module
          (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 32) "\08\00\00\00\10\00\00\00")
          (func (export "_start")
            i32.const 8 i32.const 16 call $random drop
            i32.const 1 i32.const 32 i32.const 1 i32.const 40 call $write drop))"#,
    ))
    .unwrap();

    assert_eq!(&invalid.stdout[..4], &[1, 0, 0, 0]);
    assert_eq!(&invalid.stdout[4..8], &[1, 0, 0, 0]);
    assert_eq!(&invalid.stdout[8..], baseline.stdout);
}

#[test]
fn random_get_validates_wasix_64_ranges_before_filling_guest_memory() {
    let result = run(request(
        r#"(module
          (import "wasix_64v1" "random_get" (func $random (param i64 i64) (result i32)))
          (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
          (memory (export "memory") 1)
          (data (i32.const 16) "\00\00\00\00\08\00\00\00")
          (func (export "_start")
            i32.const 0 i64.const 0 i64.const -1 call $random i32.store
            i32.const 4 i64.const 65536 i64.const 0 call $random i32.store
            i32.const 1 i32.const 16 i32.const 1 i32.const 24 call $write drop))"#,
    ))
    .unwrap();

    assert_eq!(result.stdout, [1, 0, 0, 0, 0, 0, 0, 0]);
}

#[test]
fn random_get_is_replayable_across_chunk_boundaries() {
    let single_call = r#"(module
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 8192) "\00\00\00\00\0d\10\00\00")
      (func (export "_start")
        i32.const 0 i32.const 4109 call $random drop
        i32.const 1 i32.const 8192 i32.const 1 i32.const 8200 call $write drop))"#;
    let split_calls = r#"(module
      (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 8192) "\00\00\00\00\0d\10\00\00")
      (func (export "_start")
        i32.const 0 i32.const 4096 call $random drop
        i32.const 4096 i32.const 13 call $random drop
        i32.const 1 i32.const 8192 i32.const 1 i32.const 8200 call $write drop))"#;
    let mut first_request = request(single_call);
    first_request.resources.output_limit_bytes = 8_192;
    let mut second_request = request(split_calls);
    second_request.resources.output_limit_bytes = 8_192;
    let first = run(first_request).unwrap();
    let second = run(second_request).unwrap();

    assert_eq!(first.stdout.len(), 4_109);
    assert_eq!(first.stdout, second.stdout);
    assert!(first.stdout.iter().any(|byte| *byte != 0));
}

#[test]
fn filesystem_metadata_is_derived_from_the_deterministic_epoch() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "path_filestat_get" (func $stat (param i32 i32 i32 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "input.txt")
      (data (i32.const 160) "\68\00\00\00\18\00\00\00")
      (func (export "_start")
        i32.const 3 i32.const 0 i32.const 0 i32.const 9 i32.const 64 call $stat drop
        i32.const 1 i32.const 160 i32.const 1 i32.const 168 call $write drop))"#;
    let mut first_request = request(source);
    first_request.files.insert(
        "/input.txt".to_string(),
        serde_bytes::ByteBuf::from(b"input".to_vec()),
    );
    let second_request = first_request.clone();
    let first = run(first_request).unwrap();
    let second = run(second_request).unwrap();
    let epoch_ns = 946_684_800_000_000_000_u64;
    let expected = [
        epoch_ns.to_le_bytes(),
        epoch_ns.to_le_bytes(),
        epoch_ns.to_le_bytes(),
    ]
    .concat();

    assert_eq!(first.stdout, expected);
    assert_eq!(first.stdout, second.stdout);

    let mut different_epoch = request(source);
    different_epoch.determinism.realtime_epoch_ms = 1_700_000_000_000;
    different_epoch.files.insert(
        "/input.txt".to_string(),
        serde_bytes::ByteBuf::from(b"input".to_vec()),
    );
    assert_ne!(first.stdout, run(different_epoch).unwrap().stdout);
}

#[test]
fn guest_filesystem_preopen_allows_ephemeral_file_creation_and_writes() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_close" (func $close (param i32) (result i32)))
      (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "created.txt")
      (data (i32.const 80) "\60\00\00\00\01\00\00\00")
      (data (i32.const 96) "x")
      (func (export "_start") (local $errno i32)
        i32.const 4 i32.const 0 i32.const 0 i32.const 11 i32.const 1
        i64.const 64 i64.const 0 i32.const 0 i32.const 64 call $open
        local.tee $errno if local.get $errno call $exit end
        i32.const 64 i32.load i32.const 80 i32.const 1 i32.const 88 call $write
        local.tee $errno if local.get $errno call $exit end
        i32.const 64 i32.load call $close
        local.tee $errno if local.get $errno call $exit end))"#;
    let result = run(request(source)).unwrap();

    assert_eq!(result.code, 0, "{result:?}");
    assert_eq!(
        result.termination,
        wasm_oj_forge_runtime_core::ExecutionTermination::Exited
    );
}

#[test]
fn classifies_write_time_filesystem_quota_exhaustion() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "path_open" (func $open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 0) "created.txt")
      (data (i32.const 80) "\60\00\00\00\08\00\00\00")
      (data (i32.const 96) "12345678")
      (func (export "_start")
        i32.const 4 i32.const 0 i32.const 0 i32.const 11 i32.const 1
        i64.const 64 i64.const 0 i32.const 0 i32.const 64 call $open drop
        i32.const 64 i32.load i32.const 80 i32.const 1 i32.const 88 call $write drop))"#;
    let mut run_request = request(source);
    run_request.resources.filesystem_write_limit_bytes = 4;
    run_request.output_paths = vec!["/created.txt".to_string()];
    let result = run(run_request).unwrap();

    assert_eq!(result.code, 137);
    assert_eq!(
        result.termination,
        wasm_oj_forge_runtime_core::ExecutionTermination::FilesystemLimit
    );
    assert_eq!(result.files["/created.txt"].as_ref(), b"");
    assert_eq!(result.metrics.filesystem_bytes, 0);
    assert_eq!(result.metrics.filesystem_entries, 1);
}

#[test]
fn filestat_set_times_now_uses_the_logical_realtime_clock() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "fd_filestat_set_times" (func $set (param i32 i64 i64 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_filestat_get" (func $stat (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 80) "\28\00\00\00\18\00\00\00")
      (func (export "_start")
        i32.const 3 i64.const 0 i64.const 0 i32.const 10 call $set drop
        i32.const 3 i32.const 0 call $stat drop
        i32.const 1 i32.const 80 i32.const 1 i32.const 88 call $write drop))"#;
    let first = run(request(source)).unwrap();
    let second = run(request(source)).unwrap();
    let epoch_ns = 946_684_800_000_000_000_u64;
    let expected = [
        epoch_ns.to_le_bytes(),
        (epoch_ns + 1_000_000).to_le_bytes(),
        0_u64.to_le_bytes(),
    ]
    .concat();

    assert_eq!(first.stdout, expected);
    assert_eq!(first.stdout, second.stdout);
}

#[test]
fn filestat_set_times_preserves_explicit_guest_timestamps() {
    let source = r#"(module
      (import "wasi_snapshot_preview1" "fd_filestat_set_times" (func $set (param i32 i64 i64 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_filestat_get" (func $stat (param i32 i32) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 80) "\28\00\00\00\18\00\00\00")
      (func (export "_start")
        i32.const 3 i64.const 111 i64.const 222 i32.const 5 call $set drop
        i32.const 3 i32.const 0 call $stat drop
        i32.const 1 i32.const 80 i32.const 1 i32.const 88 call $write drop))"#;
    let result = run(request(source)).unwrap();
    let expected = [
        111_u64.to_le_bytes(),
        222_u64.to_le_bytes(),
        0_u64.to_le_bytes(),
    ]
    .concat();

    assert_eq!(result.stdout, expected);
}

#[test]
fn wasix_64_path_filestat_set_times_now_uses_the_logical_realtime_clock() {
    let source = r#"(module
      (import "wasix_64v1" "path_filestat_set_times" (func $set (param i32 i32 i64 i64 i64 i64 i32) (result i32)))
      (import "wasix_64v1" "fd_filestat_get" (func $stat (param i32 i64) (result i32)))
      (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
      (memory (export "memory") 1)
      (data (i32.const 80) "\28\00\00\00\18\00\00\00")
      (data (i32.const 128) "input.txt")
      (func (export "_start")
        i32.const 3 i32.const 0 i64.const 128 i64.const 9
        i64.const 0 i64.const 0 i32.const 10 call $set drop
        i32.const 3 i64.const 0 call $stat drop
        i32.const 1 i32.const 80 i32.const 1 i32.const 88 call $write drop))"#;
    let mut run_request = request(source);
    run_request.files.insert(
        "/input.txt".to_string(),
        serde_bytes::ByteBuf::from(b"input".to_vec()),
    );
    let result = run(run_request).unwrap();
    let epoch_ns = 946_684_800_000_000_000_u64;
    let expected = [
        epoch_ns.to_le_bytes(),
        (epoch_ns + 1_000_000).to_le_bytes(),
        0_u64.to_le_bytes(),
    ]
    .concat();

    assert_eq!(result.stdout, expected);
}
