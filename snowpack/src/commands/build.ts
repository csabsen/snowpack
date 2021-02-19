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
import {getMountEntryForFile, getUrlsForFile, getUrlsForFileMount} from '../build/file-urls';
import {runBuiltInOptimize} from '../build/optimize';
import {EsmHmrEngine} from '../hmr-server-engine';
import {logger} from '../logger';
import {getInstallTargets} from '../scan-imports';
import {installPackages} from '../sources/local-install';
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
import {startServer} from './dev';

const CONCURRENT_WORKERS = require('os').cpus().length;

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

  // start
  const installStart = performance.now();
  logger.info(colors.yellow('! building dependencies...'));
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
  const installResult = await installPackages({
    config: commandOptions.config,
    isSSR: commandOptions.config.buildOptions.ssr,
    isDev: false,
    installTargets,
    installOptions,
  });
  // finish
  const installEnd = performance.now();
  logger.info(
    `${colors.green(`✔`) + ' dependencies ready!'} ${colors.dim(
      `[${((installEnd - installStart) / 1000).toFixed(2)}s]`,
    )}`,
  );
  return installResult;
}

// export async function build(commandOptions: CommandOptions): Promise<SnowpackBuildResult> {
const onWatchEvent: any = () => {}; // TODO: remove
export async function build(commandOptions: CommandOptions): Promise<any> {
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
  // const internalFilesBuildLoc = path.join(buildDirectoryLoc, config.buildOptions.metaUrlPath);
  if (config.buildOptions.clean) {
    deleteFromBuildSafe(buildDirectoryLoc, config);
  }
  mkdirp.sync(buildDirectoryLoc);
  // mkdirp.sync(internalFilesBuildLoc);

  // NEW BUILD:
  // √ run pkgsource.prepare()
  // start up the dev server (or, start up a workflow just like dev)
  // start hitting it with requests (one for every source file)
  // collect all imports (if proxy, add it to the build)

  const devServer = await startServer(commandOptions);
  console.log('ONWARD!');

  const allFileUrls: string[] = [];
  for (const [mountKey, mountEntry] of Object.entries(config.mount)) {
    logger.debug(`Mounting directory: '${mountKey}' as URL '${mountEntry.url}'`);
    const files = glob.sync(path.join(mountKey, '**'), {
      nodir: true,
      ignore: [...config.exclude, ...config.testOptions.files],
    });
    for (const f of files) {
      const fileUrls = getUrlsForFile(f, config)!;
      allFileUrls.push(...fileUrls);
    }
  }

  const allFileUrlsUnique = new Set(allFileUrls);
  const allFileUrlsToProcess = [...allFileUrlsUnique];

  logger.info(colors.yellow('! building files...'));
  const buildStart = performance.now();
  while (allFileUrlsToProcess.length > 0) {
    const fileUrl = allFileUrlsToProcess.pop()!;
    console.log('POP', fileUrl);
    const result = await devServer.loadUrl(fileUrl, {isSSR});
    await mkdirp(path.dirname(path.join(buildDirectoryLoc, fileUrl)));
    await fs.writeFile(path.join(buildDirectoryLoc, fileUrl), result.contents);
    console.log('IMPORTS', result.imports);
    for (const importedUrl of result.imports) {
      if (!allFileUrlsUnique.has(importedUrl)) {
        allFileUrlsUnique.add(importedUrl);
        allFileUrlsToProcess.push(importedUrl);
        console.log('PUSH', importedUrl);
      }
    }
  }

  const buildEnd = performance.now();
  logger.info(
    `${colors.green('✔')} build complete ${colors.dim(
      `[${((buildEnd - buildStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  // TODO: send isDev as an argument to startDevServer, use for runPlugin.run
  // TODO: dev server needs a "don't resolve proxy" mode for imports when optimize = true
  // TODO: tree-shaking mode for dependencies?
  // TODO: do we still want to recreate buildResultManifest ? maybe just for source -> URL?
    // const buildResultManifest: SnowpackBuildResultFileManifest = {};


  // /** Install all needed dependencies, based on the master buildPipelineFiles list.  */
  // async function installDependencies(scannedFiles: SnowpackSourceFile[]) {
  //   const installDest = path.join(buildDirectoryLoc, config.buildOptions.metaUrlPath, 'pkg');
  //   const installResult = await installOptimizedDependencies(
  //     scannedFiles,
  //     installDest,
  //     commandOptions,
  //   );
  //   const allFiles = glob.sync(`**/*`, {
  //     cwd: installDest,
  //     absolute: true,
  //     nodir: true,
  //     dot: true,
  //     follow: true,
  //   });

  //   if (!config.optimize?.bundle) {
  //     for (const installedFileLoc of allFiles) {
  //       if (
  //         !installedFileLoc.endsWith('import-map.json') &&
  //         path.extname(installedFileLoc) !== '.js'
  //       ) {
  //         const proxiedCode = await readFile(url.pathToFileURL(installedFileLoc));
  //         const importProxyFileLoc = installedFileLoc + '.proxy.js';
  //         const proxiedUrl = installedFileLoc.substr(buildDirectoryLoc.length).replace(/\\/g, '/');
  //         const proxyCode = await wrapImportProxy({
  //           url: proxiedUrl,
  //           code: proxiedCode,
  //           hmr: false,
  //           config: config,
  //         });
  //         await fs.writeFile(importProxyFileLoc, proxyCode, 'utf8');
  //       }
  //     }
  //   }
  //   return installResult;
  // }

  // "--watch" mode - Start watching the file system.
  if (config.buildOptions.watch) {
    logger.info(
      `[HMR] WebSocket URL available at ${colors.cyan(
        `ws://localhost:${devServer.hmrEngine.port}`,
      )}`,
    );

    devServer.onFileChange(async ({filePath}) => {
      allFileUrlsToProcess.push(...getUrlsForFile(filePath, config)!);
      // const allFileUrlsUnique = new Set(allFileUrls);
      // const allFileUrlsToProcess = [...allFileUrlsUnique];
      // logger.info(colors.yellow('! building files...'));
      while (allFileUrlsToProcess.length > 0) {
        const fileUrl = allFileUrlsToProcess.pop()!;
        console.log('POP', fileUrl);
        const result = await devServer.loadUrl(fileUrl, {isSSR});
        await mkdirp(path.dirname(path.join(buildDirectoryLoc, fileUrl)));
        await fs.writeFile(path.join(buildDirectoryLoc, fileUrl), result.contents);
        console.log('IMPORTS', result.imports);
        for (const importedUrl of result.imports) {
          if (!allFileUrlsUnique.has(importedUrl)) {
            allFileUrlsUnique.add(importedUrl);
            allFileUrlsToProcess.push(importedUrl);
            console.log('PUSH', importedUrl);
          }
        }
      }
    });
    logger.info(colors.cyan('watching for changes...'));
    let onFileChangeCallback: OnFileChangeCallback = () => {};

    return {
      onFileChange: (callback) => (onFileChangeCallback = callback),
      shutdown() {
        return devServer.shutdown();
      },
    };
  }

  // "--optimize" mode - Optimize the build.
  if (config.optimize || config.plugins.some((p) => p.optimize)) {
    const optimizeStart = performance.now();
    logger.info(colors.yellow('! optimizing build...'));
    await runBuiltInOptimize(config);
    await runPipelineOptimizeStep(buildDirectoryLoc, {config});
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
  await devServer.shutdown();
  return {
    onFileChange: () => {
      throw new Error('build().onFileChange() only supported in "watch" mode.');
    },
    shutdown: () => {
      throw new Error('build().shutdown() only supported in "watch" mode.');
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
