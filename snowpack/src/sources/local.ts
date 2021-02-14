import {buildFile} from '../build/build-pipeline';
import url from 'url';
import etag from 'etag';
import crypto from 'crypto';
import {install as esinstall, InstallTarget, resolveEntrypoint} from 'esinstall';
import projectCacheDir from 'find-cache-dir';
import {existsSync, promises as fs, readFileSync} from 'fs';
import PQueue from 'p-queue';
import path from 'path';
import rimraf from 'rimraf';
import util from 'util';
import type {Plugin as RollupPlugin} from 'rollup';
import {logger} from '../logger';
import {transformAddMissingDefaultExport, transformFileImports} from '../rewrite-imports';
import {getInstallTargets} from '../scan-imports';
import {CommandOptions, PackageSource, SnowpackConfig} from '../types';
import {GLOBAL_CACHE_DIR, isRemoteUrl} from '../util';

const PROJECT_CACHE_DIR =
  projectCacheDir({name: 'snowpack'}) ||
  // If `projectCacheDir()` is null, no node_modules directory exists.
  // Use the current path (hashed) to create a cache entry in the global cache instead.
  // Because this is specifically for dependencies, this fallback should rarely be used.
  path.join(GLOBAL_CACHE_DIR, crypto.createHash('md5').update(process.cwd()).digest('hex'));

const DEV_DEPENDENCIES_DIR = path.join(PROJECT_CACHE_DIR, process.env.NODE_ENV || 'development');

/**
 * Sanitizes npm packages that end in .js (e.g `tippy.js` -> `tippyjs`).
 * This is necessary because Snowpack can’t create both a file and directory
 * that end in .js.
 */
export function sanitizePackageName(filepath: string): string {
  const dirs = filepath.split('/');
  const file = dirs.pop() as string;
  return [...dirs.map((path) => path.replace(/\.js$/i, 'js')), file].join('/');
}

function getRootNodeModulesDirectory(loc: string) {
  const parts = loc.split('node_modules');
  parts.pop()!;
  const packageRoot = path.join(parts.join('node_modules'), 'node_modules');
  return packageRoot;
}
function getRootPackageDirectory(loc: string) {
  const parts = loc.split('node_modules');
  const packageParts = parts.pop()!.split('/').filter(Boolean);
  const packageRoot = path.join(parts.join('node_modules'), 'node_modules');
  if (packageParts[0].startsWith('@')) {
    return path.join(packageRoot, packageParts[0], packageParts[1]);
  } else {
    return path.join(packageRoot, packageParts[0]);
  }
}

// A bit of a hack: we keep this in local state and populate it
// during the "prepare" call. Useful so that we don't need to pass
// this implementation detail around outside of this interface.
// Can't add it to the exported interface due to TS.
let config: SnowpackConfig;

let installTargets: InstallTarget[] = [];
const allHashes: Record<string, string> = {};
const inProgress = new PQueue({concurrency: 1});
/**
 * Local Package Source: A generic interface through which Snowpack
 * interacts with esinstall and your locally installed dependencies.
 */
