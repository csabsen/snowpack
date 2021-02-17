import {promises as fs} from 'fs';
import glob from 'glob';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import PQueue from 'p-queue';
import path from 'path';
import {performance} from 'perf_hooks';
import url from 'url';
import {generateEnvModule, wrapImportProxy} from '../build/build-import-proxy';
import {runPipelineCleanupStep, runPipelineOptimizeStep} from '../build/build-pipeline';
import {FileBuilder} from '../build/file-builder';
import {getMountEntryForFile, getUrlsForFileMount} from '../build/file-urls';
import {runBuiltInOptimize} from '../build/optimize';
import {EsmHmrEngine} from '../hmr-server-engine';
import {logger} from '../logger';
import {getInstallTargets} from '../scan-imports';
import {run as installRunner} from '../sources/local-install';
import {getPackageSource} from '../sources/util';
import {
  CommandOptions,
  OnFileChangeCallback,
  SnowpackBuildResult,
  SnowpackBuildResultFileManifest,
  SnowpackConfig,
  SnowpackSourceFile,
} from '../types';
import {
  deleteFromBuildSafe,
  HMR_CLIENT_CODE,
  HMR_OVERLAY_CODE,
  isFsEventsEnabled,
  readFile,
} from '../util';

const CONCURRENT_WORKERS = require('os').cpus().length;

let hmrEngine: EsmHmrEngine | null = null;
function getIsHmrEnabled(config: SnowpackConfig) {
  return config.buildOptions.watch && !!config.devOptions.hmr;
}

/**
 * Scan a directory and remove any empty folders, recursively.
 */
async function removeEmptyFolders(directoryLoc: string): Promise<boolean> {
  if (!(await fs.stat(directoryLoc)).isDirectory()) {
    return false;
  }
  // If folder is empty, clear it
  const files = await fs.readdir(directoryLoc);
  if (files.length === 0) {
    await fs.rmdir(directoryLoc);
    return false;
  }
  // Otherwise, step in and clean each contained item
  await Promise.all(files.map((file) => removeEmptyFolders(path.join(directoryLoc, file))));
  // After, check again if folder is now empty
  const afterFiles = await fs.readdir(directoryLoc);
  if (afterFiles.length == 0) {
    await fs.rmdir(directoryLoc);
  }
  return true;
}

async function installOptimizedDependencies(
  scannedFiles: SnowpackSourceFile[],
  installDest: string,
  commandOptions: CommandOptions,
) {
  const baseInstallOptions = {
    dest: installDest,
    external: commandOptions.config.packageOptions.external,
    env: {NODE_ENV: process.env.NODE_ENV || 'production'},
    treeshake: commandOptions.config.buildOptions.watch
      ? false
      : commandOptions.config.optimize?.treeshake !== false,
  };

  const pkgSource = getPackageSource(commandOptions.config.packageOptions.source);
  const installOptions = pkgSource.modifyBuildInstallOptions({
    installOptions: baseInstallOptions,
    config: commandOptions.config,
    lockfile: commandOptions.lockfile,
  });

  // 1. Scan imports from your final built JS files.
  // Unlike dev (where we scan from source code) the built output guarantees that we
  // will can scan all used entrypoints. Set to `[]` to improve tree-shaking performance.
  const installTargets = await getInstallTargets(commandOptions.config, [], scannedFiles);
  // 2. Install dependencies, based on the scan of your final build.
  const installResult = await installRunner({
    installTargets,
    installOptions,
    config: commandOptions.config,
    shouldPrintStats: false,
  });
  return installResult;
}

