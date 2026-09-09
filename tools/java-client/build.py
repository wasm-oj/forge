"""Build the client Java toolchain from pinned public sources in an empty directory."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import struct
import subprocess
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
SOURCES = {
    'teavm-core': ('https://github.com/konsoletyper/teavm.git', 'b3a245b7d9034ff35cdfab2def057a3d4f256efb'),
    'teavm-javac': ('https://github.com/konsoletyper/teavm-javac.git', '7e4a44cf521694a4e326e33850dd8aec165eb5c9'),
}
JDK_REVISION = '890adb6410dab4606a4f26a942aed02fb2f55387'
JDK_SOURCE_SHA256 = '016be5201082fb671d8622bed40a0a56c2b8c4b161da8a6a03b00b2f8a045e46'
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--jdk', required=True, type=Path, help='JDK 21 home containing bin and jmods')
parser.add_argument('--cache', type=Path, default=Path.home() / '.cache/wasm-oj-java')
args = parser.parse_args()
build = args.output.resolve()
if build.exists():
    raise SystemExit('Output directory must not exist; reuse only the hash-verified download cache.')
build.mkdir(parents=True)
args.cache.mkdir(parents=True, exist_ok=True)
jdk = args.jdk.resolve()

def run(*command, cwd=None):
    subprocess.run([str(value) for value in command], cwd=cwd, check=True)

def fetch(name, url, digest):
    target = args.cache / name
    if not target.exists():
        temporary = target.with_suffix(target.suffix + '.download')
        with urllib.request.urlopen(url) as response, temporary.open('wb') as output:
            shutil.copyfileobj(response, output)
        temporary.replace(target)
    if hashlib.sha256(target.read_bytes()).hexdigest() != digest:
        raise RuntimeError(f'Pinned input digest mismatch: {name}')
    return target

def compile_java(output, sources, options=()):
    output.mkdir(parents=True, exist_ok=True)
    arguments = build / (output.name + '.sources')
    arguments.write_text('\n'.join('"' + str(path).replace('\\', '\\\\').replace('"', '\\"') + '"' for path in sources))
    run(jdk / 'bin/javac', '-encoding', 'UTF-8', *options, '-d', output, '@' + str(arguments))

version = subprocess.check_output([str(jdk / 'bin/java'), '-version'], stderr=subprocess.STDOUT, text=True)
if 'version "21.' not in version:
    raise SystemExit('JDK 21 is required.')
(build / 'jdk-version.txt').write_text(version)
for name, (url, revision) in SOURCES.items():
    root = build / name
    run('git', 'init', '-q', root)
    run('git', 'fetch', '-q', '--depth=1', url, revision, cwd=root)
    run('git', 'checkout', '-q', '--detach', 'FETCH_HEAD', cwd=root)
    actual = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip()
    if actual != revision:
        raise RuntimeError(f'Unexpected source revision: {name}')
    run('git', 'apply', HERE / (name + '.patch'), cwd=root)
core = build / 'teavm-core'
wrapper = build / 'teavm-javac'
dependencies = json.loads((HERE / 'dependencies.json').read_text())
dep_dir = build / 'dependencies'
dep_dir.mkdir()
for dependency in dependencies:
    shutil.copyfile(fetch(dependency['name'], dependency['url'], dependency['sha256']), dep_dir / dependency['name'])
base_cp = os.pathsep.join(str(dep_dir / dependency['name']) for dependency in dependencies)

# Match TeaVM's dependency-relocation Gradle plugin before compiling its sources.
relocated = build / 'relocated-source'
for module in ['core', 'classlib', 'platform', 'jso/impl']:
    source = core / module / 'src/main/java'
    for path in source.rglob('*.java'):
        if path.name == 'module-info.java':
            continue
        text = path.read_text()
        for original, replacement in [('com.carrotsearch.hppc', 'org.teavm.hppc'),
                ('org.objectweb.asm', 'org.teavm.asm'), ('org.mozilla', 'org.teavm.rhino'),
                ('org.apache.commons', 'org.teavm.apachecommons')]:
            text = text.replace(original, replacement)
        output = relocated / module / path.relative_to(source)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(text)
classes = build / 'classes'
compile_java(classes, sorted(relocated.rglob('*.java')), ['--release', '11', '-cp', base_cp])

archive = fetch('jdk-' + JDK_REVISION + '.zip',
    'https://github.com/openjdk/jdk21/archive/' + JDK_REVISION + '.zip', JDK_SOURCE_SHA256)
source = build / 'jdk-source'
with zipfile.ZipFile(archive) as package:
    for name in package.namelist():
        relative = '/'.join(name.split('/')[1:])
        if name.endswith('/') or relative.endswith('module-info.java') or not relative.startswith((
                'make/langtools/tools/', 'src/jdk.compiler/share/classes/', 'src/java.compiler/share/classes/',
                'src/jdk.internal.opt/share/classes/', 'src/java.base/share/classes/jdk/internal/jmod/')):
            continue
        output = source / relative
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(package.read(name))
tool_source = source / 'make/langtools/tools'
build_tools = build / 'jdk-build-tools'
compile_java(build_tools, [path for path in sorted(tool_source.rglob('*.java'))
    if not any(name in path.parts for name in ['anttasks', 'genstubs', 'crules'])])
tool_cp = str(build_tools) + os.pathsep + str(tool_source)
generated = build / 'jdk-generated/com/sun/tools/javac/resources'
generated.mkdir(parents=True)
for name in ['compiler', 'launcher']:
    run(jdk / 'bin/java', '-cp', tool_cp, 'propertiesparser.PropertiesParser', '-compile',
        source / f'src/jdk.compiler/share/classes/com/sun/tools/javac/resources/{name}.properties', generated)
for name in ['compiler', 'launcher', 'javac']:
    run(jdk / 'bin/java', '-cp', tool_cp, 'compileproperties.CompileProperties', '-compile',
        f'./com/sun/tools/javac/resources/{name}.properties', generated / (name + '.java'),
        'java.util.ListResourceBundle', cwd=source / 'src/jdk.compiler/share/classes')
options = ['--limit-modules', 'java.base']
for package in ['jdk.internal.javac', 'jdk.internal.misc', 'jdk.internal.module', 'sun.reflect.annotation']:
    options += ['--add-exports', f'java.base/{package}=ALL-UNNAMED']
javac_classes = build / 'javac-classes'
compile_java(javac_classes, sorted((source / 'src').rglob('*.java')) + sorted(generated.rglob('*.java')), options)
main = build / 'wrapper-classes'
cp = os.pathsep.join([str(classes), str(javac_classes), base_cp])
compile_java(main, sorted((wrapper / 'compiler/src/main/java').rglob('*.java'))
    + sorted((wrapper / 'protocol/src/main/java').rglob('*.java'))
    + [wrapper / 'compiler/src/test/java' / name for name in ['BuildJavaGcCompiler.java', 'RelocateScanner.java']],
    ['--limit-modules', 'java.base', '-cp', cp])
emulator = build / 'emulator-classes'
compile_java(emulator, sorted((wrapper / 'compiler/src/classlibEmu/java').rglob('*.java')), ['-cp', cp])
gc_emulator = build / 'gc-emulator-classes'
shutil.copytree(emulator, gc_emulator)
(gc_emulator / 'org/teavm/classlib/java/lang/TConsoleInputStream.class').unlink()
java_base = build / 'java-base'
with zipfile.ZipFile(jdk / 'jmods/java.base.jmod') as package:
    for name in package.namelist():
        if name.startswith('classes/') and name.endswith('.class'):
            output = java_base / name.removeprefix('classes/')
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(package.read(name))
resources = [wrapper / 'compiler/src/main/resources'] + [core / module / 'src/main/resources'
    for module in ['core', 'classlib', 'platform', 'jso/impl']]
cp = os.pathsep.join(str(path) for path in [main, classes, javac_classes, gc_emulator, *resources])
cp += os.pathsep + base_cp + os.pathsep + str(java_base)
(build / 'compiler-classpath.txt').write_text(cp)
run(jdk / 'bin/java', '-cp', cp, 'BuildJavaGcCompiler', build / 'compiler')

def contents(path):
    if path.is_dir():
        return {file.relative_to(path).as_posix(): file.read_bytes() for file in path.rglob('*') if file.is_file()}
    with zipfile.ZipFile(path) as package:
        return {name: package.read(name) for name in package.namelist() if not name.endswith('/')}

def write_archive(path, values):
    with path.open('wb') as output:
        for name, data in sorted(values.items()):
            key = name.encode()
            output.write(struct.pack('>H', len(key)) + key + struct.pack('>I', len(data)) + data)

def read_archive(path):
    data = path.read_bytes()
    entries = {}
    offset = 0
    while offset < len(data):
        size = struct.unpack_from('>H', data, offset)[0]
        offset += 2
        name = data[offset:offset + size].decode()
        offset += size
        size = struct.unpack_from('>I', data, offset)[0]
        offset += 4
        entries[name] = data[offset:offset + size]
        offset += size
    return entries

def jar(name):
    return dep_dir / (name + '-0.13.1.jar')

classlib = contents(jar('teavm-classlib'))
jso = contents(jar('teavm-jso'))
apis = contents(jar('teavm-jso-apis'))
compiled = contents(classes)
emulated = contents(emulator)
sdk_inputs = {**classlib, **jso, **apis}
sdk_inputs.update({name: data for name, data in compiled.items() if name.startswith('org/teavm/classlib/')})
sdk_inputs.update(emulated)
sdk_directory = build / 'sdk-input'
for name, data in sdk_inputs.items():
    output = sdk_directory / name
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_bytes(data)
assets = build / 'classlibs'
assets.mkdir()
run(jdk / 'bin/java', '-cp', cp, 'org.teavm.javac.StdlibConverter', assets / 'sdk.bin', sdk_directory)
sdk = read_archive(assets / 'sdk.bin')
scanner_source = wrapper / 'compiler/src/scanner/java'
scanner_classes = build / 'scanner-classes'
compile_java(scanner_classes, sorted(scanner_source.rglob('*.java')), ['--patch-module', f'java.base={scanner_source}'])
sdk.update(contents(scanner_classes))
run(jdk / 'bin/java', '-cp', cp, 'RelocateScanner', scanner_classes, build / 'scanner-relocated')
allowed = ('org/teavm/classlib/', 'org/teavm/platform/', 'org/teavm/jso/', 'org/teavm/runtime/',
    'org/teavm/interop/', 'org/teavm/backend/wasm/runtime/', 'org/teavm/backend/wasm/wasi/',
    'org/teavm/backend/wasm/WasmRuntime', 'org/teavm/backend/wasm/WasmHeap', 'com/jcraft/jzlib/')
runtime = {**classlib, **jso, **apis}
for path in [jar('teavm-core'), jar('teavm-jso-impl'), jar('teavm-interop'), jar('teavm-platform'),
        dep_dir / 'jzlib-1.1.3.jar', classes]:
    runtime.update({name: data for name, data in contents(path).items() if name.startswith(allowed)})
runtime.pop('META-INF/MANIFEST.MF', None)
runtime.pop('org/teavm/classlib/java/lang/TClassLoader$ResourceContainer.class', None)
for name in ['org/teavm/classlib/java/lang/TClassLoader.class',
        'org/teavm/classlib/java/lang/TConsoleInputStream.class', 'org/teavm/platform/Platform.class']:
    runtime[name] = emulated[name]
runtime.update(contents(build / 'scanner-relocated'))
with zipfile.ZipFile(io.BytesIO(runtime['org/teavm/classlib/impl/unicode/cldr-json.zip'])) as package:
    locales = sorted({name.split('/')[0] for name in package.namelist()
        if '/' in name and name.split('/')[0] not in ('', 'root', 'supplemental')})
runtime['META-INF/teavm/locales.txt'] = ','.join(name.replace('-', '_', 1) for name in locales).encode()
write_archive(assets / 'java-teavm-0.13.1.compile-classlib.bin', sdk)
write_archive(assets / 'java-teavm-0.13.1.runtime-classlib.bin', runtime)
run('node', wrapper / 'compiler/src/test/js/package-static-gc.mjs', core, build / 'compiler')
manifest = {path.name: {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'bytes': path.stat().st_size}
    for path in [build / 'compiler/java-compiler.wasm', *sorted(assets.glob('java-*.bin'))]}
(build / 'assets.json').write_text(json.dumps(manifest, indent=2) + '\n')
provenance = {
    'sources': {name: {'repository': url, 'revision': revision,
        'patchSha256': hashlib.sha256((HERE / (name + '.patch')).read_bytes()).hexdigest()}
        for name, (url, revision) in SOURCES.items()},
    'dependencies': dependencies,
    'jdkSourceRevision': JDK_REVISION,
    'jdkSourceSha256': JDK_SOURCE_SHA256,
    'jdkVersion': version,
    'jdkJavaBaseSha256': hashlib.sha256((jdk / 'jmods/java.base.jmod').read_bytes()).hexdigest(),
    'nodeVersion': subprocess.check_output(['node', '--version'], text=True).strip(),
    'buildScriptSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    'assets': manifest,
}
(build / 'provenance.json').write_text(json.dumps(provenance, indent=2) + '\n')

print(json.dumps(manifest, indent=2))
