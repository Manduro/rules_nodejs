/**
 * @license
 * Copyright 2017 The Bazel Authors. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * You may obtain a copy of the License at
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Set TEST_MANIFEST to true and use `bazel run` to excersize the MANIFEST
// file code path on Linux and OSX
const TEST_MANIFEST = false;

const spawnSync = require('child_process').spawnSync;
const fs = require('fs');
const path = require('path');
const tmp = require('tmp');

const DEBUG = process.env['COMPILATION_MODE'] === 'dbg';
const VERBOSE_LOGS = !!process.env['VERBOSE_LOGS'];

function log(...m) {
  console.error('[test_runner.js]', ...m);
}

function log_verbose(...m) {
  if (VERBOSE_LOGS) console.error('[test_runner.js]', ...m);
}

const config = require(process.argv[2]);
log_verbose(`config: ${JSON.stringify(config, null, 2)}`);

const testArgs = process.argv.slice(3);
log_verbose(`testArgs: ${JSON.stringify(testArgs, null, 2)}`);

/**
 * Helper function to debug log out the contents of a file.
 */
function logFileContents(desc, contents) {
  log_verbose(`${
      desc}\n========================================================================================\n${
      contents}\n^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^\n`);
}

/**
 * Create a new directory and any necessary subdirectories
 * if they do not exist.
 */
function mkdirp(p) {
  if (!fs.existsSync(p)) {
    mkdirp(path.dirname(p));
    fs.mkdirSync(p);
  }
}

/**
 * Checks if a given path exists and is a directory.
 * Note: fs.statSync() is used which resolves symlinks.
 */
function isDirectory(res) {
  try {
    return fs.statSync(res).isDirectory();
  } catch (e) {
    return false;
  }
}

/**
 * Checks if a given path exists and is a file.
 * Note: fs.statSync() is used which resolves symlinks.
 */