export default {
  async load(id: string, loadOptions): Promise<Buffer | string> {
    const PACKAGE_PATH_PREFIX = path.posix.join(config.buildOptions.metaUrlPath, 'pkg/');
    const idParts = id.split('/');
    let hash = idParts.shift()!;
    if (hash.startsWith('@')) {
      hash += '/' + idParts.shift()!;
    }
    const isLookup = idParts[0] !== '-';
    if (!isLookup) {
      idParts.shift();
    }
    const isRaw = hash.startsWith('raw:');
    if (isRaw) {
      hash = hash.replace('raw:', 'local:');
    }

    // const spec = idParts.join('/');
    // let packageName = idParts.shift()!;
    // if (packageName.startsWith('@')) {
    //   packageName += '/' + idParts.shift()!;
    // }
    // if (packageName.endsWith('.js') && !isLookup) {
    //   packageName = packageName.replace(/\.js$/, '');
    // }
    // const internalSpec = idParts.join('/');
    const rootPackageDirectory = allHashes[hash];
    console.log(hash, allHashes);
    // const rootPackageDirectory = path.join(rootNodeModulesDirectory, packageName);
    const entrypointPackageManifestLoc = path.join(rootPackageDirectory, 'package.json');
    const entrypointPackageManifestStr = await fs.readFile(entrypointPackageManifestLoc, 'utf8');
    const entrypointPackageManifest = JSON.parse(entrypointPackageManifestStr);
    const packageName = entrypointPackageManifest.name;

    const spec = idParts.join('/');
    const internalSpec = spec.replace(packageName + '/', '');
    console.log('A', spec, internalSpec);

    if (isRaw) {
      let installedPackageCode = await fs.readFile(
        path.join(rootPackageDirectory, internalSpec),
        'utf8',
      );
      return installedPackageCode;
    }
    const installDest = path.join(
      DEV_DEPENDENCIES_DIR,
      entrypointPackageManifest.name + '@' + entrypointPackageManifest.version,
    );
    let existsAndIsValid = existsSync(installDest);

    if (
      etag(entrypointPackageManifestStr) !==
      (await fs.readFile(path.join(installDest, '.meta'), 'utf-8').catch(() => null))
    ) {
      existsAndIsValid = false;
    }

    if (!isLookup) {
      await inProgress.onIdle();
      const dependencyFileLoc = path.join(installDest, spec);
      let installedPackageCode = await fs.readFile(dependencyFileLoc!, 'utf8');
      const allResolvedImports = new Set<string>();
      installedPackageCode = await transformAddMissingDefaultExport(installedPackageCode);
      installedPackageCode = await transformFileImports(
        {type: path.extname(dependencyFileLoc), contents: installedPackageCode},
        (spec) => {
          if (isRemoteUrl(spec)) {
            return spec;
          }
          if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
            return spec;
          }
          const resolvedSpecUrl = this.resolvePackageImport(
            entrypointPackageManifestLoc,
            spec,
            config,
          );
          if (!resolvedSpecUrl) {
            return spec;
          }
          allResolvedImports.add(resolvedSpecUrl.substr(PACKAGE_PATH_PREFIX.length));
          return resolvedSpecUrl;
        },
      );
      await Promise.all(
        [...allResolvedImports].map((resolvedSpec) => this.load(resolvedSpec, loadOptions)),
      );
      return installedPackageCode;
    }

    let finalLocation: string | undefined;
    const loadResponse = await inProgress.add(async () => {
      const importMap =
        existsSync(installDest) &&
        JSON.parse((await fs.readFile(path.join(installDest, 'import-map.json'), 'utf8'))!);

      if (importMap && importMap.imports[spec]) {
        finalLocation = path.posix.join(
          config.buildOptions.metaUrlPath,
          'pkg',
          hash,
          `-`,
          importMap.imports[spec],
        );
        return `export * from "${finalLocation}"; export {default} from "${finalLocation}";`;
      }

      const existingEntrypoints = importMap ? Object.keys(importMap.imports) : [];
      let installEntrypoints = Array.from(
        new Set([
          ...existingEntrypoints,
          spec,
          ...installTargets
            .map((t) => t.specifier)
            .filter((t) => t === packageName || t.startsWith(packageName + '/')),
        ]),
      );
      console.log(`Installing ${spec}...`);
      // TODO: external should be a function in esinstall
      const external = [
        ...Object.keys(entrypointPackageManifest.dependencies || {}),
        ...Object.keys(entrypointPackageManifest.devDependencies || {}),
        ...Object.keys(entrypointPackageManifest.peerDependencies || {}),
      ];

      const finalResult = await esinstall(installEntrypoints, {
        dest: installDest,
        env: {NODE_ENV: process.env.NODE_ENV || 'development'},
        treeshake: false,
        cwd: entrypointPackageManifestLoc,
        external,
        externalEsm: external,
        logger: {
          debug: (...args: [any, ...any[]]) => logger.debug(util.format(...args)),
          log: (...args: [any, ...any[]]) => logger.info(util.format(...args)),
          warn: (...args: [any, ...any[]]) => logger.warn(util.format(...args)),
          error: (...args: [any, ...any[]]) => logger.error(util.format(...args)),
        },
        packageExportLookupFields: ['svelte'],
        packageLookupFields: ['svelte'],
        rollup: {
          plugins: [
            {
              name: 'esinstall:snowpack',
              resolveId(source: string, importer: string | undefined) {
                // console.log('resolveId', source, importer);
                return source;
              },
              async load(id: string) {
                // console.log('load', id);
                const output = await buildFile(url.pathToFileURL(id), {
                  config,
                  isDev: true,
                  isSSR: false,
                  isHmrEnabled: false,
                });
                let jsResponse;
                // console.log(output);
                for (const [outputType, outputContents] of Object.entries(output)) {
                  if (jsResponse) {
                    console.log(`load() Err: ${Object.keys(output)}`);
                  }
                  if (!jsResponse || outputType === '.js') {
                    jsResponse = outputContents;
                  }
                }
                return jsResponse;
              },
            } as RollupPlugin,
          ],
        },
      });
      await fs.writeFile(
        path.join(installDest, '.meta'),
        etag(entrypointPackageManifestStr),
        'utf8',
      );
      console.log(`Installing ${spec}... DONE`);

      finalLocation = path.posix.join(
        config.buildOptions.metaUrlPath,
        'pkg',
        hash,
        `-`,
        finalResult.importMap.imports[spec],
      );
      return `export * from "${finalLocation}"; export {default} from "${finalLocation}";`;
    });
    if (finalLocation) {
      await this.load(finalLocation.substr(PACKAGE_PATH_PREFIX.length), loadOptions);
    }
    return loadResponse;
  },

  modifyBuildInstallOptions({installOptions, config}) {
    if (config.packageOptions.source !== 'local') {
      return installOptions;
    }
    installOptions.cwd = config.root;
    installOptions.rollup = config.packageOptions.rollup;
    installOptions.sourcemap = config.buildOptions.sourcemap;
    installOptions.polyfillNode = config.packageOptions.polyfillNode;
    installOptions.packageLookupFields = config.packageOptions.packageLookupFields;
    installOptions.packageExportLookupFields = config.packageOptions.packageExportLookupFields;
    return installOptions;
  },

  async prepare(commandOptions: CommandOptions) {
    config = commandOptions.config;

    const installDirectoryHashLoc = path.join(DEV_DEPENDENCIES_DIR, '.meta');
    const installDirectoryHash = await fs
      .readFile(installDirectoryHashLoc, 'utf-8')
      .catch(() => null);
    if (installDirectoryHash === 'v1') {
      logger.info('Welcome back!');
      return;
    }
    if (installDirectoryHash) {
      logger.info('Welcome back! Updating your dependencies to the latest version of Snowpack...');
    } else {
      logger.info(
        'Welcome to Snowpack! Since this is your first run in this project, we will go ahead and set up your dependencies. This may take a second...',
      );
    }
    const PACKAGE_PATH_PREFIX = path.posix.join(config.buildOptions.metaUrlPath, 'pkg/');
    const installTargets = await getInstallTargets(
      config,
      config.packageOptions.source === 'local' ? config.packageOptions.knownEntrypoints : [],
    );
    if (installTargets.length === 0) {
      logger.info('Nothing to install.');
      return;
    }
    const allResolvedImports: string[] = [...new Set(installTargets.map((t) => t.specifier))]
      .map((spec) =>
        this.resolvePackageImport(path.join(config.root, 'package.json'), spec, config),
      )
      .filter((v): v is string => typeof v === 'string');
    await Promise.all(
      allResolvedImports.map((resolvedSpecUrl) => {
        return this.load(resolvedSpecUrl.substr(PACKAGE_PATH_PREFIX.length), commandOptions);
      }),
    );
    await fs.writeFile(installDirectoryHashLoc, 'v1', 'utf-8');
    logger.info('Set up complete!');
    return;

    //  2. Install dependencies, based on the scan of your final build.
    // const installResult = await installRunner({
    //   config,
    //   installTargets,
    //   installOptions,
    //   shouldPrintStats: false,
    // });
    //  await updateLockfileHash(DEV_DEPENDENCIES_DIR);
    //  return installResult;
    //     installTargets = await getInstallTargets(config, []);
    // const {config} = commandOptions;
    // Set the proper install options, in case an install is needed.
    // logger.debug(`Using cache folder: ${path.relative(config.root, DEV_DEPENDENCIES_DIR)}`);
    // installOptions = merge(commandOptions.config.packageOptions as PackageSourceLocal, {
    //   dest: DEV_DEPENDENCIES_DIR,
    //   env: {NODE_ENV: process.env.NODE_ENV || 'development'},
    //   treeshake: false,
    // });
    // Start with a fresh install of your dependencies, if needed.
    // const dependencyImportMapLoc = path.join(DEV_DEPENDENCIES_DIR, 'import-map.json');
    // let dependencyImportMap = {imports: {}};
    // try {
    //   dependencyImportMap = JSON.parse(
    //     await fs.readFile(dependencyImportMapLoc, {encoding: 'utf8'}),
    //   );
    // } catch (err) {
    //   // no import-map found, safe to ignore
    // }
    // if (!(await checkLockfileHash(DEV_DEPENDENCIES_DIR)) || !existsSync(dependencyImportMapLoc)) {
    //   logger.debug('Cache out of date or missing. Updating...');
    //   // const installResult = await installDependencies(config);
    //   // dependencyImportMap = installResult?.importMap || {imports: {}};
    // } else {
    //   logger.debug(`Cache up-to-date. Using existing cache`);
    // }
  },

  // TODO: Make async, and then clean all of this up
  async resolvePackageImport(source: string, spec: string, config: SnowpackConfig) {
    const entrypoint = resolveEntrypoint(spec, {
      cwd: path.dirname(source),
      packageLookupFields: ['svelte'],
    });
    const rootPackageDirectory = getRootPackageDirectory(entrypoint);
    const rootNodeModulesDirectory = getRootNodeModulesDirectory(entrypoint);
    console.log(entrypoint, rootPackageDirectory, rootNodeModulesDirectory);
    const entrypointPackageManifestLoc = path.join(rootPackageDirectory, 'package.json');
    const entrypointPackageManifest = JSON.parse(
      readFileSync(entrypointPackageManifestLoc!, 'utf8'),
    );
    const {name: packageName, version: packageVersion} = entrypointPackageManifest;
    const hash = packageName + '@' + packageVersion;
    allHashes[hash] = allHashes[hash] || rootPackageDirectory;

    // const hash =
    //   'local' +
    //   ':' +
    //   crypto.createHash('md5').update(rootNodeModulesDirectory).digest('hex').substr(0, 16);
    // allHashes[hash] = rootNodeModulesDirectory;

    // const installDest = path.join(
    //   DEV_DEPENDENCIES_DIR,
    //   entrypointPackageManifest.name + '@' + entrypointPackageManifest.version,
    // );
    // const importMap =
    //   existsSync(installDest) &&
    //   JSON.parse(readFileSync(path.join(installDest, 'import-map.json'), 'utf8')!);
    // console.log('AAA', importMap, spec);
    // if (importMap && importMap.imports[spec]) {
    //   return path.posix.join(
    //     config.buildOptions.metaUrlPath,
    //     'pkg',
    //     hash,
    //     '-',
    //     importMap.imports[spec],
    //   );
    // }

    // if (spec === 'svelte' || spec.startsWith('svelte/')) {
    //   return path.posix.join(
    //     config.buildOptions.metaUrlPath,
    //     'pkg',
    //     hash.replace('local:', 'raw:'),
    //     entrypoint.replace(rootPackageDirectory, 'svelte'),
    //   );
    // }
    // if (spec === 'svelte-awesome' || spec.startsWith('svelte-awesome/')) {
    //   return path.posix.join(
    //     config.buildOptions.metaUrlPath,
    //     'pkg',
    //     hash.replace('local:', 'raw:'),
    //     entrypoint.replace(rootPackageDirectory, 'svelte-awesome'),
    //   );
    // }

    console.log(allHashes);
    return path.posix.join(config.buildOptions.metaUrlPath, 'pkg', hash, spec);
  },

  // async recoverMissingPackageImport(_, config): Promise<ImportMap> {
  //   logger.info(colors.yellow('Dependency cache out of date. Updating...'));
  //   const installResult = await installDependencies(config);
  //   const dependencyImportMap = installResult!.importMap;
  //   return dependencyImportMap;
  // },

  clearCache() {
    return rimraf.sync(PROJECT_CACHE_DIR);
  },

  getCacheFolder() {
    return PROJECT_CACHE_DIR;
  },
} as PackageSource;
