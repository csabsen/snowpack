import {promises as fs} from 'fs';
import glob from 'glob';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import PQueue from 'p-queue';
import path from 'path';
import {performance} from 'perf_hooks';
import url from 'url';
import {
  generateEnvModule,
  wrapHtmlResponse,
  wrapImportMeta,
  wrapImportProxy,
} from '../build/build-import-proxy';
import {buildFile, runPipelineCleanupStep, runPipelineOptimizeStep} from '../build/build-pipeline';
import {getMountEntryForFile, getUrlsForFileMount} from '../build/file-urls';
import {createImportResolver} from '../build/import-resolver';
import {runBuiltInOptimize} from '../build/optimize';
import {EsmHmrEngine} from '../hmr-server-engine';
import {logger} from '../logger';
import {transformFileImports} from '../rewrite-imports';
import {getInstallTargets} from '../scan-imports';
import {
  CommandOptions,
  ImportMap,
  MountEntry,
  OnFileChangeCallback,
  SnowpackBuildResult,
  SnowpackBuildResultFileManifest,
  SnowpackConfig,
  SnowpackSourceFile,
} from '../types';
import {
  addExtension,
  cssSourceMappingURL,
  deleteFromBuildSafe,
  getExtensionMatch,
  HMR_CLIENT_CODE,
  HMR_OVERLAY_CODE,
  isFsEventsEnabled,
  isRemoteUrl,
  jsSourceMappingURL,
  readFile,
  relativeURL,
  removeLeadingSlash,
  replaceExtension,
} from '../util';
import {run as installRunner} from '../sources/local-install';
import {getPackageSource} from '../sources/util';
import {FileBuilder} from '../build/file-builder';

const CONCURRENT_WORKERS = require('os').cpus().length;

let hmrEngine: EsmHmrEngine | null = null;
function getIsHmrEnabled(config: SnowpackConfig) {
  return config.buildOptions.watch && !!config.devOptions.hmr;
}

function handleFileError(err: Error, builder: FileBuilder) {
  logger.error(`✘ ${builder.loc}`);
  throw err;
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

      // const outDir = path.dirname(finalDestLoc);
      // const buildPipelineFile = new FileBuilder({
      //   fileURL: url.pathToFileURL(fileLoc),
      //   mountEntry,
      //   outDir,
      //   config,
      // });
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
  const buildResultManifest: SnowpackBuildResultFileManifest = {};
  for (const buildPipelineFile of allBuildPipelineFiles) {
    parallelWorkQueue.add(async () => {
      await buildPipelineFile.build();
      const buildResults = await buildPipelineFile.getAllResults(); //.catch((err) => handleFileError(err, buildPipelineFile)));
      for (const [buildUrl, buildResult] of Object.entries(buildResults)) {
        buildResultManifest[buildUrl] = {contents: buildResult, source: buildPipelineFile.loc};
      }
      // buildResultManifest = {...buildResultManifest, ...
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
  const allBuiltFiles = Object.entries(buildResultManifest).map(([k, v]) => {
    return {
      baseExt: path.extname(k),
      root: config.root,
      contents: v.contents,
      locOnDisk: path.join(buildDirectoryLoc, k),
    };
  });

  let installResult = await installDependencies(allBuiltFiles);

  logger.info(colors.yellow('! verifying build...'));

  // 3. Resolve all built file imports.
  const verifyStart = performance.now();
  for (const buildPipelineFile of allBuildPipelineFiles) {
    parallelWorkQueue.add(async () => {
      for (const buildUrl of buildPipelineFile.urls) {
        console.log(buildUrl, buildResultManifest[buildUrl].contents);
        buildResultManifest[buildUrl].contents = await buildPipelineFile.resolveImports(
          path.extname(buildUrl),
          buildResultManifest[buildUrl].contents,
          false,
          installResult.importMap!,
        );
        // .catch((err) => handleFileError(err, buildPipelineFile)),
      }
    });
  }
  await parallelWorkQueue.onIdle();
  const verifyEnd = performance.now();
  logger.info(
    `${colors.green('✔')} verification complete ${colors.dim(
      `[${((verifyEnd - verifyStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  // 4. Write files to disk.
  logger.info(colors.yellow('! writing build to disk...'));
  const allImportProxyFiles = new Set(
    allBuildPipelineFiles.map((b) => b.proxyImports).reduce((flat, item) => flat.concat(item), []),
    );
    console.log(allImportProxyFiles);
  for (const buildPipelineFile of allBuildPipelineFiles) {
    parallelWorkQueue.add(() =>
      buildPipelineFile.writeToDisk(buildDirectoryLoc, buildResultManifest),
    );
    for (const builtFile of buildPipelineFile.urls) {
      if (allImportProxyFiles.has(builtFile)) {
        parallelWorkQueue.add(async () => {
          const result = await buildPipelineFile.getProxy(builtFile, path.extname(builtFile));
          await mkdirp(path.dirname(path.join(buildDirectoryLoc, builtFile)));
          return fs.writeFile(path.join(buildDirectoryLoc, builtFile + '.proxy.js'), result, 'utf8');
          // .catch((err) => handleFileError(err, buildPipelineFile)),
        }
        );
      }
    }
  }
  await parallelWorkQueue.onIdle();

  // TODO(fks): Add support for virtual files (injected by snowpack, plugins)
  // and web_modules in this manifest.
  // buildResultManifest[path.join(internalFilesBuildLoc, 'env.js')] = {
  //   source: null,
  //   contents: generateEnvModule({mode: 'production', isSSR}),
  // };

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
    const [mountKey, mountEntry] = mountEntryResult;
    const finalUrl = getUrlsForFileMount({fileLoc, mountKey, mountEntry, config})![0];
    const finalDest = path.join(buildDirectoryLoc, finalUrl);
    const outDir = path.dirname(finalDest);
    const changedPipelineFile = new FileBuilder({
      fileURL: url.pathToFileURL(fileLoc),
      mountEntry,
      outDir,
      config,
    });
    buildPipelineFiles[fileLoc] = changedPipelineFile;
    // 1. Build the file.
    await changedPipelineFile.buildFile().catch((err) => {
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
    let resolveSuccess = await changedPipelineFile.resolveImports(installResult.importMap!);
    if (!resolveSuccess) {
      await installDependencies();
      resolveSuccess = await changedPipelineFile.resolveImports(installResult.importMap!);
      if (!resolveSuccess) {
        logger.error('Exiting...');
        process.exit(1);
      }
    }
    // 3. Write to disk. If any proxy imports are needed, write those as well.
    await changedPipelineFile.writeToDisk();
    const allBuildPipelineFiles = Object.values(buildPipelineFiles);
    const allImportProxyFiles = new Set(
      allBuildPipelineFiles
        .map((b) => b.filesToProxy)
        .reduce((flat, item) => flat.concat(item), []),
    );
    for (const builtFile of Object.keys(changedPipelineFile.output)) {
      if (allImportProxyFiles.has(builtFile)) {
        await changedPipelineFile.writeProxyToDisk(builtFile);
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