function isFile(p) {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

/**
 * Utility function to copy all files in a folder recursively.
 */
function copyFolderSync(from, to) {
  fs.readdirSync(from).forEach(element => {
    const src = path.posix.join(from, element);
    const dest = path.posix.join(to, element);
    if (fs.statSync(src).isFile()) {
      mkdirp(path.dirname(dest));
      fs.copyFileSync(src, dest);
      log_verbose(`copying ${src} -> ${dest}`);
    } else {
      copyFolderSync(src, dest);
    }
  });
}

/**
 * Loads the Bazel MANIFEST file and returns its contents as an object
 * if is found. Returns undefined if there is no MANIFEST file.
 */
function loadRunfilesManifest() {
  // On Windows, Bazel sets RUNFILES_MANIFEST_ONLY=1 and RUNFILES_MANIFEST_FILE.
  // On Linux and OSX RUNFILES_MANIFEST_FILE is not set and not available in the test
  // sandbox but outside of the test sandbox (when executing with `bazel run` for example)
  // we can look for the MANIFEST file and load it. This allows us to exercise the
  // manifest loading code path on Linux and OSX.
  const runfilesManifestFile = path.posix.join(process.env.RUNFILES_DIR, 'MANIFEST');
  const isRunfilesManifestFile = isFile(runfilesManifestFile);
  if (process.env.RUNFILES_MANIFEST_ONLY === '1' || (TEST_MANIFEST && isRunfilesManifestFile)) {
    const manifestPath = process.env.RUNFILES_MANIFEST_FILE || runfilesManifestFile;
    const runfilesManifest = Object.create(null);
    const input = fs.readFileSync(manifestPath, {encoding: 'utf-8'});
    for (const line of input.split('\n')) {
      if (!line) continue;
      const [runfilesPath, realPath] = line.split(' ');
      runfilesManifest[runfilesPath] = realPath;
    }
    return runfilesManifest;
  } else {
    return undefined;
  }
}

const RUNFILES_MANIFEST = loadRunfilesManifest();

/**
 * Helper function to copy the workspace under test to tmp
 */
function copyWorkspace(workspacePath) {
  const to = tmp.dirSync({keep: DEBUG, unsafeCleanup: !DEBUG}).name;
  if (RUNFILES_MANIFEST) {
    const start = workspacePath.startsWith('../') ?
        workspacePath.slice(3) :
        `${process.env['TEST_WORKSPACE']}/${workspacePath}/`;
    let copied = 0;
    for (const key of Object.keys(RUNFILES_MANIFEST)) {
      if (key.startsWith(start)) {
        const element = key.slice(start.length);
        const dest = path.posix.join(to, element);
        mkdirp(path.dirname(dest));
        log_verbose(`copying (MANIFEST) ${RUNFILES_MANIFEST[key]} -> ${dest}`);
        fs.copyFileSync(RUNFILES_MANIFEST[key], dest);
        ++copied;
      }
    }
    if (!copied) {
      throw new Error(`no workspace files found under path ${workspacePath}`)
    }
  } else {
    if (!fs.existsSync(workspacePath)) {
      throw new Error(`workspace under test not found at ${workspacePath}`);
    }
    copyFolderSync(workspacePath, to);
  }
  return to;
}

/**
 * Helper function to copy a runfiles npm package to tmp.
 * This is necessary so that the npm package folder that is symlinked
 * into node_modules in the workspace under test is writtable as
 * yarn & npm may attempt to write files there.
 */
function copyNpmPackage(packagePath) {
  const to = tmp.dirSync({keep: DEBUG, unsafeCleanup: !DEBUG}).name;
  const from = RUNFILES_MANIFEST ? RUNFILES_MANIFEST[packagePath] :
                                   path.posix.join(process.cwd(), '..', packagePath);
  if (!isDirectory(from)) {
    throw new Error(`npm package ${packagePath} not found at ${from}`);
  }
  copyFolderSync(from, to);
  return to;
}

// testName is like examples_webapp or e2e_bazel_managed_deps
// transform to the path we expect by changing first underscore to slash
const workspacePath = config.workspaceRoot.startsWith('external/') ?
    '..' + config.workspaceRoot.slice('external'.length) :
    config.workspaceRoot;
log_verbose(`copying workspace under test ${workspacePath} to tmp`);
const workspaceRoot = copyWorkspace(workspacePath);

// Handle .bazelrc import replacements
const bazelrcImportsKeys = Object.keys(config.bazelrcImports);
const bazelrcFile = path.posix.join(workspaceRoot, '.bazelrc');
if (bazelrcImportsKeys.length && isFile(bazelrcFile)) {
  let bazelrcContents = fs.readFileSync(bazelrcFile, {encoding: 'utf-8'});
  for (const importKey of bazelrcImportsKeys) {
    const importContents =
        fs.readFileSync(require.resolve(config.bazelrcImports[importKey]), {encoding: 'utf-8'});
    bazelrcContents = bazelrcContents.replace(importKey, importContents);
  }
  fs.writeFileSync(bazelrcFile, bazelrcContents);
  logFileContents('.bazelrc file with replacements:', bazelrcContents);
}

// Handle appending to .bazelrc
if (config.bazelrcAppend) {
  let bazelrcContents =
      isFile(bazelrcFile) ? fs.readFileSync(bazelrcFile, {encoding: 'utf-8'}) : '';
  bazelrcContents += '\n\n# Appended by bazel_integration_test\n';
  bazelrcContents += config.bazelrcAppend;
  fs.writeFileSync(bazelrcFile, bazelrcContents);
  logFileContents('.bazelrc file after appending:', bazelrcContents);
}

// Handle WORKSPACE replacements
{
  const workspaceFile = path.posix.join(workspaceRoot, 'WORKSPACE');
  let workspaceContents = fs.readFileSync(workspaceFile, {encoding: 'utf-8'});
  // replace repositories
  for (const repositoryKey of Object.keys(config.repositories)) {
    const archiveFile = require.resolve(config.repositories[repositoryKey]).replace(/\\/g, '/');
    const regex =
        new RegExp(`(local_repository|http_archive|git_repository)\\(\\s*name\\s*\\=\\s*"${
            repositoryKey}"[^)]+`);
    const replacement =
        `load("@bazel_tools//tools/build_defs/repo:http.bzl", "http_archive")\nhttp_archive(\n  name = "${
            repositoryKey}",\n  url="file:${archiveFile}"\n`;
    workspaceContents = workspaceContents.replace(regex, replacement);
    if (!workspaceContents.includes(archiveFile)) {
      console.error(
          `bazel_integration_test: WORKSPACE replacement for repository ${repositoryKey} failed!`)
      process.exit(1);
    }
  }
  fs.writeFileSync(workspaceFile, workspaceContents);
  logFileContents('WORKSPACE file with replacements:', workspaceContents);
}

// Handle package.json replacements
const packageJsonFile = path.posix.join(workspaceRoot, 'package.json');
if (isFile(packageJsonFile)) {
  let packageJsonContents = fs.readFileSync(packageJsonFile, {encoding: 'utf-8'});

  const npmPackageKeys = Object.keys(config.npmPackages);
  if (npmPackageKeys.length) {
    for (const packageJsonKey of npmPackageKeys) {
      log_verbose(`copying npm package ${packageJsonKey} to tmp`);
      const packagePath = copyNpmPackage(config.npmPackages[packageJsonKey]).replace(/\\/g, '/');
      const regex = new RegExp(`\"${packageJsonKey}\"\\s*\:\\s*\"[^"]+`)
      const replacement = `"${packageJsonKey}": "file:${packagePath}`;
      packageJsonContents = packageJsonContents.replace(regex, replacement);
      if (!packageJsonContents.includes(packagePath)) {
        console.error(`bazel_integration_test: package.json replacement for npm package ${
            packageJsonKey} failed!`)
        process.exit(1);
      }
    }
    fs.writeFileSync(packageJsonFile, packageJsonContents);
  }

  const packageJsonReplacementKeys = Object.keys(config.packageJsonRepacements);
  if (packageJsonReplacementKeys.length) {
    for (const packageJsonKey of packageJsonReplacementKeys) {
      const regex = new RegExp(`\"${packageJsonKey}\"\\s*\:\\s*\"[^"]+`)
      const replacement = `"${packageJsonKey}": "${config.packageJsonRepacements[packageJsonKey]}`;
      packageJsonContents = packageJsonContents.replace(regex, replacement);
      if (!packageJsonContents.includes(replacement)) {
        console.error(`bazel_integration_test: package.json replacement for npm package ${
            packageJsonKey} failed!`)
        process.exit(1);
      }
    }
  }

  for (const packageJsonKey of config.checkNpmPackages) {
    if (packageJsonContents.includes(`"${packageJsonKey}"`) &&
        !packageJsonContents.includes(`"${packageJsonKey}": "file:`)) {
      console.error(`bazel_integration_test: expected replacement of npm package ${
          packageJsonKey} for locally generated npm_package not found; add ${
          packageJsonKey} to npm_packages attribute`);
      process.exit(1);
    }
  }

  logFileContents('package.json file with replacements:', packageJsonContents);
}

const isWindows = process.platform === 'win32';
const bazelBinary =
    require.resolve(`${config.bazelBinaryWorkspace}/bazel${isWindows ? '.exe' : ''}`);

if (DEBUG || VERBOSE_LOGS) {
  // If DEBUG is set then the tmp folders created by the `tmp.dirSync` are not
  // cleaned up so we should log out the location of the workspace under test
  // tmp folder in that case even if VERBOSE_LOGS is not set as it may be useful
  // to `cd /path/to/workspace/tmp` for manual testing at that point.
  log(`

********************************************************************************
bazel binary under test is ${bazelBinary}
workspace under test root is ${workspaceRoot}
********************************************************************************
`);
}

log(`running 'bazel version'`);
let spawnedProcess = spawnSync(bazelBinary, ['version'], {cwd: workspaceRoot, stdio: 'inherit'});
if (spawnedProcess.status) {
  process.exit(spawnedProcess.status);
}

if (VERBOSE_LOGS) {
  log_verbose(`running 'bazel info'`);
  spawnedProcess = spawnSync(bazelBinary, ['info'], {cwd: workspaceRoot, stdio: 'inherit'});
  if (spawnedProcess.status) {
    process.exit(spawnedProcess.status);
  }
}

for (const bazelCommand of config.bazelCommands) {
  const bazelArgs = bazelCommand.split(' ');
  // look for `--` argument and insert testArgs before it
  // if it exists, otherwise push to end of arguments
  const doubleHyphenPos = bazelArgs.indexOf('--');
  if (doubleHyphenPos !== -1) {
    bazelArgs.splice(doubleHyphenPos, 0, ...testArgs);
  } else {
    bazelArgs.push(...testArgs);
  }
  log(`running 'bazel ${bazelArgs.join(' ')}'`);
  spawnedProcess = spawnSync(bazelBinary, bazelArgs, {cwd: workspaceRoot, stdio: 'inherit'});
  if (spawnedProcess.status) {
    process.exit(spawnedProcess.status);
  }
}