export async function build(commandOptions: CommandOptions): Promise<SnowpackBuildResult> {
  const {config} = commandOptions;
  const isDev = !!config.buildOptions.watch;
  const isSSR = !!config.buildOptions.ssr;

  // Fill in any command-specific plugin methods.
  // NOTE: markChanged only needed during dev, but may not be true for all.
  if (isDev) {
    for (const p of config.plugins) {
      p.markChanged = (fileLoc) => onWatchEvent(fileLoc) || undefined;
    }
  }

  const buildDirectoryLoc = config.buildOptions.out;
  const internalFilesBuildLoc = path.join(buildDirectoryLoc, config.buildOptions.metaUrlPath);

  if (config.buildOptions.clean) {
    deleteFromBuildSafe(buildDirectoryLoc, config);
  }
  mkdirp.sync(buildDirectoryLoc);
  mkdirp.sync(internalFilesBuildLoc);

  for (const runPlugin of config.plugins) {
    if (runPlugin.run) {
      logger.debug(`starting ${runPlugin.name} run() (isDev=${isDev})`);
      const runJob = runPlugin
        .run({
          isDev: isDev,
          // @ts-ignore: deprecated
          isHmrEnabled: getIsHmrEnabled(config),
          // @ts-ignore: internal API only
          log: (msg, data: {msg: string} = {}) => {
            if (msg === 'CONSOLE_INFO' || msg === 'WORKER_MSG') {
              logger.info(data.msg.trim(), {name: runPlugin.name});
            }
          },
        })
        .catch((err) => {
          logger.error(err.toString(), {name: runPlugin.name});
          if (!isDev) {
            process.exit(1);
          }
        });
      // Wait for the job to complete before continuing (unless in watch mode)
      if (!isDev) {
        await runJob;
      }
    }
  }

  // Write the `import.meta.env` contents file to disk
  logger.debug(`generating meta files`);
  await fs.writeFile(
    path.join(internalFilesBuildLoc, 'env.js'),
    generateEnvModule({mode: 'production', isSSR}),
  );
  if (getIsHmrEnabled(config)) {
    await fs.writeFile(path.resolve(internalFilesBuildLoc, 'hmr-client.js'), HMR_CLIENT_CODE);
    await fs.writeFile(
      path.resolve(internalFilesBuildLoc, 'hmr-error-overlay.js'),
      HMR_OVERLAY_CODE,
    );
    hmrEngine = new EsmHmrEngine({port: config.devOptions.hmrPort});
  }

  logger.info(colors.yellow('! building source files...'));
  const buildStart = performance.now();
  const buildPipelineFiles: Record<string, FileBuilder> = {};

  /** Install all needed dependencies, based on the master buildPipelineFiles list.  */
  async function installDependencies(scannedFiles: SnowpackSourceFile[]) {
    const installDest = path.join(buildDirectoryLoc, config.buildOptions.metaUrlPath, 'pkg');
    const installResult = await installOptimizedDependencies(
      scannedFiles,
      installDest,
      commandOptions,
    );
    const allFiles = glob.sync(`**/*`, {
      cwd: installDest,
      absolute: true,
      nodir: true,
      dot: true,
      follow: true,
    });

    if (!config.optimize?.bundle) {
      for (const installedFileLoc of allFiles) {
        if (
          !installedFileLoc.endsWith('import-map.json') &&
          path.extname(installedFileLoc) !== '.js'
        ) {
          const proxiedCode = await readFile(url.pathToFileURL(installedFileLoc));
          const importProxyFileLoc = installedFileLoc + '.proxy.js';
          const proxiedUrl = installedFileLoc.substr(buildDirectoryLoc.length).replace(/\\/g, '/');
          const proxyCode = await wrapImportProxy({
            url: proxiedUrl,
            code: proxiedCode,
            hmr: false,
            config: config,
          });
          await fs.writeFile(importProxyFileLoc, proxyCode, 'utf8');
        }
      }
    }
    return installResult;
  }

  // 0. Find all source files.
  for (const [mountedDir, mountEntry] of Object.entries(config.mount)) {
    const finalDestLocMap = new Map<string, string>();
    const allFiles = glob.sync(`**/*`, {
      ignore: [...config.exclude, ...config.testOptions.files],
      cwd: mountedDir,
      absolute: true,
      nodir: true,
      dot: true,
      follow: true,
    });
    for (const rawLocOnDisk of allFiles) {
      const fileLoc = path.resolve(rawLocOnDisk); // this is necessary since glob.sync() returns paths with / on windows.  path.resolve() will switch them to the native path separator.
      const finalUrl = getUrlsForFileMount({fileLoc, mountKey: mountedDir, mountEntry, config})![0];
      const finalDestLoc = path.join(buildDirectoryLoc, finalUrl);

      const existedFileLoc = finalDestLocMap.get(finalDestLoc);
      if (existedFileLoc) {
        const errorMessage =
          `Error: Two files overlap and build to the same destination: ${finalDestLoc}\n` +
          `  File 1: ${existedFileLoc}\n` +
          `  File 2: ${fileLoc}\n`;
        throw new Error(errorMessage);
      }

      const buildPipelineFile = new FileBuilder({
        loc: fileLoc,
        isSSR,
        isHMR: getIsHmrEnabled(config),
        config,
        isStatic: mountEntry.static,
        isResolve: mountEntry.resolve,
        hmrEngine: hmrEngine,
      });
      buildPipelineFiles[fileLoc] = buildPipelineFile;

      finalDestLocMap.set(finalDestLoc, fileLoc);
    }
  }

  // 1. Build all files for the first time, from source.
  const parallelWorkQueue = new PQueue({concurrency: CONCURRENT_WORKERS});
  const allBuildPipelineFiles = Object.values(buildPipelineFiles);
  for (const buildPipelineFile of allBuildPipelineFiles) {
    parallelWorkQueue.add(async () => {
      await buildPipelineFile.build();
    });
  }
  await parallelWorkQueue.onIdle();

  const buildEnd = performance.now();
  logger.info(
    `${colors.green('✔')} build complete ${colors.dim(
      `[${((buildEnd - buildStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  // 2. Install all dependencies. This gets us the import map we need to resolve imports.
  const allBuiltFiles: SnowpackSourceFile[] = [];
  for (const buildPipelineFile of allBuildPipelineFiles) {
    for (const buildUrl of buildPipelineFile.urls) {
      allBuiltFiles.push({
        baseExt: path.extname(buildUrl),
        root: config.root,
        contents: buildPipelineFile.getResult(path.extname(buildUrl)),
        locOnDisk: path.join(buildDirectoryLoc, buildUrl),
      });
    }
  }
  let installResult = await installDependencies(allBuiltFiles);

  // 3. Resolve all built file imports.
  logger.info(colors.yellow('! verifying build...'));
  const verifyStart = performance.now();
  const buildResultManifest: SnowpackBuildResultFileManifest = {};
  for (const buildPipelineFile of allBuildPipelineFiles) {
    parallelWorkQueue.add(async () => {
      await buildPipelineFile.resolveImports(false, installResult.importMap!);
      for (const buildUrl of buildPipelineFile.urls) {
        const type = path.extname(buildUrl);
        buildResultManifest[buildUrl] = {
          contents: buildPipelineFile.getResult(type),
          source: buildPipelineFile.loc,
        };
        if (config.buildOptions.sourcemap) {
          const sourceMapResult = await buildPipelineFile.getSourceMap(type);
          if (sourceMapResult) {
            buildResultManifest[buildUrl + '.map'] = {
              contents: sourceMapResult,
              source: buildPipelineFile.loc,
            };
          }
        }
      }
    });
  }
  await parallelWorkQueue.onIdle();
  // 3b. Handle all proxy imports, if needed.
  const allImportProxyFiles = new Set(
    allBuildPipelineFiles.map((b) => b.proxyImports).reduce((flat, item) => flat.concat(item), []),
  );
  for (const buildPipelineFile of allBuildPipelineFiles) {
    for (const builtFileUrl of buildPipelineFile.urls) {
      if (allImportProxyFiles.has(builtFileUrl)) {
        parallelWorkQueue.add(async () => {
          const type = path.extname(builtFileUrl);
          const buildProxyResult = await buildPipelineFile.getProxy(builtFileUrl, type);
          buildResultManifest[builtFileUrl + '.proxy.js'] = {
            contents: buildProxyResult,
            source: buildPipelineFile.loc,
          };
          // .catch((err) => handleFileError(err, buildPipelineFile)),
        });
      }
    }
  }
  await parallelWorkQueue.onIdle();
  const verifyEnd = performance.now();
  logger.info(
    `${colors.green('✔')} verification complete ${colors.dim(
      `[${((verifyEnd - verifyStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  console.log('buildResultManifest', buildResultManifest);
  async function writeToDisk(loc: string, result: string | Buffer) {
    await mkdirp(path.dirname(loc));
    const encoding = typeof result === 'string' ? 'utf8' : undefined;
    await fs.writeFile(loc, result, encoding);
  }

  // 4. Write files to disk.
  logger.info(colors.yellow('! writing build to disk...'));
  console.log(allImportProxyFiles);
  for (const buildResultUrl of Object.keys(buildResultManifest)) {
    parallelWorkQueue.add(() =>
      writeToDisk(
        path.join(buildDirectoryLoc, buildResultUrl),
        buildResultManifest[buildResultUrl].contents,
      ),
    );
  }
  await parallelWorkQueue.onIdle();

  // "--watch --hmr" mode - Tell users about the HMR WebSocket URL
  if (hmrEngine) {
    logger.info(
      `[HMR] WebSocket URL available at ${colors.cyan(`ws://localhost:${hmrEngine.port}`)}`,
    );
  }

  // 5. Optimize the build.
  if (!config.buildOptions.watch) {
    if (config.optimize || config.plugins.some((p) => p.optimize)) {
      const optimizeStart = performance.now();
      logger.info(colors.yellow('! optimizing build...'));
      await runBuiltInOptimize(config);
      await runPipelineOptimizeStep(buildDirectoryLoc, {
        config,
        isDev: false,
        isSSR: config.buildOptions.ssr,
        isHmrEnabled: false,
      });
      const optimizeEnd = performance.now();
      logger.info(
        `${colors.green('✔')} optimize complete ${colors.dim(
          `[${((optimizeEnd - optimizeStart) / 1000).toFixed(2)}s]`,
        )}`,
      );
    }
    await removeEmptyFolders(buildDirectoryLoc);
    await runPipelineCleanupStep(config);
    logger.info(`${colors.underline(colors.green(colors.bold('▶ Build Complete!')))}\n\n`);
    return {
      result: buildResultManifest,
      onFileChange: () => {
        throw new Error('build().onFileChange() only supported in "watch" mode.');
      },
      shutdown: () => {
        throw new Error('build().shutdown() only supported in "watch" mode.');
      },
    };
  }

  // "--watch" mode - Start watching the file system.
  // Defer "chokidar" loading to here, to reduce impact on overall startup time
  logger.info(colors.cyan('watching for changes...'));
  const chokidar = await import('chokidar');

  function onDeleteEvent(fileLoc: string) {
    delete buildPipelineFiles[fileLoc];
  }
  async function onWatchEvent(fileLoc: string) {
    logger.info(colors.cyan('File changed...'));
    const mountEntryResult = getMountEntryForFile(fileLoc, config);
    if (!mountEntryResult) {
      return;
    }
    onFileChangeCallback({filePath: fileLoc});
    const [, mountEntry] = mountEntryResult;
    const changedPipelineFile = new FileBuilder({
      loc: fileLoc,
      isSSR,
      isHMR: getIsHmrEnabled(config),
      config,
      isStatic: mountEntry.static,
      isResolve: mountEntry.resolve,
      hmrEngine: hmrEngine,
    });
    buildPipelineFiles[fileLoc] = changedPipelineFile;
    // 1. Build the file.
    await changedPipelineFile.build().catch((err) => {
      logger.error(fileLoc + ' ' + err.toString(), {name: err.__snowpackBuildDetails?.name});
      hmrEngine &&
        hmrEngine.broadcastMessage({
          type: 'error',
          title:
            `Build Error` + err.__snowpackBuildDetails
              ? `: ${err.__snowpackBuildDetails.name}`
              : '',
          errorMessage: err.toString(),
          fileLoc,
          errorStackTrace: err.stack,
        });
    });
    // 2. Resolve any ESM imports. Handle new imports by triggering a re-install.
    await changedPipelineFile.resolveImports(false, installResult.importMap!);
    // TODO: What happens if new dependnecy is added?
    // In build mode, we shouldn't use single install. Instead, we should do the normal
    // dev install which includes live updating of dependencies.

    // 3. Write to disk. If any proxy imports are needed, write those as well.
    for (const [buildResultUrl, buildResult] of Object.entries(
      await changedPipelineFile.getAllResults(),
    )) {
      await writeToDisk(path.join(buildDirectoryLoc, buildResultUrl), buildResult);
    }
    const allBuildPipelineFiles = Object.values(buildPipelineFiles);
    const allImportProxyFiles = new Set(
      allBuildPipelineFiles
        .map((b) => b.proxyImports)
        .reduce((flat, item) => flat.concat(item), []),
    );
    for (const builtResultUrl of changedPipelineFile.urls) {
      const type = path.extname(builtResultUrl);
      if (config.buildOptions.sourcemap) {
        const changedFileSourceMap = await changedPipelineFile.getSourceMap(type);
        if (changedFileSourceMap) {
          await writeToDisk(
            path.join(buildDirectoryLoc, builtResultUrl + '.proxy.js'),
            changedFileSourceMap,
          );
        }
      }
      if (allImportProxyFiles.has(builtResultUrl)) {
        await writeToDisk(
          path.join(buildDirectoryLoc, builtResultUrl + '.proxy.js'),
          await changedPipelineFile.getProxy(builtResultUrl, type),
        );
      }
    }
    if (hmrEngine) {
      hmrEngine.broadcastMessage({type: 'reload'});
    }
  }
  const watcher = chokidar.watch(Object.keys(config.mount), {
    ignored: config.exclude,
    ignoreInitial: true,
    persistent: true,
    disableGlobbing: false,
    useFsEvents: isFsEventsEnabled(),
  });
  watcher.on('add', (fileLoc) => onWatchEvent(fileLoc));
  watcher.on('change', (fileLoc) => onWatchEvent(fileLoc));
  watcher.on('unlink', (fileLoc) => onDeleteEvent(fileLoc));

  // Allow the user to hook into this callback, if they like (noop by default)
  let onFileChangeCallback: OnFileChangeCallback = () => {};

  return {
    result: buildResultManifest,
    onFileChange: (callback) => (onFileChangeCallback = callback),
    async shutdown() {
      await watcher.close();
    },
  };
}

export async function command(commandOptions: CommandOptions) {
  try {
    await build(commandOptions);
  } catch (err) {
    logger.error(err.message);
    logger.debug(err.stack);
    process.exit(1);
  }

  if (commandOptions.config.buildOptions.watch) {
    // We intentionally never want to exit in watch mode!
    return new Promise(() => {});
  }
}
