import {promises as fs} from 'fs';
import glob from 'glob';
import * as colors from 'kleur/colors';
import mkdirp from 'mkdirp';
import path from 'path';
import {performance} from 'perf_hooks';
import {runPipelineCleanupStep, runPipelineOptimizeStep} from '../build/build-pipeline';
import {getUrlsForFile} from '../build/file-urls';
import {runBuiltInOptimize} from '../build/optimize';
import {logger} from '../logger';
import {installPackages} from '../sources/local-install';
import {getPackageSource} from '../sources/util';
import {CommandOptions, OnFileChangeCallback, SnowpackConfig} from '../types';
import {deleteFromBuildSafe} from '../util';
import {startServer} from './dev';

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
  installTargets: string[],
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
  // 2. Install dependencies, based on the scan of your final build.
  const installResult = await installPackages({
    config: commandOptions.config,
    isSSR: commandOptions.config.buildOptions.ssr,
    isDev: false,
    installTargets,
    installOptions,
  });
  return installResult;
}

// export async function build(commandOptions: CommandOptions): Promise<SnowpackBuildResult> {
const onWatchEvent: any = () => {}; // TODO: remove
export async function build(commandOptions: CommandOptions): Promise<any> {
  const {config} = commandOptions;
  const isDev = !!config.buildOptions.watch;
  const isSSR = !!config.buildOptions.ssr;
  const isHMR = getIsHmrEnabled(config);

  // Fill in any command-specific plugin methods.
  // NOTE: markChanged only needed during dev, but may not be true for all.
  if (isDev) {
    for (const p of config.plugins) {
      p.markChanged = (fileLoc) => onWatchEvent(fileLoc) || undefined;
    }
  }

  const buildDirectoryLoc = config.buildOptions.out;
  if (config.buildOptions.clean) {
    deleteFromBuildSafe(buildDirectoryLoc, config);
  }
  mkdirp.sync(buildDirectoryLoc);

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

  const allBareModuleSpecifiers = new Set<string>();
  const allFileUrlsUnique = new Set(allFileUrls);
  let allFileUrlsToProcess = [...allFileUrlsUnique];

  logger.info(colors.yellow('! building files...'));
  const buildStart = performance.now();
  while (allFileUrlsToProcess.length > 0) {
    const fileUrl = allFileUrlsToProcess.pop()!;
    const result = await devServer.loadUrl(fileUrl, {isSSR, isHMR, isResolve: false});
    for (const importedUrl of result.imports) {
      if (!importedUrl.startsWith('/')) {
        allBareModuleSpecifiers.add(importedUrl);
      } else if (!allFileUrlsUnique.has(importedUrl)) {
        allFileUrlsUnique.add(importedUrl);
        allFileUrlsToProcess.push(importedUrl);
      }
    }
  }
  console.log('allBareModuleSpecifiers', allBareModuleSpecifiers);
  const buildEnd = performance.now();
  logger.info(
    `${colors.green('✔')} build complete ${colors.dim(
      `[${((buildEnd - buildStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  logger.info(colors.yellow('! optimizing packages...'));
  const packagesStart = performance.now();
  const installDest = path.join(buildDirectoryLoc, config.buildOptions.metaUrlPath, 'pkg');
  const installResult = await installOptimizedDependencies(
    [...allBareModuleSpecifiers],
    installDest,
    commandOptions,
  );
  const packagesEnd = performance.now();
  logger.info(
    `${colors.green('✔')} packages optimized ${colors.dim(
      `[${((packagesEnd - packagesStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  logger.info(colors.yellow('! writing files...'));
  const writeStart = performance.now();
  allFileUrlsToProcess = [...allFileUrlsUnique];
  while (allFileUrlsToProcess.length > 0) {
    const fileUrl = allFileUrlsToProcess.pop()!;
    console.log('POP', fileUrl);
    if (fileUrl.startsWith(path.posix.join(config.buildOptions.metaUrlPath, 'pkg/'))) {
      continue;
    }
    const result = await devServer.loadUrl(fileUrl, {
      isSSR,
      isHMR,
      isResolve: true,
      importMap: installResult.importMap,
    });
    await mkdirp(path.dirname(path.join(buildDirectoryLoc, fileUrl)));
    await fs.writeFile(path.join(buildDirectoryLoc, fileUrl), result.contents);
    console.log('IMPORTS', result.imports);
    for (const importedUrl of result.imports) {
      if (!importedUrl.startsWith('/')) {
        allBareModuleSpecifiers.add(importedUrl);
        console.log('BARE', importedUrl);
      } else if (!allFileUrlsUnique.has(importedUrl)) {
        allFileUrlsUnique.add(importedUrl);
        allFileUrlsToProcess.push(importedUrl);
        console.log('PUSH', importedUrl);
      }
    }
  }
  const writeEnd = performance.now();
  logger.info(
    `${colors.green('✔')} write complete ${colors.dim(
      `[${((writeEnd - writeStart) / 1000).toFixed(2)}s]`,
    )}`,
  );

  // "--watch" mode - Start watching the file system.
  if (config.buildOptions.watch) {
    logger.info(
      `[HMR] WebSocket URL available at ${colors.cyan(
        `ws://localhost:${devServer.hmrEngine.port}`,
      )}`,
    );

    logger.info(colors.cyan('watching for changes...'));
    let onFileChangeCallback: OnFileChangeCallback = () => {};
    devServer.onFileChange(async ({filePath}) => {
      // First, do our own re-build logic
      allFileUrlsToProcess.push(...getUrlsForFile(filePath, config)!);
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
      // Then, call the user's onFileChange callback (if one provided)
      await onFileChangeCallback({filePath});
    });
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
